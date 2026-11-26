import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cs2FovToVertical, povCameraFov, roundTeamsBySlot, VIEWMODEL_FOV } from '../../web/src/viewer/math.js';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require('playwright');

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CACHE_DEMO_BZ2 = process.env.CS2_TEST_CACHE_DEMO;
const NUKE_DEMO_PATH = process.env.CS2_TEST_NUKE_DEMO;
const GEO_DIR = process.env.CS2_GEO_DIRS || path.join(REPO_ROOT, 'data', 'assets', 'geo');
const ASSETS_DIR = process.env.CS2_ASSET_DIRS || path.join(REPO_ROOT, 'data', 'assets');
const RENDERS_DIR = process.env.E2E_RENDERS_DIR || path.join(REPO_ROOT, 'data', 'test-renders');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become healthy at ${url} within ${timeoutMs}ms`);
}

async function assertTagsAndHudClean(page, label) {
  const check = await page.evaluate(() => {
    const hudSelectors = ['.radar-box', '#team-hud-ct', '#team-hud-t', '.right-overlay', '.round-clock-banner', '#flash-meter', '#pov-bottom-hud'];
    const hudRects = hudSelectors
      .map((sel) => {
        const el = document.querySelector(sel);
        if (!el || getComputedStyle(el).display === 'none') return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { name: sel, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      })
      .filter(Boolean);

    const hudOverlaps = [];
    for (let i = 0; i < hudRects.length; i++) {
      for (let j = i + 1; j < hudRects.length; j++) {
        const a = hudRects[i], b = hudRects[j];
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          hudOverlaps.push(`${a.name}<->${b.name}`);
        }
      }
    }

    const tags = [...document.querySelectorAll('.player-3d-tag')]
      .filter((el) => el.style.display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });

    const tagOverlaps = [];
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const a = tags[i], b = tags[j];
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          tagOverlaps.push(`${a.text}<->${b.text}`);
        }
      }
      for (const h of hudRects) {
        const a = tags[i];
        if (a.left < h.right && a.right > h.left && a.top < h.bottom && a.bottom > h.top) {
          tagOverlaps.push(`${a.text}<->${h.name}`);
        }
      }
    }
    return { hudOverlaps, tagOverlaps, visibleTags: tags.length };
  });
  assert.deepEqual(check.hudOverlaps, [], `${label} HUD overlaps: ${check.hudOverlaps.join(', ')}`);
  assert.deepEqual(check.tagOverlaps, [], `${label} tag/HUD overlaps: ${check.tagOverlaps.join(', ')}`);
}

async function assertOperatorsAcrossHalftime(page, baseUrl, demoId) {
  const { rounds } = await (await fetch(`${baseUrl}/api/demos/${demoId}`)).json();
  const first = await (await fetch(`${baseUrl}/api/demos/${demoId}/rounds/${rounds[0].round_number}`)).json();
  const firstSides = roundTeamsBySlot(first.frames);
  let swapped;
  for (const { round_number } of rounds.filter((r) => r.round_number > 11)) {
    const round = await (await fetch(`${baseUrl}/api/demos/${demoId}/rounds/${round_number}`)).json();
    const sides = roundTeamsBySlot(round.frames);
    if ([...firstSides].filter(([slot, team]) => sides.has(slot) && sides.get(slot) !== team).length >= 5) {
      swapped = { number: round_number, sides };
      break;
    }
  }
  assert.ok(swapped, 'Replay fixture must include a halftime side swap');
  for (const [number, sides] of [[rounds[0].round_number, firstSides], [swapped.number, swapped.sides]]) {
    await page.click(`.round-pill[data-round="${number}"]`);
    await page.waitForFunction((n) => window.__CS2_SCENE__?.roundReplay?.summary?.round_number === n, number);
    const operators = await page.evaluate(() => window.__CS2_SCENE__.playerRigs.map((rig) => {
      let model = '';
      rig.bodyGroup.children[0]?.traverse(({ name }) => {
        if (name.includes('ctm_sas')) model = 'ct';
        if (name.includes('tm_phoenix')) model = 't';
      });
      return [rig.slot, model];
    }));
    for (const [slot, model] of operators) {
      if (sides.has(slot)) assert.equal(model, sides.get(slot) === 3 ? 'ct' : 't', `Round ${number}, slot ${slot}`);
    }
  }
  await page.click(`.round-pill[data-round="${rounds[0].round_number}"]`);
  await page.waitForFunction((n) => window.__CS2_SCENE__?.roundReplay?.summary?.round_number === n, rounds[0].round_number);
}

async function assertOccludedOutlinePixels(page) {
  const pixels = await page.evaluate(() => {
    const view = window.__CS2_SCENE__;
    const renderer = new view.renderer.constructor({ preserveDrawingBuffer: true });
    renderer.setSize(160, 160);
    renderer.autoClear = false;
    renderer.domElement.style.cssText = 'position:fixed; inset:0 auto auto 0; width:160px; height:160px';
    document.body.append(renderer.domElement);
    const outline = new view.playerOutline.constructor(renderer, 0x6ec3ff, 0xffbd4a);
    const scene = new view.scene.constructor();
    const camera = new view.camera.constructor(60, 1, 0.1, 100);
    renderer.setClearColor(0x161a21);
    const plane = (width, height, color) => new outline.quad.constructor(
      new outline.quad.geometry.constructor(width, height),
      new outline.ctMask.constructor({ color }),
    );
    const wall = plane(3.2, 2.1, 0x4b5157);
    wall.position.z = -3;
    scene.add(wall);
    for (const [team, x] of [[3, -0.8], [2, 0.8]]) {
      const actor = new view.playersGroup.constructor();
      actor.userData.outlined = true;
      const body = plane(0.65, 0.95, 0x888888);
      actor.position.set(x, 0, -4);
      actor.add(body);
      scene.add(actor);
      outline.add(actor, actor, team);
    }
    const render = (drawOutline) => {
      renderer.clear();
      renderer.render(scene, camera);
      if (drawOutline) outline.render(camera);
      const gl = renderer.getContext();
      const data = new Uint8Array(160 * 160 * 4);
      gl.readPixels(0, 0, 160, 160, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    const behindWall = render(false);
    const outlined = render(true);
    wall.visible = false;
    const visible = render(false);
    const visibleWithXray = render(true);
    let ct = 0, t = 0, visibleDelta = 0;
    for (let i = 0; i < outlined.length; i += 4) {
      if (outlined[i] !== behindWall[i]) {
        if (outlined[i + 2] - outlined[i] > 60) ct++;
        if (outlined[i] - outlined[i + 2] > 80) t++;
      }
      if (visible[i] !== visibleWithXray[i] || visible[i + 2] !== visibleWithXray[i + 2]) visibleDelta++;
    }
    const centersUntouched = [52, 108].every((x) => {
      const i = (80 * 160 + x) * 4;
      return behindWall[i] === outlined[i] && behindWall[i + 2] === outlined[i + 2];
    });
    outline.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    return { ct, t, visibleDelta, centersUntouched };
  });
  assert.ok(pixels.ct > 25 && pixels.t > 25, `Expected both colors through walls: ${JSON.stringify(pixels)}`);
  assert.equal(pixels.visibleDelta, 0, 'X-ray must not change unobstructed operators');
  assert.ok(pixels.centersUntouched, 'X-ray must leave the silhouette interior unfilled');
}

async function run() {
  assert.ok(CACHE_DEMO_BZ2 && fs.existsSync(CACHE_DEMO_BZ2), 'Set CS2_TEST_CACHE_DEMO to a local Cache .dem.bz2');
  assert.ok(NUKE_DEMO_PATH && fs.existsSync(NUKE_DEMO_PATH), 'Set CS2_TEST_NUKE_DEMO to a local Nuke .dem');
  const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : await getFreePort();
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  fs.mkdirSync(RENDERS_DIR, { recursive: true });
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-demo-e2e-'));
  const binPath = path.join(tmpDataDir, 'cs2-server');

  console.log('Building Go server binary...');
  execFileSync('go', ['build', '-o', binPath, './cmd/server'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  console.log(`Starting server on ${BASE_URL} with dataDir=${tmpDataDir}...`);
  const serverArgs = [
    '-addr',
    `127.0.0.1:${PORT}`,
    '-data',
    tmpDataDir,
    '-geo-dirs',
    GEO_DIR,
    '-static',
    process.env.CS2_STATIC_DIR || path.join(REPO_ROOT, 'web', 'dist'),
  ];
  serverArgs.push('-asset-dirs', ASSETS_DIR);
  const serverProc = spawn(binPath, serverArgs, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLogs = '';
  serverProc.stdout.on('data', (d) => {
    serverLogs += d.toString();
  });
  serverProc.stderr.on('data', (d) => {
    serverLogs += d.toString();
  });

  let browser;
  try {
    const health = await waitForHealth(BASE_URL);
    assert.ok(health.geo_maps.includes('de_cache'), 'de_cache geo map available');
    assert.ok(health.geo_maps.includes('de_nuke'), 'de_nuke geo map available');
    assert.ok(health.custom_maps.includes('de_cache'), 'de_cache custom GLB available');
    assert.ok(health.custom_maps.includes('de_nuke'), 'de_nuke custom GLB available');
    assert.ok(health.player_models?.includes('ct_sas'), 'ct_sas operator GLB available');
    assert.ok(health.player_models?.includes('t_phoenix'), 't_phoenix operator GLB available');
    assert.ok(health.has_operator_anims, 'operator_anims.glb CS2 animation bundle available');
    assert.ok(health.weapon_models?.includes('ak47'), 'ak47 weapon GLB available');
    assert.ok(health.weapon_models?.includes('c4'), 'c4 GLB available');
    assert.ok(health.skyboxes?.includes('de_nuke') && health.skyboxes?.includes('de_cache'), 'CS2 skyboxes available');

    browser = await chromium.launch({
      channel: process.env.E2E_BROWSER_CHANNEL,
      headless: true,
      args: ['--no-proxy-server', '--enable-webgl', '--enable-unsafe-swiftshader'],
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const pageErrors = [];
    const failedApiResponses = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', (res) => {
      if (res.url().includes('/api/') && res.status() >= 500) {
        failedApiResponses.push(`${res.status()} ${res.url()}`);
      }
    });

    // 1. Library View
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#form-upload-demo');

    console.log('Uploading de_cache .dem.bz2...');
    await page.setInputFiles('#input-demo-file', path.resolve(CACHE_DEMO_BZ2));
    await page.click('#btn-upload-demo');
    await page.waitForSelector('.status-banner.ok', { timeout: 30000 });
    await page.waitForSelector('[data-demo-row]');

    console.log('Indexing de_nuke .dem...');
    await page.fill('#input-demo-path', path.resolve(NUKE_DEMO_PATH));
    await page.click('#btn-register-demo');
    await page.waitForFunction(() => document.querySelectorAll('[data-demo-row]').length === 2, null, { timeout: 45000 });

    await page.selectOption('#select-map-filter', 'de_nuke');
    await page.waitForFunction(() => document.querySelectorAll('[data-demo-row]').length === 1);
    await page.selectOption('#select-map-filter', '');
    await page.waitForFunction(() => document.querySelectorAll('[data-demo-row]').length === 2);

    await page.screenshot({ path: path.join(RENDERS_DIR, '01-library.png') });

    // 2. Open de_cache in 3D Replay Viewer
    console.log('Opening de_cache in 3D viewer...');
    const cacheOpenBtn = page.locator('[data-demo-row]', { hasText: 'de_cache' }).locator('[data-open-demo]');
    const cacheDemoId = await cacheOpenBtn.getAttribute('data-open-demo');
    await cacheOpenBtn.click();

    await page.waitForSelector('#three-stage canvas', { timeout: 20000 });
    await page.waitForFunction(
      () =>
        window.__CS2_VIEWER__ &&
        window.__CS2_VIEWER__.mapSource === 'custom_glb' &&
        window.__CS2_VIEWER__.glbShading === 'textured' &&
        window.__CS2_VIEWER__.skyboxActive === true &&
        window.__CS2_VIEWER__.hasRealOperators === true &&
        window.__CS2_VIEWER__.loadedWeaponModels >= 10 &&
        window.__CS2_VIEWER__.alivePlayers === 10,
      null,
      { timeout: 45000 }
    );

    const hintHeight = await page.evaluate(() => document.querySelector('.cam-toolbar-hdr .shortcuts-hint')?.getBoundingClientRect().height || 0);
    assert.ok(hintHeight > 0 && hintHeight < 22, `Expected single-line hint, got ${hintHeight}px`);
    await page.waitForTimeout(200);
    await assertTagsAndHudClean(page, '02-viewer-tactical');
    await page.screenshot({ path: path.join(RENDERS_DIR, '02-viewer-tactical.png') });
    await page.keyboard.press('F3');
    await page.waitForFunction(() => {
      const panel = document.getElementById('render-diagnostics');
      return !panel.hidden && /FPS.*ms\/frame.*draw calls.*triangles/.test(panel.textContent);
    });
    const diagnostics = await page.evaluate(() => ({
      warning: !document.getElementById('software-renderer-warning').hidden,
      software: window.__CS2_VIEWER__.softwareRenderer,
      renderer: window.__CS2_VIEWER__.rendererName,
    }));
    assert.equal(diagnostics.warning, diagnostics.software);
    assert.ok(diagnostics.renderer);
    await page.screenshot({ path: path.join(RENDERS_DIR, '20-render-diagnostics.png') });
    await page.keyboard.press('F3');
    assert.ok(await page.locator('#render-diagnostics').isHidden());
    await assertOccludedOutlinePixels(page);
    await assertOperatorsAcrossHalftime(page, BASE_URL, cacheDemoId);

    // Sweep 25 combat ticks across de_cache active round and verify zero nameplate overlaps + weapon-hand attachment
    const combatSweep = await page.evaluate(() => {
      const s = window.__CS2_SCENE__;
      const rr = s.roundReplay;
      const sc = document.getElementById('timeline-scrubber');
      const v1 = s.camera.position.clone();
      const v2 = s.camera.position.clone();
      let maxHandWeapErr = 0;
      const checkedWeapons = new Set();
      let worstCombatTick = rr.frames[Math.floor(rr.frames.length * 0.45)]?.t ?? rr.frames[0].t;
      const step = Math.max(1, Math.floor(rr.frames.length / 25));
      for (let i = 0; i < rr.frames.length; i += step) {
        sc.value = String(rr.frames[i].t);
        sc.dispatchEvent(new Event('input', { bubbles: true }));
        s.scene.updateMatrixWorld(true);
        for (const rig of s.playerRigs) {
          if (!rig.root.visible || !rig.bones?.hand_R || !rig.worldWeaponGroup.visible) continue;
          if (rig.currentWorldWeaponKey) checkedWeapons.add(rig.currentWorldWeaponKey);
          rig.bones.hand_R.getWorldPosition(v1);
          if (rig.bones.finger_middle_0_R) {
            rig.bones.finger_middle_0_R.getWorldPosition(v2);
            v1.lerp(v2, 0.52);
          }
          rig.worldWeaponGroup.getWorldPosition(v2);
          const d = v1.distanceTo(v2);
          if (d > maxHandWeapErr) maxHandWeapErr = d;
        }
      }
      sc.value = String(worstCombatTick);
      sc.dispatchEvent(new Event('input', { bubbles: true }));
      return { maxHandWeapErr: +maxHandWeapErr.toFixed(3), checkedWeapons: [...checkedWeapons] };
    });
    assert.ok(combatSweep.maxHandWeapErr < 0.25, `Weapon must stay locked to hand_R palm, max error=${combatSweep.maxHandWeapErr}`);
    await page.waitForTimeout(150);
    await assertTagsAndHudClean(page, '13-cache-combat-tactical');
    await page.screenshot({ path: path.join(RENDERS_DIR, '13-cache-combat-tactical.png') });

    // 3. Scan de_cache rounds for: multi-smoke + inferno, active HE + inferno, peak flash, and sniper scope
    const demoDetail = await (await fetch(`${BASE_URL}/api/demos/${cacheDemoId}`)).json();
    let smokeRound = null;
    let smokeFocus = null;
    let heMollyTarget = null;
    let flashTarget = null;
    let scopeTarget = null;

    for (const r of demoDetail.rounds) {
      const rr = await (await fetch(`${BASE_URL}/api/demos/${cacheDemoId}/rounds/${r.round_number}`)).json();
      if (!smokeRound && rr.smokes?.length >= 2) {
        // Prefer an outdoor smoke (e.g. A site / Mid on de_cache where y > 200 so no indoor roof blocks Tactical view)
        const sm = rr.smokes.find((x) => x.position && x.position[1] > 200) || rr.smokes[0];
        const midTick = Math.round((sm.start_tick + sm.end_tick) / 2);
        const overlappingSmokes = rr.smokes.filter((s) => midTick >= s.start_tick && midTick <= s.end_tick);
        if (overlappingSmokes.length >= 2 || rr.smokes.length >= 3) {
          smokeRound = r.round_number;
          smokeFocus = { tick: midTick, pos: sm.position };
        }
      }
      if (!heMollyTarget && rr.grenades?.length && rr.infernos?.length) {
        for (const g of rr.grenades) {
          if (g.type === 'he' && g.det_tick > 0) {
            const inf = rr.infernos.find((x) => g.det_tick >= x.start_tick && (x.end_tick === 0 || g.det_tick <= x.end_tick));
            if (inf) {
              heMollyTarget = { round: r.round_number, tick: g.det_tick + 8, pos: g.position };
              break;
            }
          }
        }
      }
      if (!flashTarget || !scopeTarget) {
        for (const f of rr.frames) {
          for (let s = 0; s < f.p.length; s++) {
            const pl = f.p[s];
            if (!pl || pl[0] !== 1) continue;
            if (!flashTarget && pl[11] > 0.72) {
              flashTarget = { tick: f.t, slot: s, round: r.round_number };
            }
            const wName = pl[13] >= 0 ? rr.weapons[pl[13]] || '' : '';
            if (!scopeTarget && pl[10] > 0 && (wName.includes('AWP') || wName.includes('SSG'))) {
              scopeTarget = { tick: f.t, slot: s, round: r.round_number, weapon: wName };
            }
          }
          if (flashTarget && scopeTarget) break;
        }
      }
    }

    assert.ok(smokeRound && smokeFocus, 'Found round with multiple active smokes');
    assert.ok(flashTarget, 'Found high-intensity flashbang tick');
    assert.ok(scopeTarget, 'Found sniper scope tick');
    assert.ok(heMollyTarget, 'Found simultaneous HE + Molotov/Inferno tick');

    // 4. Switch to smoke action round, verify header sync, frame active smokes in Tactical Orbit, capture 03
    console.log(`Switching to smoke round ${smokeRound} (tick=${smokeFocus.tick})...`);
    await page.click(`.round-pill[data-round="${smokeRound}"]`);
    await page.waitForFunction((rNum) => document.getElementById('match-scoreboard-strip')?.textContent.includes(`Round ${rNum}/`), smokeRound);

    await page.evaluate(({ tick, pos }) => {
      const s = window.__CS2_SCENE__;
      const sc = document.getElementById('timeline-scrubber');
      sc.value = String(tick);
      sc.dispatchEvent(new Event('input', { bubbles: true }));
      s.setCameraMode('free');
      // Place free cam slightly east-north-east and higher so the full ~144u smoke volume sits cleanly centered without roof crop
      s.freePos.set(pos[0] + 290, pos[2] + 150, -pos[1] - 240);
      const dx = pos[0] - s.freePos.x;
      const dy = (pos[2] + 40) - s.freePos.y;
      const dz = -pos[1] - s.freePos.z;
      s.freeYaw = Math.atan2(-dx, -dz);
      s.freePitch = Math.atan2(dy, Math.hypot(dx, dz));
    }, smokeFocus);
    await page.waitForFunction(() => window.__CS2_VIEWER__.activeSmokes > 0, null, { timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTagsAndHudClean(page, '03-viewer-smoke-action');
    await page.screenshot({ path: path.join(RENDERS_DIR, '03-viewer-smoke-action.png') });
    await page.click('[data-cam-mode="tactical"]');

    // 5. Test -1t / +1t stepping and Play/Pause
    const t0 = await page.evaluate(() => window.__CS2_VIEWER__.currentTick);
    await page.click('#btn-step-fwd-1');
    await page.waitForFunction((prev) => window.__CS2_VIEWER__.currentTick === prev + 1, t0);
    await page.click('#btn-step-back-1');
    await page.waitForFunction((prev) => window.__CS2_VIEWER__.currentTick === prev, t0);

    // 6. Test 5v5 Tab Scoreboard clearly showing both Round Score and Match Final
    await page.keyboard.press('Tab');
    await page.waitForSelector('#modal-scoreboard');
    const sbText = await page.locator('#modal-scoreboard').innerText();
    assert.ok(sbText.includes('Match Final') && sbText.includes(`Round ${smokeRound}`), `Scoreboard must clarify Round vs Match Final, got: ${sbText.slice(0, 180)}`);
    await page.screenshot({ path: path.join(RENDERS_DIR, '06-scoreboard-tab.png') });
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => !document.getElementById('modal-scoreboard'));

    // 7. Test 1st-Person POV + Observer Flash Meter + 1:1 CS2 Blind + POV->Free Cam right on active flash tick
    await page.click(`.round-pill[data-round="${flashTarget.round}"]`);
    await page.waitForFunction((rNum) => document.getElementById('match-scoreboard-strip')?.textContent.includes(`Round ${rNum}/`), flashTarget.round);
    await page.click(`#hud-player-${flashTarget.slot}`);
    await page.waitForFunction((s) => window.__CS2_VIEWER__.cameraMode === 'pov' && window.__CS2_VIEWER__.povSlot === s, flashTarget.slot);
    await page.evaluate((t) => {
      const sc = document.getElementById('timeline-scrubber');
      sc.value = String(t);
      sc.dispatchEvent(new Event('input', { bubbles: true }));
    }, flashTarget.tick);
    await page.waitForFunction(() => {
      const m = document.getElementById('flash-meter');
      const hud = document.getElementById('pov-bottom-hud');
      return m && m.style.display !== 'none' && hud && hud.style.display !== 'none';
    });
    const expectedName = demoDetail.players.find((p) => p.slot === flashTarget.slot)?.name;
    const meterText = await page.locator('#flash-meter-text').innerText();
    assert.ok(meterText.includes(expectedName), `Flash meter "${meterText}" must match slot ${flashTarget.slot} "${expectedName}"`);
    await page.waitForTimeout(150);
    await assertTagsAndHudClean(page, '04-viewer-pov');
    await page.screenshot({ path: path.join(RENDERS_DIR, '04-viewer-pov.png') });

    // Capture 1:1 CS2 Blind white screen at active flash tick
    await page.click('#btn-blind-mode');
    await page.waitForFunction(() => parseFloat(document.getElementById('flash-blind-full')?.style.opacity || '0') > 0.55);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(RENDERS_DIR, '10-viewer-blind-cs2.png') });

    // Switch POV -> Free Cam RIGHT ON THE ACTIVE FLASH TICK (no tick change!) and assert flash overlays clear immediately
    const flashTickCheck = await page.evaluate(() => window.__CS2_VIEWER__.currentTick);
    await page.click('[data-cam-mode="free"]');
    await page.waitForFunction((expectedTick) => {
      const v = window.__CS2_VIEWER__;
      const m = document.getElementById('flash-meter');
      const vig = document.getElementById('flash-vignette');
      const bf = document.getElementById('flash-blind-full');
      return (
        v.cameraMode === 'free' &&
        v.currentTick === expectedTick &&
        m.style.display === 'none' &&
        parseFloat(vig.style.opacity || '0') === 0 &&
        parseFloat(bf.style.opacity || '0') === 0
      );
    }, flashTickCheck);

    // Move slightly with WASD in Free Cam and capture 05
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(300);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(150);
    await assertTagsAndHudClean(page, '05-viewer-freecam');
    await page.screenshot({ path: path.join(RENDERS_DIR, '05-viewer-freecam.png') });
    await page.click('#btn-blind-mode'); // reset blind mode to observer

    // 8. Capture 09: sniper scope overlay and projected world FOV.
    await page.click(`.round-pill[data-round="${scopeTarget.round}"]`);
    await page.waitForFunction((rNum) => document.getElementById('match-scoreboard-strip')?.textContent.includes(`Round ${rNum}/`), scopeTarget.round);
    await page.click(`#hud-player-${scopeTarget.slot}`);
    await page.evaluate((t) => {
      const sc = document.getElementById('timeline-scrubber');
      sc.value = String(t);
      sc.dispatchEvent(new Event('input', { bubbles: true }));
    }, scopeTarget.tick);
    await page.waitForFunction(() => {
      const sc = document.getElementById('sniper-scope-overlay');
      return sc && sc.style.display === 'block';
    });
    const scope = await page.evaluate(({ tick, slot }) => {
      const s = window.__CS2_SCENE__;
      const p = s.roundReplay.frames.find((f) => f.t >= tick)?.p[slot];
      return { fov: s.camera.fov, weapon: s.roundReplay.weapons[p[13]], zoom: p[10], viewmodelVisible: s.viewModelGroup.visible };
    }, scopeTarget);
    assert.equal(scope.fov, cs2FovToVertical(povCameraFov(scope.weapon, scope.zoom)));
    assert.equal(scope.viewmodelVisible, false);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(RENDERS_DIR, '09-viewer-scope.png') });

    // 9. Capture 11: Active HE explosion + Molotov/Inferno
    await page.click('[data-cam-mode="tactical"]');
    await page.click(`.round-pill[data-round="${heMollyTarget.round}"]`);
    await page.waitForFunction((rNum) => document.getElementById('match-scoreboard-strip')?.textContent.includes(`Round ${rNum}/`), heMollyTarget.round);
    await page.evaluate(({ tick, pos }) => {
      const sc = document.getElementById('timeline-scrubber');
      sc.value = String(tick);
      sc.dispatchEvent(new Event('input', { bubbles: true }));
      window.__CS2_SCENE__.focusWorldPoint(pos[0], pos[1], pos[2], 700);
    }, heMollyTarget);
    await page.waitForFunction(() => window.__CS2_VIEWER__.activeGrenades > 0 && window.__CS2_VIEWER__.activeInfernos > 0);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(RENDERS_DIR, '11-viewer-he-molotov.png') });

    // 10. Bookmark persistence & header sync
    const bmTick = await page.evaluate(() => window.__CS2_VIEWER__.currentTick);
    const bmRoundText = await page.locator('#match-scoreboard-strip').innerText();
    await page.fill('#input-bm-label', 'HE + Molly Action');
    await page.fill('#input-bm-note', 'E2E verified');
    await page.click('#btn-save-bookmark');
    await page.waitForSelector('.bookmark-item');

    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-demo-row]', { hasText: 'de_cache' }).locator('[data-open-demo]').click();
    await page.waitForFunction(() => window.__CS2_VIEWER__?.mapSource === 'custom_glb', null, { timeout: 35000 });
    await page.waitForSelector('.bookmark-item', { timeout: 20000 });
    await page.locator('[data-jump-bm]').first().click();
    await page.waitForFunction((expectedTick) => Math.abs((window.__CS2_VIEWER__?.currentTick ?? -1) - expectedTick) <= 2, bmTick);
    assert.equal(await page.locator('#match-scoreboard-strip').innerText(), bmRoundText);

    // 11. Real de_nuke.glb (official CS2 PBR textures) + Real de_nuke_radar.png + CT/T Operators + POV weapon + close-up
    console.log('Testing de_nuke.glb real CS2 textures, operators, weapons, and radar...');
    await page.click('#btn-back-library');
    const nukeOpenBtn = page.locator('[data-demo-row]', { hasText: 'de_nuke' }).locator('[data-open-demo]');
    const nukeDemoId = await nukeOpenBtn.getAttribute('data-open-demo');
    await nukeOpenBtn.click();
    await page.waitForFunction(
      () =>
        window.__CS2_VIEWER__ &&
        window.__CS2_VIEWER__.mapSource === 'custom_glb' &&
        window.__CS2_VIEWER__.glbTransform === 'ry+90' &&
        window.__CS2_VIEWER__.glbShading === 'textured' &&
        window.__CS2_VIEWER__.skyboxActive === true &&
        window.__CS2_VIEWER__.hasRealOperators === true &&
        window.__CS2_VIEWER__.loadedWeaponModels >= 10 &&
        window.__CS2_VIEWER__.alivePlayers >= 8 &&
        window.__CS2_SCENE__?.roundReplay?.frames?.length > 0,
      null,
      { timeout: 45000 }
    );
    await page.waitForTimeout(350);
    await assertTagsAndHudClean(page, '07-nuke-glb-tactical');
    await page.screenshot({ path: path.join(RENDERS_DIR, '07-nuke-glb-tactical.png') });
    await assertOperatorsAcrossHalftime(page, BASE_URL, nukeDemoId);
    const spawnAim = await page.evaluate(() => {
      const s = window.__CS2_SCENE__;
      const rig = s.playerRigs.find((r) => r.isRealOperator && r.root.visible && r.bones?.spine_1);
      const names = ['spine_1', 'spine_2', 'head_0', 'wpnPivot'];
      const pose = () => names.map((n) => rig.bones[n].quaternion.clone().normalize());
      const sample = (pitchDeg) => s._poseOperatorSkeleton(rig, { pitchDeg, weaponKey: 'ak47', weaponCat: 'rifle' });
      const delta = (a, b) => Math.max(...a.map((q, i) => q.angleTo(b[i])));
      sample(0);
      const neutral = pose();
      sample(25);
      const pitched = pose();
      s.playing = true;
      for (let i = 0; i < 48; i++) sample(25);
      const drift = delta(pitched, pose());
      sample(0);
      s.playing = false;
      return { drift, returned: delta(neutral, pose()), pitch: delta(neutral, pitched) };
    });
    assert.ok(spawnAim.pitch > 0.1 && spawnAim.drift < 1e-5 && spawnAim.returned < 1e-5, JSON.stringify(spawnAim));

    // Capture 14 on Round 1: Isolated standing pistol grip close-up (Glock / USP)
    await page.evaluate(() => {
      const s = window.__CS2_SCENE__;
      const rr = s.roundReplay;
      let pistolFrame = null;
      let pistolPlayer = null;
      let bestSep = -1;
      for (let i = Math.floor((rr.frames?.length || 0) * 0.15); i < rr.frames.length; i += 3) {
        const f = rr.frames[i];
        for (const x of f?.p || []) {
          if (!x || x[0] !== 1 || (x[9] || 0) > 0.1) continue;
          const wn = x[13] >= 0 ? rr.weapons[x[13]] || '' : '';
          if (!/glock|usp|p250|deagle/i.test(wn)) continue;
          let minSep = Infinity;
          for (const o of f.p) {
            if (!o || o === x || o[0] !== 1) continue;
            minSep = Math.min(minSep, Math.hypot(o[2] - x[2], o[3] - x[3], o[4] - x[4]));
          }
          if (minSep > bestSep) {
            bestSep = minSep;
            pistolFrame = f;
            pistolPlayer = x;
            if (minSep >= 180) break;
          }
        }
        if (bestSep >= 180) break;
      }
      if (pistolFrame && pistolPlayer) {
        const sc = document.getElementById('timeline-scrubber');
        sc.value = String(pistolFrame.t);
        sc.dispatchEvent(new Event('input', { bubbles: true }));
        s.focusOperatorCloseUp(pistolPlayer[2], pistolPlayer[3], pistolPlayer[4], pistolPlayer[5], 58);
      }
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(RENDERS_DIR, '14-pistol-grip-closeup.png') });

    // Switch to POV pistol on Round 1 (08-nuke-glb-pov.png) so both rifle POV (04) and pistol POV (08) are verified
    const nukePovTarget = await page.evaluate(() => {
      const rr = window.__CS2_SCENE__.roundReplay;
      const startIdx = Math.floor(rr.frames.length * 0.15);
      const endIdx = Math.floor(rr.frames.length * 0.65);
      for (let i = startIdx; i < endIdx; i++) {
        const f = rr.frames[i];
        for (let s = 0; s < f.p.length; s++) {
          const pl = f.p[s];
          if (!pl || pl[0] !== 1 || (pl[11] || 0) > 0.05) continue;
          const wName = pl[13] >= 0 ? rr.weapons[pl[13]] || '' : '';
          if (/glock|usp|p250|deagle|five-seven|tec-9/i.test(wName)) {
            return { slot: s, tick: f.t, weapon: wName };
          }
        }
      }
      return { slot: 0, tick: rr.frames[Math.floor(rr.frames.length * 0.25)]?.t ?? rr.frames[0].t, weapon: '' };
    });
    await page.click(`#hud-player-${nukePovTarget.slot}`);
    await page.waitForFunction((s) => window.__CS2_VIEWER__.cameraMode === 'pov' && window.__CS2_VIEWER__.povSlot === s, nukePovTarget.slot);
    await page.evaluate((t) => {
      const sc = document.getElementById('timeline-scrubber');
      sc.value = String(t);
      sc.dispatchEvent(new Event('input', { bubbles: true }));
    }, nukePovTarget.tick);
    await page.waitForTimeout(350);
    const povChecks = await page.evaluate(() => {
      const s = window.__CS2_SCENE__;
      return {
        vmKey: window.__CS2_VIEWER__.activeViewModelKey,
        vmRealVisible: !!s.vmRealContainer?.visible && s.vmRealContainer.children.length > 0,
        povArmsVisible: !!(s.povArmsRigs?.ct?.clone?.visible || s.povArmsRigs?.t?.clone?.visible),
      };
    });
    assert.ok(povChecks.vmKey && povChecks.vmKey !== 'none', `Expected real POV weapon view-model key, got: ${povChecks.vmKey}`);
    assert.ok(povChecks.vmRealVisible, 'Expected real weapon GLB visible in 1st-person POV');
    assert.ok(povChecks.povArmsVisible, 'Expected real operator first-person arms/gloves visible in 1st-person POV');
    await page.screenshot({ path: path.join(RENDERS_DIR, '08-nuke-glb-pov.png') });

    // Switch to a buy round (e.g. Round 4) if present so 12-operators-weapons-closeup shows an unobstructed two-handed rifle
    if (await page.locator('.round-pill[data-round="4"]').count()) {
      await page.click('.round-pill[data-round="4"]');
      await page.waitForFunction(() => document.getElementById('match-scoreboard-strip')?.textContent.includes('Round 4/'));
    }

    // Free Cam close-up of an isolated CT/T operator holding a rifle on de_nuke
    await page.evaluate(() => {
      const rr = window.__CS2_SCENE__.roundReplay;
      let targetFrame = rr?.frames?.[0];
      let p0 = targetFrame?.p?.find((x) => x && x[0] === 1 && x[1] === 3) || targetFrame?.p?.[0];
      let bestSep = -1;
      const startScan = Math.floor((rr?.frames?.length || 0) * 0.2);
      const maxScan = Math.floor((rr?.frames?.length || 0) * 0.75);
      for (let i = startScan; i < maxScan; i += 4) {
        const f = rr.frames[i];
        for (const x of f?.p || []) {
          if (!x || x[0] !== 1) continue;
          const wn = x[13] >= 0 ? rr.weapons[x[13]] || '' : '';
          if (!/ak|m4|famas|galil|mp9|mac|ump/i.test(wn)) continue;
          let minSep = Infinity;
          for (const o of f.p) {
            if (!o || o === x || o[0] !== 1) continue;
            minSep = Math.min(minSep, Math.hypot(o[2] - x[2], o[3] - x[3], o[4] - x[4]));
          }
          if (minSep > bestSep) {
            bestSep = minSep;
            targetFrame = f;
            p0 = x;
            if (minSep >= 220) break;
          }
        }
        if (bestSep >= 220) break;
      }
      if (targetFrame) {
        const sc = document.getElementById('timeline-scrubber');
        sc.value = String(targetFrame.t);
        sc.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (p0) {
        window.__CS2_SCENE__.focusOperatorCloseUp(p0[2], p0[3], p0[4], p0[5], 64);
      }
    });
    await page.waitForTimeout(250);
    const qualityStats = {};
    for (const q of ['medium', 'low', 'high']) {
      await page.selectOption('#select-quality', q);
      await page.waitForTimeout(180);
      qualityStats[q] = await page.evaluate(() => {
        const s = window.__CS2_SCENE__;
        return {
          active: window.__CS2_VIEWER__.activeQuality,
          calls: window.__CS2_VIEWER__.drawCalls,
          tris: window.__CS2_VIEWER__.triangles,
          shadowEnabled: !!s.renderer.shadowMap.enabled,
          shadowSize: s.sunLight.shadow.mapSize.x,
        };
      });
    }
    assert.equal(qualityStats.high.shadowSize, 2048, 'High preset must use 2048px shadows');
    assert.equal(qualityStats.medium.shadowSize, 512, 'Medium preset must use 512px shadows');
    assert.equal(qualityStats.low.shadowEnabled, false, 'Low preset must disable shadow map');
    assert.ok(
      qualityStats.medium.tris < qualityStats.high.tris,
      `Medium tris (${qualityStats.medium.tris}) should be lower than High (${qualityStats.high.tris})`
    );
    assert.ok(
      qualityStats.low.calls < qualityStats.medium.calls,
      `Low draw calls (${qualityStats.low.calls}) should be lower than Medium (${qualityStats.medium.calls})`
    );

    const renderMetrics = await page.evaluate(async () => {
      const s = window.__CS2_SCENE__;
      let frames = 0;
      const t0 = performance.now();
      const fps = await new Promise((resolve) => {
        function step() {
          frames++;
          if (performance.now() - t0 >= 800) resolve(Math.round(frames / 0.8));
          else requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
      return {
        shadowEnabled: !!s.renderer.shadowMap.enabled,
        fps,
        calls: s.renderer.info.render.calls,
        tris: s.renderer.info.render.triangles,
        skyUniforms: !!s.skyDome?.material?.uniforms?.sunPosition,
        skyboxActive: !!s.skyboxTexture,
      };
    });
    console.log('de_nuke render metrics:', { renderMetrics, qualityStats });
    assert.ok(renderMetrics.shadowEnabled, 'Directional sun shadow map must be enabled');
    assert.ok(renderMetrics.skyboxActive, 'Real CS2 skybox texture must be active');
    assert.ok(renderMetrics.fps >= 30, `Expected >= 30 FPS in headless Chrome, got ${renderMetrics.fps}`);
    await page.screenshot({ path: path.join(RENDERS_DIR, '12-operators-weapons-closeup.png') });

    // 11b. Atomic POV switching across 5 slots + POV weapon close-ups (AK, M4, AWP, Knife) + >=3.2s Deathcam
    const povAtomic = await page.evaluate(() => {
      const s = window.__CS2_SCENE__;
      const rr = s.roundReplay;
      const midFrame = rr.frames[Math.floor(rr.frames.length * 0.2)];
      const sc = document.getElementById('timeline-scrubber');
      sc.value = String(midFrame.t);
      sc.dispatchEvent(new Event('input', { bubbles: true }));
      const errs = [];
      for (let slot = 0; slot < 5; slot++) {
        if (!midFrame.p[slot] || midFrame.p[slot][0] !== 1) continue;
        s.setCameraMode('pov', slot);
        const rig = s.rigBySlot.get(slot);
        if (rig.root.visible) errs.push(`slot ${slot} rig.root remained visible on synchronous switch`);
        if (rig.worldWeaponGroup.visible || rig.root.userData.outlined) errs.push(`slot ${slot} POV extras remained visible on switch`);
      }
      return { errs, animCount: s.operatorClips?.size || 0, viewModelFov: s.vmCamera.fov };
    });
    assert.deepEqual(povAtomic.errs, [], `Atomic POV hide errors: ${povAtomic.errs.join(', ')}`);
    assert.ok(povAtomic.animCount >= 200, `Expected >=200 CS2 clips loaded, got ${povAtomic.animCount}`);
    assert.equal(povAtomic.viewModelFov, cs2FovToVertical(VIEWMODEL_FOV));

    // Scan de_nuke Round 4 for isolated AK-47, M4, AWP, Knife POV frames + a kill with an alive teammate for >=3.2s deathcam
    const povSamples = await page.evaluate(() => {
      const s = window.__CS2_SCENE__;
      const rr = s.roundReplay;
      const out = { ak: null, m4: null, awp: null, knife: null, death: null };
      const bestSep = { ak: -1, m4: -1, awp: -1, knife: -1 };
      for (let i = Math.floor(rr.frames.length * 0.08); i < rr.frames.length; i += 2) {
        const f = rr.frames[i];
        for (let slot = 0; slot < f.p.length; slot++) {
          const pl = f.p[slot];
          if (!pl || pl[0] !== 1 || (pl[11] || 0) > 0.05) continue;
          const wn = pl[13] >= 0 ? (rr.weapons[pl[13]] || '') : '';
          let minSep = Infinity;
          for (const o of f.p) {
            if (!o || o === pl || o[0] !== 1) continue;
            minSep = Math.min(minSep, Math.hypot(o[2] - pl[2], o[3] - pl[3], o[4] - pl[4]));
          }
          if (/ak-?47/i.test(wn) && minSep > bestSep.ak) { bestSep.ak = minSep; out.ak = { slot, tick: f.t, wn }; }
          if (/m4a/i.test(wn) && minSep > bestSep.m4) { bestSep.m4 = minSep; out.m4 = { slot, tick: f.t, wn }; }
          if (/awp/i.test(wn) && (pl[10] || 0) === 0 && minSep > bestSep.awp) { bestSep.awp = minSep; out.awp = { slot, tick: f.t, wn }; }
          if (/knife|bayonet|karambit/i.test(wn) && minSep > bestSep.knife) { bestSep.knife = minSep; out.knife = { slot, tick: f.t, wn }; }
        }
      }
      // Find first kill where victim's team still has >=1 alive teammate 3.5s later
      const rate = rr.tick_rate || 64;
      for (const k of rr.kills || []) {
        if (typeof k.victim_slot !== 'number') continue;
        const postTick = k.tick + Math.round(3.5 * rate);
        const postFrame = rr.frames.find((x) => x.t >= postTick);
        if (!postFrame) continue;
        const hasMate = postFrame.p.some((pl, sl) => pl && pl[0] === 1 && pl[1] === k.victim_team && sl !== k.victim_slot);
        if (hasMate) {
          out.death = {
            victimSlot: k.victim_slot,
            victimTeam: k.victim_team,
            killerSlot: k.killer_slot,
            killTick: k.tick,
            midDeathTick: k.tick + Math.round(1.1 * rate),
            postDeathTick: k.tick + Math.round(3.5 * rate),
          };
          break;
        }
      }
      return out;
    });

    for (const [label, sample, fname] of [
      ['AK-47', povSamples.ak, '15-pov-ak47.png'],
      ['M4', povSamples.m4, '16-pov-m4.png'],
      ['AWP', povSamples.awp, '17-pov-awp.png'],
      ['Knife', povSamples.knife, '18-pov-knife.png'],
    ]) {
      if (!sample) continue;
      await page.evaluate(({ slot, tick }) => {
        const sc = document.getElementById('timeline-scrubber');
        sc.value = String(tick);
        sc.dispatchEvent(new Event('input', { bubbles: true }));
        window.__CS2_SCENE__.setCameraMode('pov', slot);
      }, sample);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(RENDERS_DIR, fname) });
    }

    if (povSamples.death) {
      // Enter POV on victim right before kill, then step to +1.1s (must stay on dead victim in deathcam!)
      await page.evaluate((d) => {
        const sc = document.getElementById('timeline-scrubber');
        sc.value = String(Math.max(0, d.killTick - 8));
        sc.dispatchEvent(new Event('input', { bubbles: true }));
        window.__CS2_SCENE__.setCameraMode('pov', d.victimSlot);
        sc.value = String(d.midDeathTick);
        sc.dispatchEvent(new Event('input', { bubbles: true }));
      }, povSamples.death);
      await page.waitForTimeout(220);
      const midDeathCheck = await page.evaluate(() => ({
        povSlot: window.__CS2_VIEWER__.povSlot,
        camMode: window.__CS2_VIEWER__.cameraMode,
      }));
      assert.equal(midDeathCheck.povSlot, povSamples.death.victimSlot, 'Deathcam must remain on dead victim during >=3s window');
      await page.screenshot({ path: path.join(RENDERS_DIR, '19-deathcam-fall.png') });

      // Step past 3.2s -> must switch to an alive teammate, NEVER the killer
      await page.evaluate((d) => {
        const sc = document.getElementById('timeline-scrubber');
        sc.value = String(d.postDeathTick);
        sc.dispatchEvent(new Event('input', { bubbles: true }));
      }, povSamples.death);
      await page.waitForTimeout(200);
      const postDeathCheck = await page.evaluate(() => {
        const s = window.__CS2_SCENE__;
        const v = window.__CS2_VIEWER__;
        const f = s.roundReplay.frames.find((x) => x.t >= v.currentTick) || s.roundReplay.frames[s.roundReplay.frames.length - 1];
        const pl = f?.p?.[v.povSlot];
        return { povSlot: v.povSlot, camMode: v.cameraMode, alive: pl?.[0] === 1, team: pl?.[1] };
      });
      assert.notEqual(postDeathCheck.povSlot, povSamples.death.killerSlot, 'Must never switch to killer');
      assert.equal(postDeathCheck.team, povSamples.death.victimTeam, 'Must switch to alive teammate');
      assert.equal(postDeathCheck.alive, true, 'Auto-switched teammate must be alive');
    }

    // 12. Delete de_nuke from Library & verify persistence
    await page.click('#btn-back-library');
    await page.waitForFunction(() => document.querySelectorAll('[data-demo-row]').length === 2);
    await page.locator('[data-demo-row]', { hasText: 'de_nuke' }).locator('[data-delete-demo]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-demo-row]').length === 1);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('[data-demo-row]').length === 1);

    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
    assert.deepEqual(failedApiResponses, [], `Unexpected 5xx API responses: ${failedApiResponses.join('; ')}`);
    console.log('All real Chrome E2E checks PASSED.');
  } catch (err) {
    console.error('E2E test failed:', err);
    try {
      const dbg = await browser?.contexts()?.[0]?.pages()?.[0]?.evaluate(() => ({
        viewer: window.__CS2_VIEWER__,
        hasScene: !!window.__CS2_SCENE__,
        hasReplay: !!window.__CS2_SCENE__?.roundReplay,
      }));
      console.error('Debug viewer state:', dbg);
    } catch {}
    console.error('Server logs:\n', serverLogs);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    serverProc.kill('SIGTERM');
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
}

run();
