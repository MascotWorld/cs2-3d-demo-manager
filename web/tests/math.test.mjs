import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cs2ToThree,
  cs2LookDirThree,
  playerEyePosThree,
  playerBodyHeight,
  lerpAngleDeg,
  findFrameIndex,
  activeFlagStart,
  cycleAliveSlot,
  matchFinalByCurrentSides,
  roundAtTick,
  interpolateFrames,
  smokeEnvelope,
  parseCsmsh1,
  formatClock,
  povCameraFov,
  cs2FovToVertical,
  roundTeamsBySlot,
  VIEWMODEL_FOV,
  weaponCategory,
  weaponNameToModelKey,
  grenadeTypeToModelKey,
  unpackUtilityCounts,
  computeRoundClock,
  deoverlapScreenTags,
  detectGlbTransform,
  worldToOverviewRadar,
  QUALITY_PRESETS,
  nextDowngradedQuality,
  computePlayerSpeed,
  resolveMoveDirection,
  resolveOperatorClipNames,
  findNextAliveTeammate,
} from '../src/viewer/math.js';

test('cs2ToThree maps (x, y, z) -> (x, z, -y)', () => {
  assert.deepEqual(cs2ToThree(100, 250, -40), [100, -40, -250]);
});

test('cs2LookDirThree handles cardinal yaw and pitch angles', () => {
  const east = cs2LookDirThree(0, 0);
  assert.ok(Math.abs(east[0] - 1) < 1e-6);
  assert.ok(Math.abs(east[1]) < 1e-6);
  assert.ok(Math.abs(east[2]) < 1e-6);

  const north = cs2LookDirThree(90, 0);
  assert.ok(Math.abs(north[0]) < 1e-6);
  assert.ok(Math.abs(north[1]) < 1e-6);
  assert.ok(Math.abs(north[2] + 1) < 1e-6);

  const lookDown = cs2LookDirThree(0, 45);
  assert.ok(lookDown[1] < -0.7);
  const lookUp = cs2LookDirThree(0, -45);
  assert.ok(lookUp[1] > 0.7);
});

test('playerEyePosThree and playerBodyHeight scale with duck amount', () => {
  const standEye = playerEyePosThree(10, 20, 30, 0);
  assert.deepEqual(standEye, [10, 94, -20]);
  assert.equal(playerBodyHeight(0), 72);

  const crouchEye = playerEyePosThree(10, 20, 30, 1);
  assert.ok(crouchEye[1] < standEye[1]);
  assert.ok(Math.abs(crouchEye[1] - (30 + 46)) < 1e-6);
  const halfCrouchEye = playerEyePosThree(10, 20, 30, 0.5);
  assert.ok(Math.abs(halfCrouchEye[1] - (30 + 55)) < 1e-6);
  assert.ok(playerBodyHeight(1) < 72);
});

test('lerpAngleDeg takes shortest path across 0/360 seam', () => {
  const cw = lerpAngleDeg(350, 10, 0.5);
  assert.ok(Math.abs(((cw % 360) + 360) % 360 - 0) < 1e-6);

  const ccw = lerpAngleDeg(10, 350, 0.5);
  assert.ok(Math.abs(((ccw % 360) + 360) % 360 - 0) < 1e-6);
});

test('findFrameIndex and interpolateFrames interpolate smoothly and guard teleports', () => {
  const frames = [
    {
      t: 100,
      p: [
        [1, 3, 0, 0, 0, 350, 0, 100, 100, 0, 0, 0, 0, 0, 0],
        [1, 2, 100, 100, 0, 90, 0, 100, 100, 0, 0, 0.2, 50, 1, 0],
      ],
      b: [10, 20, 30, -1, 2],
    },
    {
      t: 110,
      p: [
        [1, 3, 100, 0, 0, 10, 10, 100, 100, 1, 0, 0.8, 200, 0, 0],
        // >150 units teleport should not interpolate
        [1, 2, 1000, 100, 0, 90, 0, 100, 100, 0, 0, 0.2, 50, 1, 0],
      ],
      b: [30, 20, 30, -1, 2],
    },
  ];

  assert.equal(findFrameIndex(frames, 90), 0);
  assert.equal(findFrameIndex(frames, 105), 0);
  assert.equal(findFrameIndex(frames, 120), 1);

  const mid = interpolateFrames(frames, 105);
  assert.equal(mid.players[0][2], 50);
  assert.equal(mid.players[0][6], 5);
  assert.equal(mid.players[0][9], 0.5);
  assert.ok(Math.abs(mid.players[0][11] - 0.4) < 1e-6);
  // Teleporting player keeps frame A pos
  assert.equal(mid.players[1][2], 100);
  // Bomb interpolates when state matches
  assert.equal(mid.bomb[0], 20);
});

