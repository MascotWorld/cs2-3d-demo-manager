// Pure CS2 <-> Three.js coordinate math, binary mesh parsing, and replay interpolation.
// CS2 world space: +X east, +Y north, +Z up (right-handed).
// Three.js space: +X right, +Y up, -Z forward (right-handed, Rx(-90 deg)).

export const EYE_HEIGHT_STAND = 64;
export const EYE_HEIGHT_CROUCH = 46;
export const CROUCH_REDUCTION = (EYE_HEIGHT_STAND - EYE_HEIGHT_CROUCH) / EYE_HEIGHT_STAND;
export const PLAYER_HEIGHT_STAND = 72;
export const PLAYER_RADIUS = 16;
export const INCHES_PER_METER = 1 / 0.0254;

export function cs2ToThree(x, y, z) {
  return [x, z, -y];
}

export function cs2LookDirThree(yawDeg, pitchDeg) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  return [Math.cos(yaw) * cosP, -sinP, -Math.sin(yaw) * cosP];
}

export function playerEyePosThree(x, y, z, duck = 0) {
  const clampedDuck = Math.max(0, Math.min(1, duck || 0));
  const eyeZ = z + EYE_HEIGHT_STAND * (1 - CROUCH_REDUCTION * clampedDuck);
  return [x, eyeZ, -y];
}

export function playerBodyHeight(duck = 0) {
  const clampedDuck = Math.max(0, Math.min(1, duck || 0));
  return PLAYER_HEIGHT_STAND * (1 - CROUCH_REDUCTION * clampedDuck);
}

export function lerpAngleDeg(a, b, t) {
  let diff = ((b - a + 540) % 360) - 180;
  return a + diff * t;
}