test('smokeEnvelope grows, holds, and fades within active tick range', () => {
  const smoke = { start_tick: 100, end_tick: 1252, position: [0, 0, 0] };
  assert.equal(smokeEnvelope(smoke, 99, 64).active, false);
  assert.equal(smokeEnvelope(smoke, 1253, 64).active, false);

  const early = smokeEnvelope(smoke, 105, 64);
  const mid = smokeEnvelope(smoke, 600, 64);
  const late = smokeEnvelope(smoke, 1245, 64);
  assert.equal(early.active, true);
  assert.ok(early.scale < mid.scale);
  assert.ok(mid.opacity > early.opacity);
  assert.ok(mid.opacity > late.opacity);
  assert.equal(smokeEnvelope({ ...smoke, end_tick: 0 }, 1253, 64).active, false);
  assert.equal(smokeEnvelope({ ...smoke, end_tick: 1512 }, 1400, 64).opacity, mid.opacity);
});

test('parseCsmsh1 parses header, transforms vertices, and validates bounds', () => {
  const buf = new ArrayBuffer(34 + 36);
  const bytes = new Uint8Array(buf);
  const magic = 'CSMSH1';
  for (let i = 0; i < 6; i++) bytes[i] = magic.charCodeAt(i);
  const dv = new DataView(buf);
  // cs2Min = (-10, -20, 0), cs2Max = (10, 20, 30)
  dv.setFloat32(6, -10, true);
  dv.setFloat32(10, -20, true);
  dv.setFloat32(14, 0, true);
  dv.setFloat32(18, 10, true);
  dv.setFloat32(22, 20, true);
  dv.setFloat32(26, 30, true);
  dv.setUint32(30, 1, true);
  // Triangle vertices in CS2 space
  const verts = [-10, -20, 0, 10, -20, 0, 0, 20, 30];
  verts.forEach((v, idx) => dv.setFloat32(34 + idx * 4, v, true));

  const parsed = parseCsmsh1(buf);
  assert.equal(parsed.triCount, 1);
  assert.deepEqual(Array.from(parsed.positions), [-10, 0, 20, 10, 0, 20, 0, 30, -20]);
  assert.deepEqual(parsed.minThree, [-10, 0, -20]);
  assert.deepEqual(parsed.maxThree, [10, 30, 20]);

  assert.throws(() => parseCsmsh1(new ArrayBuffer(10)), /too small/);
});

test('formatClock formats minutes and seconds', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65.9), '1:05');
  assert.equal(formatClock(-5), '0:00');
});

test('povCameraFov, weaponCategory, and unpackUtilityCounts cover CS2 weapons and utility', () => {
  assert.equal(povCameraFov('AK-47', 0), 90);
  assert.equal(povCameraFov('AWP', 1), 40);
  assert.equal(povCameraFov('AWP', 2), 15);
  assert.equal(povCameraFov('AUG', 1), 45);
  assert.equal(weaponCategory('AWP'), 'sniper');
  assert.equal(weaponCategory('USP-S'), 'pistol');
  assert.equal(weaponCategory('Butterfly Knife'), 'knife');
  assert.equal(weaponCategory('C4 Explosive'), 'c4');
  assert.equal(weaponCategory('Smoke Grenade'), 'grenade');

  const util = unpackUtilityCounts(102121); // 1 smoke, 2 flashes, 1 he, 2 mollies, 0 decoy, 1 c4
  assert.deepEqual(util, { smoke: 1, flash: 2, he: 1, molly: 2, decoy: 0, c4: 1 });
});

test('CS2 FOV uses a 4:3 reference rather than Three.js vertical degrees', () => {
  for (const fov of [90, VIEWMODEL_FOV, povCameraFov('AWP', 1), povCameraFov('AWP', 2)]) {
    const vertical = cs2FovToVertical(fov) * Math.PI / 180;
    const atFourByThree = 2 * Math.atan(Math.tan(vertical / 2) * 4 / 3) * 180 / Math.PI;
    assert.ok(Math.abs(atFourByThree - fov) < 1e-10);
  }
  const wideFov = 2 * Math.atan(Math.tan(cs2FovToVertical(90) * Math.PI / 360) * 16 / 9) * 180 / Math.PI;
  assert.ok(wideFov > 106 && wideFov < 107);
});

test('round operator sides ignore inactive roster fallback and follow halftime switches', () => {
  const firstHalf = [{ p: [[0, 2], [1, 2]] }, { p: [[1, 3], [1, 2]] }];
  const secondHalf = [{ p: [[0, 3], [1, 3]] }, { p: [[1, 2], [1, 3]] }];
  assert.deepEqual([...roundTeamsBySlot(firstHalf)].sort(), [[0, 3], [1, 2]]);
  assert.deepEqual([...roundTeamsBySlot(secondHalf)].sort(), [[0, 2], [1, 3]]);
});

test('weaponNameToModelKey and grenadeTypeToModelKey resolve all CS2 equipment to real GLB keys', () => {
  assert.equal(weaponNameToModelKey('AK-47', 2), 'ak47');
  assert.equal(weaponNameToModelKey('M4A1', 3), 'm4a1_silencer');
  assert.equal(weaponNameToModelKey('M4A4', 3), 'm4a4');
  assert.equal(weaponNameToModelKey('AWP', 3), 'awp');
  assert.equal(weaponNameToModelKey('USP-S', 3), 'usp_silencer');
  assert.equal(weaponNameToModelKey('Desert Eagle', 2), 'deagle');
  assert.equal(weaponNameToModelKey('Glock-18', 2), 'glock18');
  assert.equal(weaponNameToModelKey('Knife', 3), 'knife_ct');
  assert.equal(weaponNameToModelKey('Knife', 2), 'knife_t');
  assert.equal(weaponNameToModelKey('C4', 2), 'c4');
  assert.equal(weaponNameToModelKey('Smoke Grenade', 3), 'smokegrenade');
  assert.equal(grenadeTypeToModelKey('flash'), 'flashbang');
  assert.equal(grenadeTypeToModelKey('he'), 'hegrenade');
  assert.equal(grenadeTypeToModelKey('molotov'), 'molotov');
});

test('computeRoundClock handles freeze, live 1:55, plant/defuse bars, and 40s C4 timer', () => {
  const rr = {
    tick_rate: 64,
    summary: { start_tick: 100, freeze_end_tick: 1060, round_time_sec: 115, freeze_time_sec: 15, bomb_time_sec: 40 },
    bomb_events: [
      { tick: 2000, type: 'plant_begin', player_slot: 5, duration_sec: 3.2 },
      { tick: 2205, type: 'planted', player_slot: 5, site: 'A', duration_sec: 40 },
      { tick: 3000, type: 'defuse_begin', player_slot: 0, has_kit: true, duration_sec: 5 },
    ],
  };
  const freeze = computeRoundClock(rr, 500, 64);
  assert.equal(freeze.phase, 'freeze');
  const live = computeRoundClock(rr, 1060, 64);
  assert.equal(live.phase, 'live');
  assert.equal(live.clockText, '1:55');
  const planting = computeRoundClock(rr, 2102, 64);
  assert.equal(planting.action.type, 'planting');
  assert.ok(planting.action.progress > 0.45 && planting.action.progress < 0.55);
  const defusing = computeRoundClock(rr, 3160, 64);
  assert.equal(defusing.phase, 'planted');
  assert.equal(defusing.action.type, 'defusing');
  assert.equal(defusing.action.hasKit, true);
  assert.ok(Math.abs(defusing.action.progress - 0.5) < 0.05);
});

test('deoverlapScreenTags separates 5 clustered spawn tags and clamps inside safe HUD bounds', () => {
  const res = deoverlapScreenTags(
    [
      { id: 0, sx: 100, sy: 300 }, // inside left HUD -> clamped >= 325
      { id: 1, sx: 400, sy: 300 },
      { id: 2, sx: 405, sy: 301 },
      { id: 3, sx: 402, sy: 302 },
      { id: 4, sx: 404, sy: 303 },
      { id: 5, sx: 401, sy: 304 },
    ],
    24,
    116,
    168,
    { minX: 325, maxX: 1060, minY: 84, maxY: 640 }
  );
  for (const tag of res) {
    assert.ok(tag.sx >= 325 && tag.sx <= 1060, `sx out of bounds: ${tag.sx}`);
    assert.ok(tag.sy >= 84 && tag.sy <= 640, `sy out of bounds: ${tag.sy}`);
  }
  for (let i = 0; i < res.length; i++) {
    for (let j = i + 1; j < res.length; j++) {
      const dx = Math.abs(res[i].sx - res[j].sx);
      const dy = Math.abs(res[i].sy - res[j].sy);
      assert.ok(dx >= 116 || dy >= 24, `tags ${i} and ${j} overlap: dx=${dx}, dy=${dy}`);
    }
  }
});