export function findFrameIndex(frames, tick) {
  if (!frames || frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// PlayerTuple indices from internal/parser/types.go:
// [0] alive, [1] team, [2] x, [3] y, [4] z, [5] yaw, [6] pitch,
// [7] hp, [8] armor, [9] duck, [10] scoped, [11] flashFrac, [12] flashAlpha,
// [13] weaponIdx, [14] flags (bit0: helmet, bit1: defuser, bit2: firing)
export function interpolateFrames(frames, tickFloat) {
  if (!frames || frames.length === 0) return null;
  const idx = findFrameIndex(frames, tickFloat);
  const fA = frames[idx];
  const fB = frames[Math.min(frames.length - 1, idx + 1)];
  const span = fB.t - fA.t;
  const alpha = span > 0 ? Math.max(0, Math.min(1, (tickFloat - fA.t) / span)) : 0;

  const pA = fA.p || [];
  const pB = fB.p || [];
  const count = Math.max(pA.length, pB.length);
  const players = new Array(count);

  for (let i = 0; i < count; i++) {
    const a = pA[i];
    const b = pB[i];
    if (!a && !b) {
      players[i] = null;
      continue;
    }
    if (!a) {
      players[i] = b.slice();
      continue;
    }
    if (!b || a[0] !== b[0] || alpha === 0) {
      players[i] = a.slice();
      continue;
    }
    // Avoid interpolating across teleports/respawns
    const dx = b[2] - a[2];
    const dy = b[3] - a[3];
    const dz = b[4] - a[4];
    if (dx * dx + dy * dy + dz * dz > 22500) {
      players[i] = a.slice();
      continue;
    }
    const base = [
      a[0],
      a[1],
      a[2] + dx * alpha,
      a[3] + dy * alpha,
      a[4] + dz * alpha,
      lerpAngleDeg(a[5], b[5], alpha),
      a[6] + (b[6] - a[6]) * alpha,
      a[7],
      a[8],
      a[9] + (b[9] - a[9]) * alpha,
      a[10],
      a[11] + (b[11] - a[11]) * alpha,
      a[12],
      a[13],
      a[14],
    ];
    if (a.length > 15) {
      for (let k = 15; k < a.length; k++) {
        if ((k === 20 || k === 21) && k < b.length) {
          base.push(a[k] + (b[k] - a[k]) * alpha);
        } else {
          base.push(a[k]);
        }
      }
    }
    players[i] = base;
  }

  const bA = fA.b || [0, 0, 0, -1, 0];
  const bB = fB.b || bA;
  const bombSameState = bA[4] === bB[4];
  const bdx = bB[0] - bA[0];
  const bdy = bB[1] - bA[1];
  const bdz = bB[2] - bA[2];
  const bomb =
    bombSameState && bdx * bdx + bdy * bdy + bdz * bdz < 22500
      ? [
          bA[0] + bdx * alpha,
          bA[1] + bdy * alpha,
          bA[2] + bdz * alpha,
          bA[3],
          bA[4],
        ]
      : bA.slice();

  return { tick: tickFloat, frameTick: fA.t, alpha, players, bomb };
}

export function smokeEnvelope(smoke, tick, tickRate = 64) {
  if (!smoke || tick < smoke.start_tick || tick > smoke.end_tick) {
    return { active: false, scale: 0, opacity: 0 };
  }
  const fadeTicks = Math.max(8, Math.round(0.6 * tickRate));
  const sinceStart = tick - smoke.start_tick;
  const untilEnd = smoke.end_tick - tick;
  const grow = Math.min(1, sinceStart / fadeTicks);
  const fade = Math.min(1, untilEnd / fadeTicks);
  const env = Math.max(0.05, Math.min(grow, fade));
  return {
    active: true,
    scale: 0.35 + 0.65 * grow,
    opacity: 0.72 * env,
  };
}

// Parse CSMSH1 binary mesh and transform vertices from CS2 (x,y,z) -> Three.js (x,z,-y).
export function parseCsmsh1(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 34) {
    throw new Error('CSMSH1 buffer too small');
  }
  const bytes = new Uint8Array(arrayBuffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (magic !== 'CSMSH1') {
    throw new Error(`Invalid CSMSH1 magic: ${magic}`);
  }
  const dv = new DataView(arrayBuffer);
  const cs2Min = [dv.getFloat32(6, true), dv.getFloat32(10, true), dv.getFloat32(14, true)];
  const cs2Max = [dv.getFloat32(18, true), dv.getFloat32(22, true), dv.getFloat32(26, true)];
  const triCount = dv.getUint32(30, true);
  const floatCount = triCount * 9;
  const expectedBytes = 34 + floatCount * 4;
  if (arrayBuffer.byteLength < expectedBytes) {
    throw new Error(`CSMSH1 truncated: got ${arrayBuffer.byteLength}, expected ${expectedBytes}`);
  }

  const positions = new Float32Array(floatCount);
  let off = 34;
  for (let i = 0; i < floatCount; i += 3) {
    const cx = dv.getFloat32(off, true);
    const cy = dv.getFloat32(off + 4, true);
    const cz = dv.getFloat32(off + 8, true);
    positions[i] = cx;
    positions[i + 1] = cz;
    positions[i + 2] = -cy;
    off += 12;
  }

  const minThree = [cs2Min[0], cs2Min[2], -cs2Max[1]];
  const maxThree = [cs2Max[0], cs2Max[2], -cs2Min[1]];
  const centerThree = [
    (minThree[0] + maxThree[0]) * 0.5,
    (minThree[1] + maxThree[1]) * 0.5,
    (minThree[2] + maxThree[2]) * 0.5,
  ];

  return {
    triCount,
    positions,
    cs2Min,
    cs2Max,
    minThree,
    maxThree,
    centerThree,
  };
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export function isSniperWeapon(weaponName = '') {
  const w = String(weaponName).toLowerCase();
  return w.includes('awp') || w.includes('ssg 08') || w.includes('scar-20') || w.includes('g3sg1');
}

export function isScopedWeapon(weaponName = '') {
  const w = String(weaponName).toLowerCase();
  return isSniperWeapon(w) || w.includes('aug') || w.includes('sg 553');
}

export function povCameraFov(weaponName = '', zoomLevel = 0) {
  if (!zoomLevel || zoomLevel <= 0) return 88;
  if (isSniperWeapon(weaponName)) {
    return zoomLevel >= 2 ? 15 : 40;
  }
  return 45;
}

export function weaponCategory(weaponName = '') {
  const w = String(weaponName).toLowerCase();
  if (!w || w.includes('knife') || w.includes('bayonet') || w.includes('karambit') || w.includes('zeus')) {
    return 'knife';
  }
  if (w.includes('c4')) return 'c4';
  if (
    w.includes('smoke') ||
    w.includes('flash') ||
    w.includes('he grenade') ||
    w.includes('molotov') ||
    w.includes('incendiary') ||
    w.includes('decoy')
  ) {
    return 'grenade';
  }
  if (isSniperWeapon(w)) return 'sniper';
  if (
    w.includes('glock') ||
    w.includes('usp') ||
    w.includes('p2000') ||
    w.includes('p250') ||
    w.includes('five-seven') ||
    w.includes('tec-9') ||
    w.includes('cz75') ||
    w.includes('deagle') ||
    w.includes('desert eagle') ||
    w.includes('revolver') ||
    w.includes('dual berettas')
  ) {
    return 'pistol';
  }
  if (
    w.includes('mac-10') ||
    w.includes('mp9') ||
    w.includes('mp7') ||
    w.includes('mp5') ||
    w.includes('ump') ||
    w.includes('p90') ||
    w.includes('pp-bizon')
  ) {
    return 'smg';
  }
  if (w.includes('nova') || w.includes('xm1014') || w.includes('mag-7') || w.includes('sawed-off') || w.includes('m249') || w.includes('negev')) {
    return 'heavy';
  }
  return 'rifle';
}

export function weaponNameToModelKey(weaponName = '', team = 3) {
  const w = String(weaponName || '').toLowerCase().trim();
  if (!w) return team === 2 ? 'knife_t' : 'knife_ct';
  if (w.includes('knife') || w.includes('bayonet') || w.includes('karambit') || w.includes('kukri') || w.includes('dagger') || w.includes('stiletto') || w.includes('talon') || w.includes('ursus')) {
    return team === 2 ? 'knife_t' : 'knife_ct';
  }
  if (w.includes('c4')) return 'c4';
  if (w.includes('he grenade') || w === 'hegrenade') return 'hegrenade';
  if (w.includes('flash')) return 'flashbang';
  if (w.includes('smoke')) return 'smokegrenade';
  if (w.includes('molotov')) return 'molotov';
  if (w.includes('incendiary')) return 'incendiarygrenade';
  if (w.includes('decoy')) return 'decoy';
  if (w.includes('ak-47') || w.includes('ak47')) return 'ak47';
  if (w.includes('m4a1') || w.includes('m4a1-s')) return 'm4a1_silencer';
  if (w.includes('m4a4')) return 'm4a4';
  if (w.includes('awp')) return 'awp';
  if (w.includes('ssg 08') || w.includes('ssg08') || w.includes('scout')) return 'ssg08';
  if (w.includes('scar-20') || w.includes('g3sg1')) return 'awp';
  if (w.includes('aug')) return 'aug';
  if (w.includes('sg 553') || w.includes('sg556')) return 'sg556';
  if (w.includes('famas')) return 'famas';
  if (w.includes('galil')) return 'galilar';
  if (w.includes('desert eagle') || w.includes('deagle') || w.includes('revolver')) return 'deagle';
  if (w.includes('glock')) return 'glock18';
  if (w.includes('usp')) return 'usp_silencer';
  if (w.includes('p2000') || w.includes('hkp2000')) return 'hkp2000';
  if (w.includes('p250') || w.includes('dual berettas') || w.includes('cz75') || w.includes('zeus')) return 'p250';
  if (w.includes('tec-9') || w.includes('tec9')) return 'tec9';
  if (w.includes('five-seven') || w.includes('fiveseven')) return 'fiveseven';
  if (w.includes('mp9')) return 'mp9';
  if (w.includes('mac-10') || w.includes('mac10')) return 'mac10';
  if (w.includes('mp7') || w.includes('mp5') || w.includes('pp-bizon')) return 'mp7';
  if (w.includes('ump')) return 'ump45';
  if (w.includes('p90')) return 'p90';
  if (w.includes('xm1014')) return 'xm1014';
  if (w.includes('mag-7') || w.includes('mag7')) return 'mag7';
  if (w.includes('nova') || w.includes('sawed-off')) return 'nova';
  if (w.includes('m249') || w.includes('negev')) return 'galilar';
  return 'ak47';
}

export function grenadeTypeToModelKey(type = '') {
  switch (String(type || '').toLowerCase()) {
    case 'he':
    case 'hegrenade':
      return 'hegrenade';
    case 'flash':
    case 'flashbang':
      return 'flashbang';
    case 'smoke':
    case 'smokegrenade':
      return 'smokegrenade';
    case 'molotov':
      return 'molotov';
    case 'incendiary':
    case 'incgrenade':
      return 'incendiarygrenade';
    case 'decoy':
      return 'decoy';
    default:
      return 'hegrenade';
  }
}

export function unpackUtilityCounts(packed = 0) {
  const n = Math.max(0, Math.floor(packed || 0));
  return {
    smoke: n % 10,
    flash: Math.floor(n / 10) % 10,
    he: Math.floor(n / 100) % 10,
    molly: Math.floor(n / 1000) % 10,
    decoy: Math.floor(n / 10000) % 10,
    c4: Math.floor(n / 100000) % 10,
  };
}

export function computeRoundClock(roundReplay, tick, tickRate = 64) {
  const sum = roundReplay?.summary || {};
  const rate = tickRate || roundReplay?.tick_rate || 64;
  const startTick = sum.start_tick ?? roundReplay?.frames?.[0]?.t ?? 0;
  const freezeEnd = sum.freeze_end_tick || startTick;
  const roundTimeSec = sum.round_time_sec > 0 ? sum.round_time_sec : 115;
  const freezeTimeSec = sum.freeze_time_sec > 0 ? sum.freeze_time_sec : Math.max(0, Math.round((freezeEnd - startTick) / rate));
  const bombTimeSec = sum.bomb_time_sec > 0 ? sum.bomb_time_sec : 40;

  const bombEvents = roundReplay?.bomb_events || [];
  let plantedEv = null;
  let endEv = null;
  let activeAction = null;

  for (const ev of bombEvents) {
    if (ev.tick > tick) break;
    if (ev.type === 'planted') plantedEv = ev;
    else if (ev.type === 'defused' || ev.type === 'exploded') endEv = ev;
    else if (ev.type === 'plant_begin') {
      activeAction = {
        type: 'planting',
        startTick: ev.tick,
        totalSec: ev.duration_sec || 3.2,
        hasKit: false,
        slot: ev.player_slot,
      };
    } else if (ev.type === 'plant_abort' || ev.type === 'planted') {
      if (activeAction?.type === 'planting') activeAction = null;
    } else if (ev.type === 'defuse_begin') {
      activeAction = {
        type: 'defusing',
        startTick: ev.tick,
        totalSec: ev.duration_sec || (ev.has_kit ? 5.0 : 10.0),
        hasKit: !!ev.has_kit,
        slot: ev.player_slot,
      };
    } else if (ev.type === 'defuse_abort' || ev.type === 'defused' || ev.type === 'exploded') {
      if (activeAction?.type === 'defusing') activeAction = null;
    }
  }
  if (plantedEv && activeAction?.type === 'planting') activeAction = null;
  if (endEv) activeAction = null;

  let action = null;
  if (activeAction) {
    const elapsed = Math.max(0, (tick - activeAction.startTick) / rate);
    const progress = Math.max(0, Math.min(1, elapsed / Math.max(0.1, activeAction.totalSec)));
    const secondsLeft = Math.max(0, activeAction.totalSec - elapsed);
    action = { ...activeAction, progress, secondsLeft };
  }

  if (endEv) {
    return {
      phase: endEv.type,
      clockText: endEv.type === 'defused' ? 'DEFUSED' : 'DETONATED',
      secondsLeft: 0,
      bombPct: 0,
      action: null,
    };
  }
  if (plantedEv) {
    const total = plantedEv.duration_sec || bombTimeSec;
    const elapsed = Math.max(0, (tick - plantedEv.tick) / rate);
    const left = Math.max(0, total - elapsed);
    return {
      phase: 'planted',
      clockText: `${left.toFixed(1)}s`,
      secondsLeft: left,
      bombPct: Math.max(0, Math.min(100, (left / total) * 100)),
      site: plantedEv.site || sum.bomb_site || '',
      action,
    };
  }
  if (tick < freezeEnd && freezeEnd > startTick) {
    const left = Math.max(0, (freezeEnd - tick) / rate);
    return {
      phase: 'freeze',
      clockText: formatClock(Math.ceil(Math.min(freezeTimeSec || 15, left))),
      secondsLeft: left,
      bombPct: 0,
      action,
    };
  }
  const elapsedLive = Math.max(0, (tick - freezeEnd) / rate);
  const left = Math.max(0, roundTimeSec - elapsedLive);
  return {
    phase: 'live',
    clockText: formatClock(Math.ceil(left)),
    secondsLeft: left,
    bombPct: 0,
    action,
  };
}

// Map CS2 world (x, y) to pixel coords on a square radar canvas using Valve overview metadata (1024 base).
export function worldToOverviewRadar(wx, wy, canvasSize, overview) {
  if (!overview || !overview.scale) return null;
  const normX = (wx - overview.pos_x) / (overview.scale * 1024);
  const normY = (overview.pos_y - wy) / (overview.scale * 1024);
  return [normX * canvasSize, normY * canvasSize];
}

// De-overlap and clamp projected 2D player tags inside safe viewport bounds (clearing HUD panels).
export function deoverlapScreenTags(
  tags,
  minGapY = 26,
  minGapX = 148,
  maxShiftY = 320,
  bounds = null
) {
  if (!tags || tags.length === 0) return [];
  const minX = bounds?.minX ?? -Infinity;
  const maxX = bounds?.maxX ?? Infinity;
  const minY = bounds?.minY ?? -Infinity;
  const maxY = bounds?.maxY ?? Infinity;

  const clamped = tags.map((t) => ({
    ...t,
    sx: Math.max(minX, Math.min(maxX, t.sx)),
    sy: Math.max(minY, Math.min(maxY, t.sy)),
  }));
  if (clamped.length === 1) return clamped;

  const sorted = [...clamped].sort((a, b) => a.sy - b.sy || a.sx - b.sx);
  const placed = [];

  const hasConflict = (cx, cy) => {
    for (const p of placed) {
      if (Math.abs(cx - p.sx) < minGapX && Math.abs(cy - p.sy) < minGapY) {
        return true;
      }
    }
    return false;
  };

  for (const t of sorted) {
    const origX = t.sx;
    const origY = t.sy;
    if (!hasConflict(origX, origY)) {
      placed.push({ ...t, sx: origX, sy: origY });
      continue;
    }

    let bestX = origX;
    let bestY = origY;
    let found = false;
    let bestScore = Infinity;

    const maxRings = 14;
    const maxCols = 4;
    for (let ring = 1; ring <= maxRings && !found; ring++) {
      const dyStep = ring * minGapY;
      const dxList = [0];
      for (let c = 1; c <= maxCols; c++) {
        dxList.push(c * minGapX, -c * minGapX);
      }
      for (const dx of dxList) {
        const cx = Math.max(minX, Math.min(maxX, origX + dx));
        for (const sign of [-1, 1]) {
          const cy = origY + sign * dyStep;
          if (cy < minY || cy > maxY) continue;
          if (sign < 0 && origY - cy > maxShiftY && ring > 6) continue;
          if (!hasConflict(cx, cy)) {
            const score = Math.abs(cx - origX) * 1.4 + Math.abs(cy - origY);
            if (score < bestScore) {
              bestScore = score;
              bestX = cx;
              bestY = cy;
              found = true;
            }
          }
        }
      }
    }

    if (!found) {
      // Fallback full scan inside bounds if viewport is ultra-cramped
      const stepY = Math.max(18, minGapY);
      const stepX = Math.max(96, minGapX);
      for (let cy = minY; cy <= maxY; cy += stepY) {
        for (let cx = minX; cx <= maxX; cx += stepX) {
          if (!hasConflict(cx, cy)) {
            const score = Math.abs(cx - origX) + Math.abs(cy - origY);
            if (score < bestScore) {
              bestScore = score;
              bestX = cx;
              bestY = cy;
              found = true;
            }
          }
        }
      }
    }

    placed.push({ ...t, sx: bestX, sy: bestY });
  }
  return placed;
}

// Determine best transform for a loaded .glb map mesh against reference Three.js bounds (CSGEO1).
export function detectGlbTransform(rawMin, rawMax, refMin = null, refMax = null) {
  const spanX = rawMax[0] - rawMin[0];
  const spanY = rawMax[1] - rawMin[1];
  const spanZ = rawMax[2] - rawMin[2];
  const maxSpan = Math.max(spanX, spanY, spanZ);
  const isMeters = maxSpan > 0 && maxSpan < 450;
  const scale = isMeters ? INCHES_PER_METER : 1;

  const candidates = [
    { name: 'ry+90', rotX: 0, rotY: Math.PI / 2, rotZ: 0 },
    { name: 'ry-90', rotX: 0, rotY: -Math.PI / 2, rotZ: 0 },
    { name: 'identity', rotX: 0, rotY: 0, rotZ: 0 },
    { name: 'ry180', rotX: 0, rotY: Math.PI, rotZ: 0 },
    { name: 'rx-90', rotX: -Math.PI / 2, rotY: 0, rotZ: 0 },
  ];

  const transformBox = (c) => {
    // Apply Rx then Ry in standard Euler XYZ on 8 corners
    const xs = [rawMin[0], rawMax[0]];
    const ys = [rawMin[1], rawMax[1]];
    const zs = [rawMin[2], rawMax[2]];
    const outMin = [Infinity, Infinity, Infinity];
    const outMax = [-Infinity, -Infinity, -Infinity];
    const cx = Math.cos(c.rotX), sx = Math.sin(c.rotX);
    const cy = Math.cos(c.rotY), sy = Math.sin(c.rotY);
    for (const x0 of xs) {
      for (const y0 of ys) {
        for (const z0 of zs) {
          // Rx
          const y1 = y0 * cx - z0 * sx;
          const z1 = y0 * sx + z0 * cx;
          // Ry
          const x2 = (x0 * cy + z1 * sy) * scale;
          const y2 = y1 * scale;
          const z2 = (-x0 * sy + z1 * cy) * scale;
          if (x2 < outMin[0]) outMin[0] = x2;
          if (y2 < outMin[1]) outMin[1] = y2;
          if (z2 < outMin[2]) outMin[2] = z2;
          if (x2 > outMax[0]) outMax[0] = x2;
          if (y2 > outMax[1]) outMax[1] = y2;
          if (z2 > outMax[2]) outMax[2] = z2;
        }
      }
    }
    return { min: outMin, max: outMax };
  };

  if (!refMin || !refMax) {
    return isMeters
      ? { scale, rotX: 0, rotY: Math.PI / 2, rotZ: 0, name: 'meters_ry+90' }
      : { scale: 1, rotX: 0, rotY: 0, rotZ: 0, name: 'identity' };
  }

  let best = { ...candidates[0], scale };
  let bestScore = -Infinity;
  for (const c of candidates) {
    const b = transformBox(c);
    // Score containment inside refMin..refMax + vertical alignment
    let overflow = 0;
    let overlapVol = 1;
    for (let k = 0; k < 3; k++) {
      if (b.min[k] < refMin[k]) overflow += refMin[k] - b.min[k];
      if (b.max[k] > refMax[k]) overflow += b.max[k] - refMax[k];
      const ov = Math.max(0, Math.min(b.max[k], refMax[k]) - Math.max(b.min[k], refMin[k]));
      overlapVol *= Math.max(1, ov);
    }
    const score = overlapVol - overflow * 1e6;
    if (score > bestScore) {
      bestScore = score;
      best = { ...c, scale };
    }
  }
  return best;
}

export const QUALITY_PRESETS = {
  high: {
    id: 'high',
    label: 'High',
    shadowMapSize: 2048,
    shadowsEnabled: true,
    softShadows: true,
    aoEnabled: true,
    pixelRatioCap: 1.5,
    maxDetailLevel: 2,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    shadowMapSize: 512,
    shadowsEnabled: true,
    softShadows: false,
    aoEnabled: true,
    pixelRatioCap: 1.25,
    maxDetailLevel: 1,
  },
  low: {
    id: 'low',
    label: 'Low',
    shadowMapSize: 0,
    shadowsEnabled: false,
    softShadows: false,
    aoEnabled: false,
    pixelRatioCap: 1.0,
    maxDetailLevel: 0,
  },
};

export function nextDowngradedQuality(current) {
  if (current === 'high') return 'medium';
  if (current === 'medium') return 'low';
  return null;
}

// Compute player's horizontal ground speed (units/sec), CS2 world XY velocity, and vertical velocity around tick
// directly from replay frames so paused/scrubbed ticks retain accurate directional run/walk/jump poses.
export function computePlayerSpeed(frames, slot, tick, tickRate = 64) {
  if (!frames || frames.length < 2 || slot < 0) return { speed: 0, vx: 0, vy: 0, vz: 0 };
  const idx = findFrameIndex(frames, tick);
  const i0 = Math.max(0, idx - 1);
  const i1 = Math.min(frames.length - 1, idx + 1);
  if (i1 <= i0) return { speed: 0, vx: 0, vy: 0, vz: 0 };

  let f0 = frames[i0];
  let f1 = frames[i1];
  let p0 = f0?.p?.[slot];
  let p1 = f1?.p?.[slot];
  if (!p0 || p0[0] !== 1) {
    f0 = frames[idx];
    p0 = f0?.p?.[slot];
  }
  if (!p1 || p1[0] !== 1) {
    f1 = frames[idx];
    p1 = f1?.p?.[slot];
  }
  if (!p0 || !p1 || p0[0] !== 1 || p1[0] !== 1) return { speed: 0, vx: 0, vy: 0, vz: 0 };
  const dtTicks = f1.t - f0.t;
  if (dtTicks <= 0) return { speed: 0, vx: 0, vy: 0, vz: 0 };
  const dtSec = dtTicks / Math.max(1, tickRate);
  const dx = p1[2] - p0[2];
  const dy = p1[3] - p0[3];
  const dz = p1[4] - p0[4];
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq > 22500) return { speed: 0, vx: 0, vy: 0, vz: 0 };
  return {
    speed: Math.hypot(dx, dy) / dtSec,
    vx: dx / dtSec,
    vy: dy / dtSec,
    vz: dz / dtSec,
  };
}

// Resolve local 8-way compass suffix ('n','ne','e','se','s','sw','w','nw') from CS2 XY velocity and player yawDeg.
export function resolveMoveDirection(vx = 0, vy = 0, yawDeg = 0) {
  const speed = Math.hypot(vx, vy);
  if (speed < 1e-3) return 'n';
  const yaw = (yawDeg * Math.PI) / 180;
  const fwdX = Math.cos(yaw);
  const fwdY = Math.sin(yaw);
  const rightX = Math.sin(yaw);
  const rightY = -Math.cos(yaw);
  const vFwd = vx * fwdX + vy * fwdY;
  const vRight = vx * rightX + vy * rightY;
  const ang = Math.atan2(vRight, vFwd); // 0 = N (forward), +pi/2 = E (strafe right), pi = S, -pi/2 = W
  const dirs = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  const idx = ((Math.round((ang / (Math.PI / 4))) % 8) + 8) % 8;
  return dirs[idx];
}

// Pick the real CS2 world and viewmodel clip names for an operator + weapon state.
export function resolveOperatorClipNames({
  weaponKey = 'ak47',
  weaponCat = 'rifle',
  team = 3,
  duck = 0,
  speed = 0,
  vx = 0,
  vy = 0,
  vz = 0,
  yawDeg = 0,
  firing = false,
  flashed = 0,
  planting = false,
  defusing = false,
} = {}) {
  const crouched = duck > 0.5;
  const dir = resolveMoveDirection(vx, vy, yawDeg);
  const fam = weaponCat === 'pistol' ? 'pistol' : weaponCat === 'knife' || weaponCat === 'grenade' || weaponCat === 'c4' ? 'knife' : 'rifle';
  const famDir = fam === 'rifle' ? 'world/rifle/_default_rifle' : fam === 'pistol' ? 'world/pistol/_default_pistol' : 'world/knife/_default_knife';

  let worldBase;
  if (planting) {
    worldBase = crouched ? 'world/equipment/c4/planting_crouch' : 'world/equipment/c4/planting';
  } else if (defusing) {
    worldBase = crouched ? `world/shared/defuse/defuse_crouch_loop_${fam}` : `world/shared/defuse/defuse_loop_${fam}`;
  } else if (Math.abs(vz) > 95) {
    worldBase = crouched ? `${famDir}/inair_crouch_stand_${fam}` : `${famDir}/inair_stand_${fam}`;
  } else if (crouched) {
    worldBase = speed > 18 ? `${famDir}/crouch_${dir}_${fam}` : `${famDir}/idle_crouch_${fam}`;
  } else if (speed > 145) {
    worldBase = `${famDir}/run_${dir}_${fam}`;
  } else if (speed > 18) {
    worldBase = `${famDir}/walk_${dir}_${fam}`;
  } else if (weaponCat === 'c4') {
    worldBase = 'world/equipment/c4/idle_c4';
  } else if (weaponCat === 'grenade') {
    worldBase = 'world/grenade/_default_grenade/idle_grenade';
  } else {
    worldBase = `${famDir}/idle_${fam}`;
  }

  let worldAction = null;
  if (firing) {
    const shootMap = {
      ak47: 'world/rifle/rifle_ak/shoot_ak',
      m4a4: 'world/rifle/rifle_m4a4/shoot_m4a4',
      m4a1_silencer: 'world/rifle/rifle_m4a1_silencer/shoot_m4a1s',
      awp: 'world/rifle/rifle_awp/shoot_awp',
      ssg08: 'world/rifle/rifle_ssg08/shoot_ssg08',
      famas: 'world/rifle/rifle_famas/shoot_famas',
      galilar: 'world/rifle/rifle_galilar/shoot_galilar',
      aug: 'world/rifle/rifle_aug/shoot_aug',
      sg556: 'world/rifle/rifle_sg556/shoot_sg556',
      mp9: 'world/rifle/rifle_mp9/shoot_mp9',
      mp7: 'world/rifle/rifle_mp7/shoot_mp7',
      ump45: 'world/rifle/rifle_ump45/shoot_ump45',
      mac10: 'world/rifle/rifle_mac10/shoot_mac10',
      p90: 'world/rifle/rifle_p90/shoot_p90',
      nova: 'world/rifle/rifle_nova/shoot_nova',
      xm1014: 'world/rifle/rifle_xm1014/shoot_xm1014',
      mag7: 'world/rifle/rifle_mag7/shoot_mag7',
      glock18: 'world/pistol/pistol_glock/shoot_glock',
      usp_silencer: 'world/pistol/pistol_usp/shoot_usp',
      hkp2000: 'world/pistol/pistol_hkp2000/shoot_hkp',
      p250: 'world/pistol/pistol_p250/shoot_p250',
      fiveseven: 'world/pistol/pistol_fiveseven/shoot_fiveseven',
      tec9: 'world/pistol/pistol_tec9/shoot_tec9',
      deagle: 'world/pistol/pistol_deagle/shoot_deagle',
    };
    worldAction = shootMap[weaponKey] || null;
  } else if (flashed > 0.35) {
    worldAction = crouched ? 'world/shared/flashed_crouch' : 'world/shared/flashed';
  }

  // Viewmodel clips
  const vmFolderMap = {
    ak47: ['viewmodel/rifle/rifle_ak', 'ak'],
    m4a4: ['viewmodel/rifle/rifle_m4a4', 'm4a4'],
    m4a1_silencer: ['viewmodel/rifle/_default_rifle', 'rifle'],
    awp: ['viewmodel/rifle/rifle_awp', 'awp'],
    ssg08: ['viewmodel/rifle/rifle_ssg08', 'ssg08'],
    famas: ['viewmodel/rifle/rifle_famas', 'famas'],
    galilar: ['viewmodel/rifle/rifle_galilar', 'galilar'],
    aug: ['viewmodel/rifle/rifle_aug', 'aug'],
    sg556: ['viewmodel/rifle/rifle_sg556', 'sg556'],
    mp9: ['viewmodel/rifle/rifle_mp9', 'mp9'],
    mp7: ['viewmodel/rifle/rifle_mp7', 'mp7'],
    ump45: ['viewmodel/rifle/rifle_ump45', 'ump45'],
    mac10: ['viewmodel/rifle/rifle_mac10', 'mac10'],
    p90: ['viewmodel/rifle/rifle_p90', 'p90'],
    nova: ['viewmodel/rifle/rifle_nova', 'nova'],
    xm1014: ['viewmodel/rifle/rifle_xm1014', 'xm1014'],
    mag7: ['viewmodel/rifle/rifle_mag7', 'mag7'],
    glock18: ['viewmodel/pistol/pistol_glock18', 'glock'],
    usp_silencer: ['viewmodel/pistol/_default_pistol', 'pistol'],
    hkp2000: ['viewmodel/pistol/pistol_hkp2000', 'hkp'],
    p250: ['viewmodel/pistol/pistol_p250', 'p250'],
    fiveseven: ['viewmodel/pistol/pistol_fiveseven', 'fiveseven'],
    tec9: ['viewmodel/pistol/pistol_tec9', 'tec9'],
    deagle: ['viewmodel/pistol/pistol_deagle', 'deagle'],
    knife_ct: ['viewmodel/knife/_default_knife', 'knife'],
    knife_t: ['viewmodel/knife/knife_default_t', 'default_t'],
    c4: ['viewmodel/equipment/c4', 'c4'],
    smokegrenade: ['viewmodel/grenade/grenade_smokegrenade', 'smoke'],
    flashbang: ['viewmodel/grenade/grenade_flashbang', 'flashbang'],
    hegrenade: ['viewmodel/grenade/grenade_hegrenade', 'hegrenade'],
    molotov: ['viewmodel/grenade/grenade_molotov', 'molotov'],
    incendiarygrenade: ['viewmodel/grenade/grenade_incendiary', 'incendiary'],
    decoy: ['viewmodel/grenade/_default_grenade', 'grenade'],
  };
  const [vmBase, vmSuffix] = vmFolderMap[weaponKey] || (
    team === 2 && weaponCat === 'knife'
      ? ['viewmodel/knife/knife_default_t', 'default_t']
      : ['viewmodel/rifle/_default_rifle', 'rifle']
  );

  return {
    worldBase,
    worldAction,
    vmIdle: `${vmBase}/idle_${vmSuffix}`,
    vmDraw: `${vmBase}/draw_${vmSuffix}`,
    vmShoot: weaponCat === 'knife' ? `${vmBase}/light_hit1_${vmSuffix}` : `${vmBase}/shoot1_${vmSuffix}`,
    vmReload: `${vmBase}/reload_${vmSuffix}`,
    vmInspect: `${vmBase}/lookat01_${vmSuffix}`,
  };
}

// Find an alive teammate for POV deathcam auto-switch (NEVER switches to an enemy/killer).
export function findNextAliveTeammate(players, deadSlot, deadTeam) {
  if (!Array.isArray(players)) return -1;
  const n = players.length;
  for (let off = 1; off < n; off++) {
    const s = (deadSlot + off) % n;
    const p = players[s];
    if (p && p[0] === 1 && p[1] === deadTeam) {
      return s;
    }
  }
  return -1;
}