test('match seeks and alive spectator cycling preserve stable player slots', () => {
  const rounds = [{start_tick: 65, round_number: 1}, {start_tick: 1280, round_number: 2}];
  assert.equal(roundAtTick(rounds, 0).round_number, 1);
  assert.equal(roundAtTick(rounds, 1279).round_number, 1);
  assert.equal(roundAtTick(rounds, 1280).round_number, 2);
  assert.equal(roundAtTick([], 1280), null);
  const players = [[1], [0], null, [1], [0]];
  assert.equal(cycleAliveSlot(players, 0, 1), 3);
  assert.equal(cycleAliveSlot(players, 0, -1), 3);
  assert.equal(cycleAliveSlot(players, 3, 1), 0);
  assert.equal(cycleAliveSlot([[0], null], 0, 1), -1);
  assert.deepEqual(matchFinalByCurrentSides([{slot: 0, team: 2}, {slot: 1, team: 3}], new Map([[0, 3], [1, 2]]), 13, 9), {ct: 9, t: 13});
});

test('clock infers POV bomb actions, distinct timeout spans, and round-over state', () => {
  const player = (flag, weapon = 0) => {
    const p = Array(15).fill(0);
    p[0] = 1;
    p[13] = weapon;
    p[14] = flag;
    return p;
  };
  const rr = {
    summary: {start_tick: 64, freeze_end_tick: 64 * 46, winner_team: 3, end_tick: 64 * 76},
    pauses: [{tick: 64 * 6, kind: 'timeout', team: 3, seconds_left: 30}, {tick: 64 * 36, kind: ''}],
    frames: [
      {t: 64 * 47, p: [player(0), player(0)]},
      {t: 64 * 48, p: [player(16), player(0)]},
      {t: 64 * 49, p: [player(16), player(0)]},
      {t: 64 * 52, b: [0, 0, 0, -1, 3], p: [player(0), player(0)]},
      {t: 64 * 55, b: [0, 0, 0, -1, 3], p: [player(0), player(8 | 2)]},
      {t: 64 * 56, b: [0, 0, 0, -1, 3], p: [player(0), player(8 | 2)]},
      {t: 64 * 68, p: [player(32), null]},
      {t: 64 * 69, p: [player(32, 1), null]},
    ],
  };
  assert.equal(computeRoundClock(rr, 64 * 2).clockText, '0:14');
  assert.equal(computeRoundClock(rr, 64 * 16).clockText, '0:20');
  assert.equal(computeRoundClock(rr, 64 * 16).team, 3);
  assert.equal(computeRoundClock(rr, 64 * 40).clockText, '0:06');
  assert.equal(computeRoundClock(rr, 64 * 49).action.startTick, 64 * 48);
  const defuse = computeRoundClock(rr, 64 * 56);
  assert.equal(defuse.phase, 'planted');
  assert.equal(defuse.action.type, 'defusing');
  assert.equal(defuse.action.secondsLeft, 4);
  assert.equal(computeRoundClock(rr, 64 * 76).phase, 'round_over');
  assert.equal(activeFlagStart(rr.frames, 64 * 69, 0, 32, 1), 64 * 69);
  assert.equal(activeFlagStart(rr.frames, 64 * 69, 0, 32, 0), null);
});

test('worldToOverviewRadar maps de_nuke coordinates accurately', () => {
  const pt = worldToOverviewRadar(648, -1256, 184, { pos_x: -3453, pos_y: 2887, scale: 7.0 });
  assert.ok(pt && Math.abs(pt[0] - 105.3) < 1 && Math.abs(pt[1] - 106.4) < 1);
});

test('detectGlbTransform aligns Source 2 meters de_nuke.glb inside CSGEO1 bounds', () => {
  const t = detectGlbTransform(
    [-68.942, -27.229, -35.154],
    [13.760, 10.160, 49.987],
    [-6120, -1224, -2165.7],
    [6536, 824, 5666.3]
  );
  assert.equal(t.name, 'ry+90');
  assert.ok(Math.abs(t.scale - 1 / 0.0254) < 0.01);
});

test('QUALITY_PRESETS and nextDowngradedQuality cover High -> Medium -> Low ladder', () => {
  assert.equal(QUALITY_PRESETS.high.shadowMapSize, 2048);
  assert.equal(QUALITY_PRESETS.high.pixelRatioCap, 1.5);
  assert.equal(QUALITY_PRESETS.medium.shadowMapSize, 512);
  assert.equal(QUALITY_PRESETS.low.shadowsEnabled, false);
  assert.equal(QUALITY_PRESETS.low.aoEnabled, false);
  assert.equal(nextDowngradedQuality('high'), 'medium');
  assert.equal(nextDowngradedQuality('medium'), 'low');
  assert.equal(nextDowngradedQuality('low'), null);
});

test('computePlayerSpeed derives horizontal speed, XY velocity, and vertical velocity from surrounding frames', () => {
  const frames = [
    { t: 100, p: [[1, 3, 0, 0, 0, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0]] },
    { t: 108, p: [[1, 3, 25, 0, 8, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0]] },
    { t: 116, p: [[1, 3, 50, 0, 16, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0]] },
  ];
  const res = computePlayerSpeed(frames, 0, 108, 64);
  assert.ok(Math.abs(res.speed - 200) < 1e-3, `Expected 200 u/s, got ${res.speed}`);
  assert.ok(Math.abs(res.vx - 200) < 1e-3, `Expected vx=200, got ${res.vx}`);
  assert.ok(Math.abs(res.vz - 64) < 1e-3, `Expected vz=64, got ${res.vz}`);
  assert.deepEqual(computePlayerSpeed(frames, 1, 108, 64), { speed: 0, vx: 0, vy: 0, vz: 0 });
});

test('resolveMoveDirection and resolveOperatorClipNames pick accurate CS2 world and viewmodel clips', () => {
  assert.equal(resolveMoveDirection(200, 0, 0), 'n');
  assert.equal(resolveMoveDirection(200, 0, 180), 's');
  assert.equal(resolveMoveDirection(0, -200, 0), 'e');
  assert.equal(resolveMoveDirection(0, 200, 0), 'w');

  const akRun = resolveOperatorClipNames({ weaponKey: 'ak47', weaponCat: 'rifle', speed: 215, vx: 215, vy: 0, yawDeg: 0, firing: true });
  assert.equal(akRun.worldBase, 'world/rifle/_default_rifle/run_n_rifle');
  assert.equal(akRun.worldAction, 'world/rifle/rifle_ak/shoot_ak');
  assert.equal(akRun.vmIdle, 'viewmodel/rifle/rifle_ak/idle_ak');
  assert.equal(akRun.vmShoot, 'viewmodel/rifle/rifle_ak/shoot1_ak');

  const crouchPlant = resolveOperatorClipNames({ weaponKey: 'c4', weaponCat: 'c4', duck: 1, planting: true });
  assert.equal(crouchPlant.worldBase, 'world/equipment/c4/planting_crouch');
});

test('findNextAliveTeammate never returns an enemy/killer slot', () => {
  const players = [
    [0, 3], // dead CT (slot 0)
    [1, 2], // alive T killer (slot 1)
    [0, 3], // dead CT (slot 2)
    [1, 3], // alive CT teammate (slot 3)
  ];
  assert.equal(findNextAliveTeammate(players, 0, 3), 3);
  // Only enemy alive -> returns -1 (stays in free cam)
  const onlyEnemies = [
    [0, 3],
    [1, 2],
    [1, 2],
  ];
  assert.equal(findNextAliveTeammate(onlyEnemies, 0, 3), -1);
});

test('deoverlapScreenTags guarantees zero overlaps when 10 combat tags stack near viewport edge', () => {
  const tags = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    sx: 700 + (i % 3) * 8,
    sy: 810 + (i % 2) * 4,
  }));
  const res = deoverlapScreenTags(tags, 26, 152, 320, { minX: 350, maxX: 1028, minY: 86, maxY: 818 });
  assert.equal(res.length, 10);
  for (let i = 0; i < res.length; i++) {
    assert.ok(res[i].sx >= 350 && res[i].sx <= 1028);
    assert.ok(res[i].sy >= 86 && res[i].sy <= 818);
    for (let j = i + 1; j < res.length; j++) {
      const dx = Math.abs(res[i].sx - res[j].sx);
      const dy = Math.abs(res[i].sy - res[j].sy);
      assert.ok(dx >= 152 || dy >= 26, `tags ${i} and ${j} overlap: dx=${dx}, dy=${dy}`);
    }
  }
});
