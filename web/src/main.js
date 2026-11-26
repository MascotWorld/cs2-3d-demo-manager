import './styles.css';
import { api } from './api.js';
import { DemoScene } from './viewer/scene.js';
import { RadarRenderer } from './viewer/radar.js';
import { DemoAudio } from './viewer/audio.js';
import {
  formatClock,
  computeRoundClock,
  isSniperWeapon,
  unpackUtilityCounts,
} from './viewer/math.js';
import {
  weaponSvgIcon,
  hpCrossIcon,
  armorIcon,
  defuseKitIcon,
  skullIcon,
  headshotIcon,
} from './viewer/icons.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

const state = {
  view: 'library', // 'library' | 'viewer'
  health: null,
  demos: [],
  searchQuery: '',
  mapFilter: '',
  statusBanner: null, // { type: 'ok'|'error'|'info', text: string }
  busy: false,

  // Active match state
  activeDemo: null, // { metadata, players, rounds, kills, bookmarks }
  activeRoundNum: 1,
  roundCache: new Map(),
  roundReplay: null,
  radarData: null,
  cameraMode: 'tactical',
  povSlot: 0,
  xray: true,
  showTracers: true,
  blindMode: 'observer', // 'observer' | 'cs2'
  audioEnabled: false,
  playbackSpeed: 1,
  qualitySetting: 'auto', // 'auto' | 'high' | 'medium' | 'low'
  activeQuality: 'high',
  showRenderDiagnostics: false,
  showBookmarks: true,
  showCrosshairConfig: false,
  crosshair: {
    color: '#22c55e',
    size: 7,
    gap: 3,
    thickness: 2,
    dot: false,
  },
  showScoreboardModal: false,
  showAssetsModal: false,
  lastHudTick: -1,
  lastHudCamKey: '',
};

let sceneInstance = null;
let radarInstance = null;
const audioInstance = new DemoAudio();
const root = document.getElementById('app');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setBanner(type, text) {
  state.statusBanner = text ? { type, text } : null;
  renderStatusBanner();
}

function renderStatusBanner() {
  const el = document.getElementById('status-banner-slot');
  if (!el) return;
  if (!state.statusBanner) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="status-banner ${esc(state.statusBanner.type)}">${esc(state.statusBanner.text)}</div>`;
}

async function refreshHealthAndDemos() {
  const [health, list] = await Promise.all([
    api.health(),
    api.listDemos(state.searchQuery, state.mapFilter),
  ]);
  state.health = health;
  state.demos = list.demos || [];
}

async function openDemoInViewer(id) {
  state.busy = true;
  setBanner('info', 'Loading match telemetry and 3D map geometry...');
  try {
    const detail = await api.getDemo(id);
    const health = await api.health();
    state.health = health;
    state.activeDemo = detail;
    state.roundCache.clear();
    const firstRound = detail.rounds?.[0]?.round_number || 1;
    state.activeRoundNum = firstRound;
    state.view = 'viewer';
    state.cameraMode = 'tactical';
    state.povSlot = detail.players?.[0]?.slot ?? 0;
    state.lastHudTick = -1;
    state.lastHudCamKey = '';

    render();
    await loadViewerMatchAssetsAndRound(firstRound);
  } catch (err) {
    state.view = 'library';
    render();
    setBanner('error', `Failed to open demo: ${err.message}`);
  } finally {
    state.busy = false;
  }
}

async function loadViewerMatchAssetsAndRound(roundNum) {
  if (!sceneInstance || !state.activeDemo) return;
  const demoId = state.activeDemo.metadata.id;
  const mapName = state.activeDemo.metadata.map_name;
  const customMaps = state.health?.custom_maps || [];
  const hasCustomMap = customMaps.includes(mapName);
  const skyboxes = state.health?.skyboxes || [];
  const skyKey = skyboxes.includes(mapName)
    ? mapName
    : skyboxes.includes('daylight01')
    ? 'daylight01'
    : null;
  const skyboxUrl = skyKey ? `/api/assets/skyboxes/${encodeURIComponent(skyKey)}` : null;

  const [meshBuffer, radarData, initialRoundReplay] = await Promise.all([
    api.fetchMapMesh(mapName),
    api.fetchMapRadar(mapName),
    fetchCachedRound(demoId, roundNum),
  ]);

  if (!sceneInstance || state.activeDemo?.metadata?.id !== demoId) return;

  state.radarData = radarData;
  if (radarInstance) {
    radarInstance.setRadarData(radarData);
  }

  await Promise.all([
    sceneInstance.loadMapGeometry(mapName, {
      customGlbUrl: hasCustomMap ? `/api/assets/maps/${encodeURIComponent(mapName)}` : null,
      meshBuffer,
      skyboxUrl,
    }),
    sceneInstance.loadOfficialAssets(state.health),
  ]);

  if (state.health?.has_custom_player) {
    await sceneInstance.loadCustomPlayerModel('/api/assets/player');
  } else {
    await sceneInstance.loadCustomPlayerModel(null);
  }

  const targetRound = state.activeRoundNum;
  const roundReplay =
    targetRound === roundNum ? initialRoundReplay : await fetchCachedRound(demoId, targetRound);
  const preserveTick = targetRound !== roundNum ? sceneInstance.currentTick : null;

  state.roundReplay = roundReplay;
  audioInstance.resetRound();
  sceneInstance.setXray(state.xray);
  sceneInstance.setShowTracers(state.showTracers);
  sceneInstance.setRoundData(roundReplay, state.activeDemo.players);
  if (preserveTick !== null) {
    sceneInstance.currentTick = preserveTick;
  }
  sceneInstance.setCameraMode(state.cameraMode, state.povSlot);
  state.lastHudTick = -1;
  state.lastHudCamKey = '';
  renderTeamSideHudPanels();
  updateViewerControlsDOM();
}

async function fetchCachedRound(demoId, roundNum) {
  if (state.roundCache.has(roundNum)) {
    return state.roundCache.get(roundNum);
  }
  const rr = await api.getRound(demoId, roundNum);
  state.roundCache.set(roundNum, rr);
  return rr;
}

async function switchRound(roundNum) {
  if (!state.activeDemo || !sceneInstance) return;
  state.activeRoundNum = roundNum;
  sceneInstance.playing = false;
  audioInstance.resetRound();
  const rr = await fetchCachedRound(state.activeDemo.metadata.id, roundNum);
  state.roundReplay = rr;
  sceneInstance.setRoundData(rr, state.activeDemo.players);
  state.lastHudTick = -1;
  state.lastHudCamKey = '';
  renderTeamSideHudPanels();
  updateViewerControlsDOM();
}

function getRoundTeamForPlayer(player, rr) {
  const f0 = rr?.frames?.[0]?.p;
  if (f0 && f0[player.slot] && (f0[player.slot][1] === 2 || f0[player.slot][1] === 3)) {
    return f0[player.slot][1];
  }
  return player.start_team || player.team || 3;
}

function renderTeamSideHudPanels() {
  const d = state.activeDemo;
  if (!d) return;
  const ctEl = document.getElementById('team-hud-ct');
  const tEl = document.getElementById('team-hud-t');
  if (!ctEl || !tEl) return;

  const ctPlayers = [];
  const tPlayers = [];
  for (const p of d.players) {
    if (getRoundTeamForPlayer(p, state.roundReplay) === 3) ctPlayers.push(p);
    else tPlayers.push(p);
  }

  const rowHtml = (p, isCT) => `
    <div class="hud-player-row ${isCT ? 'team-ct' : 'team-t'}" id="hud-player-${p.slot}" data-pov-slot="${p.slot}" title="${esc(p.name)}">
      <div class="hud-sq-top">
        <span class="hud-sq-slot">${(p.slot + 1) % 10}</span>
        <span class="hud-player-name">${esc(p.name)}</span>
        <span class="hud-player-meta">$${0}</span>
      </div>
      <div class="hud-sq-mid">
        <span class="hud-player-weapon"></span>
        <span class="hud-sq-gear"></span>
      </div>
      <div class="hud-sq-bot">
        <span class="mono hud-hp-num ${isCT ? 'score-ct' : 'score-t'}">100</span>
        <div class="hp-track"><div class="hud-hp-fill ${isCT ? 'hp-fill-ct' : 'hp-fill-t'}" style="width:100%;"></div></div>
      </div>
    </div>
  `;

  ctEl.innerHTML = ctPlayers.map((p) => rowHtml(p, true)).join('');
  tEl.innerHTML = tPlayers.map((p) => rowHtml(p, false)).join('');

  document.querySelectorAll('[data-pov-slot]').forEach((el) => {
    el.addEventListener('click', () => {
      const slot = Number(el.dataset.povSlot);
      state.cameraMode = 'pov';
      state.povSlot = slot;
      sceneInstance?.setCameraMode('pov', slot);
      state.lastHudCamKey = '';
      updateViewerControlsDOM();
    });
  });
}

function updateMatchHeaderScoreboard() {
  const strip = document.getElementById('match-scoreboard-strip');
  const ctScoreEl = document.getElementById('hud-score-ct');
  const tScoreEl = document.getElementById('hud-score-t');
  if (!state.activeDemo) return;
  const d = state.activeDemo;
  const meta = d.metadata;
  const roundSummary =
    d.rounds.find((r) => r.round_number === state.activeRoundNum) ||
    state.roundReplay?.summary ||
    d.rounds[0];

  const ctScore = roundSummary ? roundSummary.score_ct : meta.score_ct;
  const tScore = roundSummary ? roundSummary.score_t : meta.score_t;
  if (ctScoreEl) ctScoreEl.textContent = String(ctScore);
  if (tScoreEl) tScoreEl.textContent = String(tScore);
  if (strip) {
    strip.innerHTML = `
      <span>Round ${state.activeRoundNum}/${d.rounds.length}</span>
      ${roundSummary?.win_reason ? `<span class="muted">· ${esc(roundSummary.win_reason)}</span>` : ''}
    `;
  }
}

function applyCrosshairDOM() {
  const xh = document.getElementById('pov-crosshair');
  if (!xh) return;
  const cfg = state.crosshair;
  xh.style.color = cfg.color;
  const t = cfg.thickness;
  const s = cfg.size;
  const g = cfg.gap;
  xh.innerHTML = `
    <div class="xh-line" style="left:${-g - s}px; top:${-t / 2}px; width:${s}px; height:${t}px;"></div>
    <div class="xh-line" style="left:${g}px; top:${-t / 2}px; width:${s}px; height:${t}px;"></div>
    <div class="xh-line" style="left:${-t / 2}px; top:${-g - s}px; width:${t}px; height:${s}px;"></div>
    <div class="xh-line" style="left:${-t / 2}px; top:${g}px; width:${t}px; height:${s}px;"></div>
    ${cfg.dot ? `<div class="xh-dot" style="width:${t}px; height:${t}px;"></div>` : ''}
  `;
}

function updateViewerControlsDOM() {
  if (state.view !== 'viewer' || !state.activeDemo) return;

  updateMatchHeaderScoreboard();
  applyCrosshairDOM();

  document.querySelectorAll('.round-pill').forEach((btn) => {
    const r = Number(btn.dataset.round);
    btn.classList.toggle('active', r === state.activeRoundNum);
  });

  const scrubber = document.getElementById('timeline-scrubber');
  const markersEl = document.getElementById('scrubber-markers');
  const rr = state.roundReplay;
  if (scrubber && rr?.frames?.length) {
    const minT = rr.frames[0].t;
    const maxT = rr.frames[rr.frames.length - 1].t;
    scrubber.min = String(minT);
    scrubber.max = String(maxT);
    scrubber.value = String(Math.round(sceneInstance?.currentTick || minT));

    if (markersEl) {
      const span = Math.max(1, maxT - minT);
      const markers = [];
      const freezeEnd = rr.summary?.freeze_end_tick;
      if (freezeEnd > minT && freezeEnd < maxT) {
        const pct = ((freezeEnd - minT) / span) * 100;
        markers.push(
          `<div class="timeline-marker marker-freeze" style="left:${pct}%" title="Freeze End (tick ${freezeEnd})" data-tick="${freezeEnd}"></div>`
        );
      }
      for (const k of rr.kills || []) {
        const pct = Math.max(0, Math.min(100, ((k.tick - minT) / span) * 100));
        const cls = k.killer_team === 3 ? 'marker-kill-ct' : 'marker-kill-t';
        markers.push(
          `<div class="timeline-marker ${cls}" style="left:${pct}%" title="${esc(k.killer_name)} [${esc(k.weapon)}] ${esc(k.victim_name)} (tick ${k.tick})" data-tick="${k.tick}"></div>`
        );
      }
      for (const be of rr.bomb_events || []) {
        if (!['planted', 'defused', 'exploded'].includes(be.type)) continue;
        const pct = Math.max(0, Math.min(100, ((be.tick - minT) / span) * 100));
        markers.push(
          `<div class="timeline-marker marker-bomb" style="left:${pct}%" title="Bomb ${esc(be.type)} ${esc(be.site || '')} (tick ${be.tick})" data-tick="${be.tick}"></div>`
        );
      }
      for (const bm of state.activeDemo.bookmarks || []) {
        if (bm.round_number !== state.activeRoundNum) continue;
        const pct = Math.max(0, Math.min(100, ((bm.tick - minT) / span) * 100));
        markers.push(
          `<div class="timeline-marker marker-bookmark" style="left:${pct}%" title="Bookmark: ${esc(bm.label)} (tick ${bm.tick})" data-tick="${bm.tick}"></div>`
        );
      }
      markersEl.innerHTML = markers.join('');
      markersEl.querySelectorAll('.timeline-marker').forEach((m) => {
        m.addEventListener('click', (e) => {
          e.stopPropagation();
          const t = Number(m.dataset.tick);
          if (sceneInstance && !Number.isNaN(t)) {
            sceneInstance.currentTick = t;
          }
        });
      });
    }
  }

  document.querySelectorAll('[data-cam-mode]').forEach((b) => {
    b.classList.toggle('btn-active', b.dataset.camMode === state.cameraMode);
  });
  const xrayBtn = document.getElementById('btn-xray');
  if (xrayBtn) xrayBtn.classList.toggle('btn-active', state.xray);
  const tracersBtn = document.getElementById('btn-tracers');
  if (tracersBtn) tracersBtn.classList.toggle('btn-active', state.showTracers);
  const blindBtn = document.getElementById('btn-blind-mode');
  if (blindBtn) {
    blindBtn.textContent = state.blindMode === 'cs2' ? 'Blind: 1:1 CS2' : 'Blind: Observer';
    blindBtn.classList.toggle('btn-active', state.blindMode === 'cs2');
  }
  const audioBtn = document.getElementById('btn-audio-toggle');
  if (audioBtn) {
    audioBtn.textContent = state.audioEnabled ? 'Audio: On' : 'Audio: Off';
    audioBtn.classList.toggle('btn-active', state.audioEnabled);
  }
  const qSel = document.getElementById('select-quality');
  if (qSel && qSel.value !== state.qualitySetting) {
    qSel.value = state.qualitySetting;
  }
  const qBadge = document.getElementById('quality-active-badge');
  if (qBadge) {
    const label = state.activeQuality.toUpperCase();
    qBadge.textContent = state.qualitySetting === 'auto' ? `AUTO · ${label}` : label;
  }
  const bmToggleBtn = document.getElementById('btn-toggle-bookmarks');
  if (bmToggleBtn) {
    bmToggleBtn.textContent = `Bookmarks (${(state.activeDemo.bookmarks || []).length})`;
    bmToggleBtn.classList.toggle('btn-active', state.showBookmarks);
  }

  const mapBadge = document.getElementById('map-source-badge');
  if (mapBadge && sceneInstance) {
    const src = sceneInstance.mapBounds.source;
    const tris = sceneInstance.mapBounds.triCount;
    mapBadge.textContent =
      src === 'custom_glb'
        ? `GLB (${(tris / 1000).toFixed(0)}k tris)`
        : src === 'csgeo1'
        ? `CSGEO1 (${(tris / 1000).toFixed(0)}k tris)`
        : 'Grid Only';
  }

  renderBookmarksPanel();
}

function updateLiveFrameHUD(snapshot, currentTick, playing) {
  const playBtn = document.getElementById('btn-play');
  if (playBtn) {
    playBtn.textContent = playing ? 'Pause' : 'Play';
  }

  const scrubber = document.getElementById('timeline-scrubber');
  if (scrubber && document.activeElement !== scrubber) {
    scrubber.value = String(Math.round(currentTick));
  }

  const rr = state.roundReplay;
  const tickRate = rr?.tick_rate || 64;
  const minT = rr?.frames?.[0]?.t || 0;
  const maxT = rr?.frames?.[rr.frames.length - 1]?.t || minT;
  const tickEl = document.getElementById('hud-tick-label');
  if (tickEl) {
    const elapsed = (currentTick - minT) / tickRate;
    const total = (maxT - minT) / tickRate;
    tickEl.textContent = `Tick ${Math.round(currentTick)} · ${formatClock(elapsed)} / ${formatClock(total)}`;
  }

  // Render 2D Radar on every animation frame for smooth dot/cone tracking
  if (radarInstance && snapshot) {
    radarInstance.render({
      snapshot,
      roundReplay: rr,
      currentTick,
      povSlot: state.povSlot,
      cameraMode: state.cameraMode,
      mapBounds: sceneInstance?.mapBounds,
      cameraWorldZ: sceneInstance?.camera?.position?.y ?? null,
    });
  }

  const clockInfo = rr ? computeRoundClock(rr, currentTick, tickRate) : null;
  if (clockInfo) {
    audioInstance.processTick({
      playing,
      roundReplay: rr,
      currentTick,
      clockInfo,
      povSlot: state.povSlot,
      cameraMode: state.cameraMode,
    });
  }

  // Round Clock + Bomb Plant/Defuse Bar
  const clockBox = document.getElementById('round-clock-box');
  const clockText = document.getElementById('round-clock-text');
  const clockPhase = document.getElementById('round-clock-phase');
  const actionBar = document.getElementById('bomb-action-bar');
  const actionText = document.getElementById('bomb-action-text');
  const actionFill = document.getElementById('bomb-action-fill');
  if (clockBox && clockText && clockPhase && clockInfo) {
    clockBox.classList.toggle('planted', clockInfo.phase === 'planted');
    clockBox.classList.toggle('freeze', clockInfo.phase === 'freeze');
    if (clockInfo.phase === 'planted') {
      clockPhase.textContent = clockInfo.site ? `C4 [${clockInfo.site}]` : 'C4 PLANTED';
      clockText.textContent = clockInfo.clockText;
    } else if (clockInfo.phase === 'freeze') {
      clockPhase.textContent = 'FREEZE';
      clockText.textContent = clockInfo.clockText;
    } else if (clockInfo.phase === 'defused' || clockInfo.phase === 'exploded') {
      clockPhase.textContent = 'BOMB';
      clockText.textContent = clockInfo.clockText;
    } else {
      clockPhase.textContent = 'LIVE';
      clockText.textContent = clockInfo.clockText;
    }

    if (actionBar && actionText && actionFill) {
      if (clockInfo.action) {
        actionBar.style.display = 'flex';
        const act = clockInfo.action;
        const label =
          act.type === 'defusing'
            ? `DEFUSING ${act.hasKit ? '(KIT 5s)' : '(NO KIT 10s)'} · ${act.secondsLeft.toFixed(1)}s`
            : `PLANTING C4 · ${act.secondsLeft.toFixed(1)}s`;
        actionText.textContent = label;
        actionFill.className = `bomb-action-fill ${act.type}`;
        actionFill.style.width = `${Math.round(act.progress * 100)}%`;
      } else {
        actionBar.style.display = 'none';
      }
    }
  }

  // Throttle heavy DOM updates only when tick AND camera mode/slot/blind mode haven't changed
  const rounded = Math.round(currentTick);
  const camKey = `${state.cameraMode}:${state.povSlot}:${state.blindMode}`;
  if (rounded === state.lastHudTick && camKey === state.lastHudCamKey) return;
  state.lastHudTick = rounded;
  state.lastHudCamKey = camKey;

  const weapons = rr?.weapons || [];
  const obsSlot = snapshot?.observedSlot ?? state.povSlot;
  const obs = state.cameraMode === 'pov' ? snapshot?.players?.[obsSlot] : null;
  const obsWeapon = obs && obs[13] >= 0 && weapons[obs[13]] ? weapons[obs[13]] : '';
  const obsZoom = obs ? obs[10] || 0 : 0;
  const sniperScoped = state.cameraMode === 'pov' && obs && obs[0] === 1 && isSniperWeapon(obsWeapon) && obsZoom > 0;

  // Crosshair & Sniper Scope overlay
  const xhEl = document.getElementById('pov-crosshair');
  const scopeEl = document.getElementById('sniper-scope-overlay');
  if (xhEl) {
    xhEl.style.display = state.cameraMode === 'pov' && obs && obs[0] === 1 && !sniperScoped ? 'block' : 'none';
  }
  if (scopeEl) {
    scopeEl.style.display = sniperScoped ? 'block' : 'none';
  }

  // Flashbang Overlay: STRICTLY only in 1st-person POV (`cameraMode === 'pov'`)
  const vig = document.getElementById('flash-vignette');
  const blindFull = document.getElementById('flash-blind-full');
  const meter = document.getElementById('flash-meter');
  const meterFill = document.getElementById('flash-meter-fill');
  const meterText = document.getElementById('flash-meter-text');
  const flashFrac = state.cameraMode === 'pov' && obs && obs[0] === 1 ? obs[11] || 0 : 0;
  const flashAlpha = state.cameraMode === 'pov' && obs && obs[0] === 1 ? obs[12] || 1 : 0;

  if (vig && blindFull && meter && meterFill && meterText) {
    if (flashFrac > 0.03) {
      const pct = Math.round(flashFrac * 100);
      const obsMeta = state.activeDemo?.players?.find((pl) => pl.slot === obsSlot);
      const obsName = obsMeta?.name || `Slot ${obsSlot + 1}`;
      if (state.blindMode === 'cs2') {
        blindFull.style.opacity = String(Math.min(0.98, flashFrac * Math.max(0.4, flashAlpha)));
        vig.style.opacity = '0';
        meter.style.display = 'none';
      } else {
        blindFull.style.opacity = '0';
        vig.style.opacity = String(Math.min(0.45, flashFrac * 0.45));
        meter.style.display = 'flex';
        meterFill.style.width = `${pct}%`;
        meterText.textContent = `FLASHED (${obsName}) ${pct}%`;
      }
    } else {
      blindFull.style.opacity = '0';
      vig.style.opacity = '0';
      meter.style.display = 'none';
    }
  }

  // Bottom POV HUD (1:1 CS2 HP + Armor left, Large Ammo + Weapon + Grenade Icons right)
  const povHud = document.getElementById('pov-bottom-hud');
  if (povHud) {
    if (state.cameraMode === 'pov' && obs && obs[0] === 1 && !snapshot?.deathCamActive) {
      const isCT = obs[1] === 3;
      const hp = Math.round(obs[7] || 0);
      const armor = Math.round(obs[8] || 0);
      const flags = obs[14] || 0;
      const hasHelm = (flags & 1) !== 0;
      const hasKit = (flags & 2) !== 0;
      const mag = obs[16] >= 0 ? Math.round(obs[16]) : null;
      const res = obs[17] >= 0 ? Math.round(obs[17]) : null;
      const util = unpackUtilityCounts(obs[19] || 0);
      const obsMeta = state.activeDemo?.players?.find((pl) => pl.slot === obsSlot);

      povHud.style.display = 'flex';
      povHud.classList.toggle('team-ct', isCT);
      povHud.classList.toggle('team-t', !isCT);
      povHud.classList.remove('deathcam-mode');
      const hpEl = document.getElementById('pov-hud-hp');
      const hpFillEl = document.getElementById('pov-hud-hp-fill');
      const arEl = document.getElementById('pov-hud-armor');
      const nameEl = document.getElementById('pov-hud-name');
      const wEl = document.getElementById('pov-hud-weapon');
      const ammoEl = document.getElementById('pov-hud-ammo');
      const utilEl = document.getElementById('pov-hud-util');
      if (hpEl) {
        hpEl.innerHTML = `${hpCrossIcon('pov-hp-cross')}<span>${hp}</span>`;
        hpEl.className = `pov-hp-big ${isCT ? 'score-ct' : 'score-t'}`;
      }
      if (hpFillEl) {
        hpFillEl.style.width = `${Math.max(0, Math.min(100, hp))}%`;
      }
      if (arEl) {
        arEl.innerHTML = `${armorIcon(hasHelm, 'pov-ar-ico')}<span>${armor}</span>${hasKit ? defuseKitIcon('pov-kit-ico') : ''}`;
      }
      if (nameEl) {
        nameEl.textContent = obsMeta?.name || `Player ${obsSlot + 1}`;
      }
      if (wEl) {
        wEl.innerHTML = `${weaponSvgIcon(obsWeapon, 'pov-w-svg')}<span>${esc(obsWeapon || 'Knife')}</span>`;
      }
      if (ammoEl) {
        ammoEl.innerHTML = mag !== null
          ? `<span class="ammo-mag">${mag}</span><span class="ammo-sep">/</span><span class="ammo-res">${res ?? 0}</span>`
          : `<span class="ammo-mag">—</span>`;
      }
      if (utilEl) {
        const chips = [];
        if (util.smoke) chips.push(`<span class="util-chip" title="Smoke">${weaponSvgIcon('smokegrenade', 'util-svg')}${util.smoke > 1 ? `×${util.smoke}` : ''}</span>`);
        if (util.flash) chips.push(`<span class="util-chip" title="Flashbang">${weaponSvgIcon('flashbang', 'util-svg')}${util.flash > 1 ? `×${util.flash}` : ''}</span>`);
        if (util.he) chips.push(`<span class="util-chip" title="HE Grenade">${weaponSvgIcon('hegrenade', 'util-svg')}</span>`);
        if (util.molly) chips.push(`<span class="util-chip" title="Molotov/Incendiary">${weaponSvgIcon('molotov', 'util-svg')}</span>`);
        if (util.decoy) chips.push(`<span class="util-chip" title="Decoy">${weaponSvgIcon('decoy', 'util-svg')}</span>`);
        if (util.c4) chips.push(`<span class="util-chip c4" title="C4">${weaponSvgIcon('c4', 'util-svg')}</span>`);
        utilEl.innerHTML = chips.join('');
      }
    } else if (state.cameraMode === 'pov' && snapshot?.deathCamActive) {
      const obsMeta = state.activeDemo?.players?.find((pl) => pl.slot === obsSlot);
      const killEv = (rr?.kills || []).find((k) => k.victim_slot === obsSlot && k.tick <= rounded);
      povHud.style.display = 'flex';
      povHud.classList.add('deathcam-mode');
      const hpEl = document.getElementById('pov-hud-hp');
      const hpFillEl = document.getElementById('pov-hud-hp-fill');
      const arEl = document.getElementById('pov-hud-armor');
      const nameEl = document.getElementById('pov-hud-name');
      const wEl = document.getElementById('pov-hud-weapon');
      const ammoEl = document.getElementById('pov-hud-ammo');
      const utilEl = document.getElementById('pov-hud-util');
      if (hpEl) {
        hpEl.innerHTML = `${skullIcon('pov-hp-cross')}<span>0</span>`;
        hpEl.className = 'pov-hp-big dead';
      }
      if (hpFillEl) hpFillEl.style.width = '0%';
      if (arEl) arEl.innerHTML = '';
      if (nameEl) nameEl.textContent = obsMeta?.name || `Player ${obsSlot + 1}`;
      if (wEl) {
        wEl.innerHTML = killEv
          ? `<span>KILLED BY ${esc(killEv.killer_name)}</span>`
          : `<span>ELIMINATED</span>`;
      }
      if (ammoEl) ammoEl.innerHTML = killEv ? weaponSvgIcon(killEv.weapon, 'pov-w-svg') : '';
      if (utilEl) utilEl.innerHTML = '';
    } else {
      povHud.style.display = 'none';
    }
  }

  // Top CS2 Player Squares indexed strictly by `player.slot`
  if (snapshot && state.activeDemo) {
    for (const player of state.activeDemo.players) {
      const slot = player.slot;
      const row = document.getElementById(`hud-player-${slot}`);
      if (!row) continue;
      const p = snapshot.players[slot];
      const alive = p && p[0] === 1;
      const hp = alive ? Math.round(p[7]) : 0;
      const armor = alive ? Math.round(p[8] || 0) : 0;
      const flags = p ? p[14] || 0 : 0;
      const hasKit = (flags & 2) !== 0;
      const hasHelm = (flags & 1) !== 0;
      const wIdx = p ? p[13] : -1;
      const weapon = wIdx >= 0 && weapons[wIdx] ? weapons[wIdx] : '';
      const flash = p ? p[11] || 0 : 0;
      const money = p && p.length > 15 ? Math.round(p[15] || 0) : 0;
      const rKills = p && p.length > 22 ? Math.round(p[22] || 0) : 0;

      row.classList.toggle('dead', !alive);
      row.classList.toggle('observed', state.cameraMode === 'pov' && obsSlot === slot);
      const hpEl = row.querySelector('.hud-hp-num');
      const fillEl = row.querySelector('.hud-hp-fill');
      const wEl = row.querySelector('.hud-player-weapon');
      const gearEl = row.querySelector('.hud-sq-gear');
      const metaEl = row.querySelector('.hud-player-meta');
      if (hpEl) {
        hpEl.innerHTML = alive ? String(hp) : skullIcon('sq-skull');
      }
      if (fillEl) fillEl.style.width = `${hp}%`;
      if (wEl) {
        wEl.innerHTML = alive
          ? `${weaponSvgIcon(weapon, 'sq-w-svg')}${flash > 0.15 ? '<span class="sq-blind-tag">⚡</span>' : ''}`
          : '';
        wEl.title = alive ? weapon : 'Dead';
      }
      if (gearEl) {
        gearEl.innerHTML = alive
          ? `${armor > 0 ? armorIcon(hasHelm, 'sq-gear-ico') : ''}${hasKit ? defuseKitIcon('sq-kit-ico') : ''}`
          : '';
      }
      if (metaEl) {
        metaEl.textContent = rKills > 0 ? `${rKills}K · $${money}` : `$${money}`;
      }
    }
  }

  // CS2 Killfeed around current tick (including flash assist, weapon silhouette SVG & modifiers)
  const kfEl = document.getElementById('killfeed-list');
  if (kfEl && rr) {
    const win = Math.round(6 * tickRate);
    const recent = (rr.kills || [])
      .filter((k) => k.tick <= rounded && rounded - k.tick <= win)
      .slice(-5);
    kfEl.innerHTML = recent
      .map((k) => {
        const isObsInvolved = state.cameraMode === 'pov' && (k.killer_slot === obsSlot || k.victim_slot === obsSlot);
        const assistHtml = k.assister_name
          ? `<span class="kf-assist">${k.assisted_flash ? '☀ ' : '+ '}${esc(k.assister_name)}</span>`
          : '';
        const badges = [
          k.headshot ? `<span class="kf-badge hs" title="Headshot">${headshotIcon('kf-hs-svg')}</span>` : '',
          k.wallbang ? '<span class="kf-badge">WB</span>' : '',
          k.through_smoke ? '<span class="kf-badge">SMK</span>' : '',
          k.no_scope ? '<span class="kf-badge">NS</span>' : '',
          k.attacker_blind ? '<span class="kf-badge">BLIND</span>' : '',
        ].join('');
        return `<div class="killfeed-item ${isObsInvolved ? 'kf-highlight' : ''}">
          <span class="kf-killer">
            <span class="${k.killer_team === 3 ? 'score-ct' : 'score-t'}">${esc(k.killer_name)}</span>
            ${assistHtml}
          </span>
          <span class="kf-weapon-cell" title="${esc(k.weapon)}">${weaponSvgIcon(k.weapon, 'kf-w-svg')}${badges}</span>
          <span class="kf-victim ${k.victim_team === 3 ? 'score-ct' : 'score-t'}">${esc(k.victim_name)}</span>
        </div>`;
      })
      .join('');
  }
}

function renderBookmarksPanel() {
  const listEl = document.getElementById('bookmarks-list');
  if (!listEl || !state.activeDemo) return;
  const bms = state.activeDemo.bookmarks || [];
  if (bms.length === 0) {
    listEl.innerHTML = `<div class="muted" style="font-size:12px;">No bookmarks yet. Save the current tick for instant review.</div>`;
    return;
  }
  listEl.innerHTML = bms
    .map(
      (b) => `<div class="bookmark-item">
        <div style="cursor:pointer; flex:1; min-width:0;" data-jump-bm="${esc(b.id)}">
          <div style="font-weight:600; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(b.label)}</div>
          <div class="mono muted" style="font-size:11px;">R${b.round_number} · Tick ${b.tick} · ${esc(b.camera_mode || 'tactical')}${b.note ? ` · ${esc(b.note)}` : ''}</div>
        </div>
        <button class="btn btn-sm btn-danger" data-del-bm="${esc(b.id)}">×</button>
      </div>`
    )
    .join('');

  listEl.querySelectorAll('[data-jump-bm]').forEach((el) => {
    el.addEventListener('click', async () => {
      const bm = bms.find((x) => x.id === el.dataset.jumpBm);
      if (!bm) return;
      if (bm.round_number !== state.activeRoundNum) {
        await switchRound(bm.round_number);
      }
      if (sceneInstance) {
        sceneInstance.currentTick = bm.tick;
        state.cameraMode = bm.camera_mode || 'tactical';
        state.povSlot = typeof bm.player_slot === 'number' ? bm.player_slot : 0;
        sceneInstance.setCameraMode(state.cameraMode, state.povSlot);
        state.lastHudTick = -1;
        state.lastHudCamKey = '';
        updateViewerControlsDOM();
      }
    });
  });

  listEl.querySelectorAll('[data-del-bm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api.deleteBookmark(state.activeDemo.metadata.id, btn.dataset.delBm);
      state.activeDemo.bookmarks = state.activeDemo.bookmarks.filter((x) => x.id !== btn.dataset.delBm);
      updateViewerControlsDOM();
    });
  });
}

function renderTopbar() {
  const active = state.activeDemo?.metadata;
  return `
    <header class="topbar">
      <div class="row">
        <div class="brand">
          <span class="brand-badge">CS2 3D</span>
          <span>Demo Manager</span>
        </div>
        <div class="nav-tabs">
          <button class="btn btn-sm ${state.view === 'library' ? 'btn-active' : ''}" id="nav-library">Library</button>
          ${
            active
              ? `<button class="btn btn-sm ${state.view === 'viewer' ? 'btn-active' : ''}" id="nav-viewer">3D Replay: ${esc(active.map_name)} (${active.score_ct}:${active.score_t})</button>`
              : ''
          }
        </div>
      </div>
      <div class="row">
        <span class="muted mono" style="font-size:11px;">Geo: ${esc((state.health?.geo_maps || []).length)} · GLB: ${esc((state.health?.custom_maps || []).length)}</span>
        <button class="btn btn-sm" id="btn-open-assets">Local Maps &amp; .GLB</button>
      </div>
    </header>
  `;
}

function renderLibraryView() {
  const uniqueMaps = [...new Set(state.demos.map((d) => d.map_name))].sort();
  return `
    <main class="library-view">
      <div id="status-banner-slot"></div>
      <div class="intake-grid">
        <section class="card">
          <div class="card-title">Upload CS2 Demo (.dem / .dem.bz2)</div>
          <form id="form-upload-demo" class="row">
            <input class="input" type="file" id="input-demo-file" accept=".dem,.bz2,.dem.bz2" style="flex:1;" />
            <button class="btn btn-primary" type="submit" id="btn-upload-demo">Upload &amp; Parse</button>
          </form>
        </section>
        <section class="card">
          <div class="card-title">Index Local Demo Path</div>
          <form id="form-register-demo" class="row">
            <input class="input" type="text" id="input-demo-path" placeholder="/path/to/match.dem or .dem.bz2" style="flex:1;" />
            <button class="btn btn-primary" type="submit" id="btn-register-demo">Index Path</button>
          </form>
        </section>
      </div>

      <section class="card">
        <div class="filter-bar">
          <input class="input input-search" type="search" id="input-search" placeholder="Search by filename, map, or player name..." value="${esc(state.searchQuery)}" />
          <select class="input" id="select-map-filter">
            <option value="">All Maps</option>
            ${uniqueMaps
              .map((m) => `<option value="${esc(m)}" ${state.mapFilter === m ? 'selected' : ''}>${esc(m)}</option>`)
              .join('')}
          </select>
          <button class="btn" id="btn-refresh-demos">Refresh</button>
        </div>
      </section>

      <section class="demo-table-wrap">
        <table class="demo-table">
          <thead>
            <tr>
              <th>Match</th>
              <th>Map</th>
              <th>Score (CT:T)</th>
              <th>Rounds / Kills</th>
              <th>Duration</th>
              <th>Players</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              state.demos.length === 0
                ? `<tr><td colspan="7" class="muted" style="text-align:center; padding:28px;">No CS2 demos indexed yet. Upload a .dem/.dem.bz2 file or index a local path above.</td></tr>`
                : state.demos
                    .map(
                      (d) => `
                  <tr data-demo-row="${esc(d.id)}">
                    <td>
                      <div style="font-weight:600;">${esc(d.filename)}</div>
                      <div class="mono muted" style="font-size:11px;">${esc(d.format)} · ${Math.round(d.tick_rate)} tick · ${(d.file_size / (1024 * 1024)).toFixed(1)} MB</div>
                    </td>
                    <td><span class="map-pill">${esc(d.map_name)}</span></td>
                    <td>
                      <span class="score-pill"><span class="score-ct">${d.score_ct}</span> : <span class="score-t">${d.score_t}</span></span>
                    </td>
                    <td class="mono">${d.round_count}R · ${d.kill_count}K</td>
                    <td class="mono">${formatClock(d.duration_sec)}</td>
                    <td>
                      <div class="roster-chips">
                        ${(d.player_names || []).map((n) => `<span class="roster-chip">${esc(n)}</span>`).join('')}
                      </div>
                    </td>
                    <td>
                      <div class="row">
                        <button class="btn btn-primary btn-sm" data-open-demo="${esc(d.id)}">Open 3D Replay</button>
                        <button class="btn btn-danger btn-sm" data-delete-demo="${esc(d.id)}">Delete</button>
                      </div>
                    </td>
                  </tr>
                `
                    )
                    .join('')
            }
          </tbody>
        </table>
      </section>
    </main>
  `;
}

function renderViewerView() {
  const d = state.activeDemo;
  const meta = d.metadata;

  return `
    <main class="viewer-view">
      <div class="viewer-hud-top">
        <div class="row">
          <button class="btn btn-sm" id="btn-back-library">← Library</button>
          <span class="map-pill">${esc(meta.map_name)}</span>
          <span class="muted" style="font-weight:600;">${esc(meta.filename)}</span>
        </div>
        <div class="row">
          <span class="map-pill" id="map-source-badge">Loading...</span>
          <button class="btn btn-sm" id="btn-render-diagnostics" type="button" aria-controls="render-diagnostics" aria-expanded="false">Render stats [F3]</button>
          <button class="btn btn-sm" id="btn-scoreboard">Scoreboard [Tab]</button>
          <button class="btn btn-sm ${state.showBookmarks ? 'btn-active' : ''}" id="btn-toggle-bookmarks">Bookmarks (${(d.bookmarks || []).length})</button>
        </div>
      </div>

      <div class="software-renderer-warning" id="software-renderer-warning" role="status" hidden>
        <strong>Software rendering detected.</strong> In your browser’s System settings, enable graphics acceleration when available, then relaunch the browser.
      </div>
      <div class="stage-wrap">
        <div class="three-container" id="three-stage"></div>
        <pre class="render-diagnostics" id="render-diagnostics" aria-label="Renderer diagnostics" hidden></pre>
        <div class="tags-overlay" id="tags-overlay"></div>
        <div class="sniper-scope-overlay" id="sniper-scope-overlay"></div>
        <div class="pov-crosshair" id="pov-crosshair"></div>
        <div class="flash-vignette" id="flash-vignette"></div>
        <div class="flash-blind-full" id="flash-blind-full"></div>
        <div class="flash-meter" id="flash-meter">
          <span id="flash-meter-text">FLASHED</span>
          <div class="flash-meter-bar"><div class="flash-meter-fill" id="flash-meter-fill" style="width:0%"></div></div>
        </div>

        <div class="radar-box">
          <canvas id="radar-canvas" width="184" height="184"></canvas>
          <span class="radar-label">${esc(meta.map_name)}</span>
          <span class="radar-level-badge" id="radar-level-badge">UPPER</span>
        </div>

        <div class="round-clock-banner">
          <div class="round-clock-box" id="round-clock-box">
            <span class="cs2-team-score ct" id="hud-score-ct">0</span>
            <div class="cs2-clock-center">
              <span id="round-clock-text">1:55</span>
              <span class="cs2-clock-phase" id="round-clock-phase">LIVE</span>
            </div>
            <span class="cs2-team-score t" id="hud-score-t">0</span>
          </div>
          <div class="match-scoreboard-strip" id="match-scoreboard-strip"></div>
          <div class="bomb-action-bar" id="bomb-action-bar">
            <span id="bomb-action-text">DEFUSING</span>
            <div class="bomb-action-track"><div class="bomb-action-fill" id="bomb-action-fill" style="width:0%"></div></div>
          </div>
        </div>

        <div class="pov-bottom-hud" id="pov-bottom-hud">
          <div class="pov-left-wing">
            <div class="pov-stat-row">
              <span class="pov-hp-big" id="pov-hud-hp">100</span>
              <span class="pov-armor-tag" id="pov-hud-armor">100</span>
              <span class="pov-player-tag" id="pov-hud-name"></span>
            </div>
            <div class="pov-hp-bar"><div class="pov-hp-bar-fill" id="pov-hud-hp-fill" style="width:100%"></div></div>
          </div>
          <div class="pov-right-wing">
            <div class="pov-util-strip" id="pov-hud-util"></div>
            <div class="pov-weapon-ammo-row">
              <span class="pov-weapon-name" id="pov-hud-weapon">AK-47</span>
              <span class="pov-ammo-text" id="pov-hud-ammo">30 / 90</span>
            </div>
          </div>
        </div>

        <aside class="team-hud ct" id="team-hud-ct"></aside>
        <aside class="team-hud t" id="team-hud-t"></aside>

        <aside class="right-overlay">
          <div class="cam-toolbar">
            <div class="cam-toolbar-hdr">
              <span class="muted" style="font-size:11px; font-weight:600;">CAMERA &amp; OVERLAYS</span>
              <span class="shortcuts-hint">WASD Free · 1-0 POV · X X-Ray</span>
            </div>
            <div class="row">
              <button class="btn btn-sm" data-cam-mode="tactical" id="btn-cam-tactical" style="flex:1;">Tactical [T]</button>
              <button class="btn btn-sm" data-cam-mode="free" id="btn-cam-free" style="flex:1;">Free Cam [F]</button>
              <button class="btn btn-sm" data-cam-mode="pov" id="btn-cam-pov" style="flex:1;">1st POV</button>
            </div>
            <div class="row">
              <button class="btn btn-sm" id="btn-xray" style="flex:1;">X-Ray [X]</button>
              <button class="btn btn-sm" id="btn-tracers" style="flex:1;">Tracers</button>
              <button class="btn btn-sm" id="btn-reset-cam">Reset</button>
            </div>
            <div class="row">
              <button class="btn btn-sm" id="btn-blind-mode" style="flex:1;">Blind: Observer</button>
              <button class="btn btn-sm" id="btn-audio-toggle">Audio: Off</button>
              <button class="btn btn-sm ${state.showCrosshairConfig ? 'btn-active' : ''}" id="btn-crosshair-cfg">XH</button>
            </div>
            <div class="row">
              <span class="muted" style="font-size:11px;">Quality</span>
              <select class="input" id="select-quality" style="flex:1; padding:3px 6px; font-size:11px;">
                <option value="auto" ${state.qualitySetting === 'auto' ? 'selected' : ''}>Auto (FPS Guard)</option>
                <option value="high" ${state.qualitySetting === 'high' ? 'selected' : ''}>High (2048px Shadows)</option>
                <option value="medium" ${state.qualitySetting === 'medium' ? 'selected' : ''}>Medium (512px Shadows)</option>
                <option value="low" ${state.qualitySetting === 'low' ? 'selected' : ''}>Low (Fastest / No Shadows)</option>
              </select>
              <span class="map-pill" id="quality-active-badge" style="font-size:10px;">AUTO · HIGH</span>
            </div>
            <div id="crosshair-cfg-slot"></div>
          </div>

          <div class="killfeed" id="killfeed-list"></div>

          <div class="drawer-panel" id="bookmarks-drawer" style="display:${state.showBookmarks ? 'flex' : 'none'};">
            <div class="card-title" style="margin:0;">Tick Bookmarks</div>
            <form id="form-add-bookmark" class="bookmark-form-grid">
              <div class="bookmark-form-row">
                <input class="input" id="input-bm-label" type="text" placeholder="Label (e.g. AWP entry)" required />
                <button class="btn btn-primary btn-sm" type="submit" id="btn-save-bookmark">Save</button>
              </div>
              <div class="bookmark-form-row">
                <input class="input" id="input-bm-note" type="text" placeholder="Optional note" />
              </div>
            </form>
            <div id="bookmarks-list" style="display:flex; flex-direction:column; gap:5px;"></div>
          </div>
        </aside>
      </div>

      <footer class="timeline-bar">
        <div class="rounds-strip">
          ${d.rounds
            .map(
              (r) => `<button class="round-pill ${r.winner_team === 3 ? 'win-ct' : r.winner_team === 2 ? 'win-t' : ''} ${r.round_number === state.activeRoundNum ? 'active' : ''}" data-round="${r.round_number}" title="Round ${r.round_number}: ${esc(r.win_reason)}">R${r.round_number}</button>`
            )
            .join('')}
        </div>
        <div class="transport-row">
          <button class="btn btn-primary btn-sm" id="btn-play" style="min-width:64px;">Play</button>
          <button class="btn btn-sm" id="btn-step-back">-16t</button>
          <button class="btn btn-sm" id="btn-step-back-1">-1t</button>
          <button class="btn btn-sm" id="btn-step-fwd-1">+1t</button>
          <button class="btn btn-sm" id="btn-step-fwd">+16t</button>
          <select class="input" id="select-speed" style="padding:4px 8px;">
            ${SPEEDS.map((s) => `<option value="${s}" ${state.playbackSpeed === s ? 'selected' : ''}>${s}x</option>`).join('')}
          </select>
          <div class="scrubber-wrap">
            <div class="scrubber-markers" id="scrubber-markers"></div>
            <input class="scrubber-input" type="range" id="timeline-scrubber" min="0" max="100" value="0" />
          </div>
          <span class="mono muted" id="hud-tick-label" style="min-width:185px; text-align:right;">Tick 0 · 0:00 / 0:00</span>
        </div>
      </footer>
    </main>
  `;
}

function renderModals() {
  let html = '';
  if (state.showScoreboardModal && state.activeDemo) {
    const players = state.activeDemo.players || [];
    const rr = state.roundReplay;
    const f0 = rr?.frames?.[0]?.p;
    const snapPlayers = rr?.frames?.length
      ? rr.frames[Math.min(rr.frames.length - 1, Math.max(0, Math.floor((sceneInstance?.currentTick || rr.frames[0].t) - rr.frames[0].t)))]?.p
      : null;

    const ctList = [];
    const tList = [];
    for (const p of players) {
      const t = getRoundTeamForPlayer(p, rr);
      if (t === 3) ctList.push(p);
      else tList.push(p);
    }

    const renderTeamTable = (title, cls, list, curScore, finalScore) => `
      <div class="sb-team-hdr ${cls}">
        <span>${title}</span>
        <span>Round ${state.activeRoundNum}: ${curScore} · Match Final: ${finalScore}</span>
      </div>
      <table class="demo-table">
        <thead>
          <tr><th>Player</th><th>Status</th><th>K</th><th>A</th><th>D</th><th>HS%</th><th>ADR</th><th>DMG</th><th>$</th><th>EQ</th></tr>
        </thead>
        <tbody>
          ${list
            .map((p) => {
              const live = snapPlayers?.[p.slot] || f0?.[p.slot];
              const alive = live ? live[0] === 1 : true;
              const hp = live && live[0] === 1 ? Math.round(live[7]) : 0;
              const money = live && live.length > 15 ? Math.round(live[15] || 0) : 0;
              const eqVal = live && live.length > 18 ? Math.round(live[18] || 0) : 0;
              return `<tr class="${alive ? '' : 'sb-row-dead'}">
                <td style="font-weight:600;"><span class="muted mono">[${(p.slot + 1) % 10}]</span> ${esc(p.name)}</td>
                <td class="mono">${alive ? `${hp} HP` : 'DEAD'}</td>
                <td class="mono">${p.kills}</td>
                <td class="mono">${p.assists}</td>
                <td class="mono">${p.deaths}</td>
                <td class="mono">${p.hs_pct.toFixed(0)}%</td>
                <td class="mono">${p.adr.toFixed(1)}</td>
                <td class="mono">${p.damage}</td>
                <td class="mono">$${money}</td>
                <td class="mono">$${eqVal}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    `;

    const roundSum =
      state.activeDemo.rounds.find((r) => r.round_number === state.activeRoundNum) || rr?.summary;
    const curCT = roundSum ? roundSum.score_ct : state.activeDemo.metadata.score_ct;
    const curT = roundSum ? roundSum.score_t : state.activeDemo.metadata.score_t;

    html += `
      <div class="modal-backdrop" id="modal-scoreboard">
        <div class="modal-card scoreboard-card">
          <div class="card-title">
            <span>5v5 Scoreboard · ${esc(state.activeDemo.metadata.map_name)} · Round ${state.activeRoundNum} (${curCT}:${curT}) · Match Final (${state.activeDemo.metadata.score_ct}:${state.activeDemo.metadata.score_t})</span>
            <button class="btn btn-sm" id="btn-close-scoreboard">Close [Tab]</button>
          </div>
          ${renderTeamTable('COUNTER-TERRORISTS', 'ct', ctList, curCT, state.activeDemo.metadata.score_ct)}
          ${renderTeamTable('TERRORISTS', 't', tList, curT, state.activeDemo.metadata.score_t)}
        </div>
      </div>
    `;
  }

  if (state.showAssetsModal) {
    const activeMap = state.activeDemo?.metadata?.map_name || 'de_nuke';
    const customMaps = state.health?.custom_maps || [];
    const assetDirs = state.health?.asset_dirs || [];
    const hasCustomPlayer = !!state.health?.has_custom_player;
    html += `
      <div class="modal-backdrop" id="modal-assets">
        <div class="modal-card">
          <div class="card-title">
            <span>Local Map Folders &amp; .GLB Assets</span>
            <button class="btn btn-sm" id="btn-close-assets">Close</button>
          </div>
          <p class="muted" style="margin:0;">Built-in CSGEO1 geometry and 2D radar contours render automatically. Locally extracted official CS2 assets (${(state.health?.player_models || []).filter((x) => x !== 'custom_player').length} operators, ${(state.health?.weapon_models || []).length} weapons/grenades/C4, ${customMaps.length} textured map GLBs) load automatically when present in <code>data/assets/</code>.</p>
          <div class="card">
            <div class="card-title">Register Local Map/Radar Folder</div>
            <form id="form-add-asset-dir" class="row">
              <input class="input" id="input-asset-dir" type="text" placeholder="/path/to/cs2-local-maps" style="flex:1;" />
              <button class="btn btn-primary btn-sm" type="submit">Add Folder</button>
            </form>
            ${
              assetDirs.length
                ? `<div class="row" style="margin-top:8px; flex-wrap:wrap;">${assetDirs
                    .map(
                      (dir) => `<span class="map-pill">${esc(dir)} <button class="btn btn-sm btn-danger" data-del-asset-dir="${esc(dir)}" style="padding:0 4px;">×</button></span>`
                    )
                    .join('')}</div>`
                : ''
            }
          </div>
          <div class="card">
            <div class="card-title">Upload Custom Map Mesh (.glb)</div>
            <form id="form-upload-map-glb" class="row">
              <input class="input" id="input-asset-map-name" type="text" value="${esc(activeMap)}" placeholder="de_nuke" style="width:140px;" />
              <input class="input" id="input-asset-map-file" type="file" accept=".glb" style="flex:1;" />
              <button class="btn btn-primary btn-sm" type="submit">Upload Map GLB</button>
            </form>
            ${
              customMaps.length
                ? `<div class="row" style="margin-top:8px; flex-wrap:wrap;">Available .glb maps: ${customMaps
                    .map(
                      (m) => `<span class="map-pill">${esc(m)} <button class="btn btn-sm btn-danger" data-del-map-asset="${esc(m)}" style="padding:0 4px;">×</button></span>`
                    )
                    .join('')}</div>`
                : ''
            }
          </div>
          <div class="card">
            <div class="card-title">Custom Player Model (.glb)</div>
            <form id="form-upload-player-glb" class="row">
              <input class="input" id="input-asset-player-file" type="file" accept=".glb" style="flex:1;" />
              <button class="btn btn-primary btn-sm" type="submit">Upload Player GLB</button>
              ${hasCustomPlayer ? `<button class="btn btn-danger btn-sm" type="button" id="btn-del-player-asset">Remove</button>` : ''}
            </form>
          </div>
        </div>
      </div>
    `;
  }
  return html;
}

function renderModalsDOM() {
  const slot = document.getElementById('modals-root');
  if (!slot) return;
  slot.innerHTML = renderModals();
  bindModalHandlers();
}

function render() {
  if (sceneInstance && state.view !== 'viewer') {
    sceneInstance.dispose();
    sceneInstance = null;
    radarInstance = null;
  }

  root.innerHTML = `
    <div class="app-shell">
      ${renderTopbar()}
      ${state.view === 'library' ? renderLibraryView() : renderViewerView()}
      <div id="modals-root"></div>
    </div>
  `;

  bindCommonHandlers();
  if (state.view === 'library') {
    renderStatusBanner();
    bindLibraryHandlers();
  } else {
    mountAndBindViewer();
  }
  renderModalsDOM();
}

function bindCommonHandlers() {
  document.getElementById('nav-library')?.addEventListener('click', async () => {
    state.view = 'library';
    await refreshHealthAndDemos();
    render();
  });
  document.getElementById('nav-viewer')?.addEventListener('click', async () => {
    if (state.activeDemo && state.view !== 'viewer') {
      state.view = 'viewer';
      render();
      await loadViewerMatchAssetsAndRound(state.activeRoundNum);
    }
  });
  document.getElementById('btn-open-assets')?.addEventListener('click', () => {
    state.showAssetsModal = true;
    renderModalsDOM();
  });
}

function bindLibraryHandlers() {
  document.getElementById('form-upload-demo')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('input-demo-file');
    const file = fileInput?.files?.[0];
    if (!file) {
      setBanner('error', 'Select a .dem or .dem.bz2 file first.');
      return;
    }
    setBanner('info', `Uploading and parsing ${file.name}...`);
    try {
      const res = await api.uploadDemo(file);
      await refreshHealthAndDemos();
      render();
      setBanner('ok', `Parsed ${res.demo.filename} (${res.demo.map_name}, ${res.demo.score_ct}:${res.demo.score_t}).`);
    } catch (err) {
      setBanner('error', `Upload failed: ${err.message}`);
    }
  });

  document.getElementById('form-register-demo')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = document.getElementById('input-demo-path')?.value?.trim();
    if (!path) {
      setBanner('error', 'Enter a local .dem or .dem.bz2 path.');
      return;
    }
    setBanner('info', `Indexing and parsing ${path}...`);
    try {
      const res = await api.registerDemo(path);
      await refreshHealthAndDemos();
      render();
      setBanner('ok', `Indexed ${res.demo.filename} (${res.demo.map_name}, ${res.demo.score_ct}:${res.demo.score_t}).`);
    } catch (err) {
      setBanner('error', `Index failed: ${err.message}`);
    }
  });

  let searchTimer = null;
  document.getElementById('input-search')?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      await refreshHealthAndDemos();
      render();
      const inp = document.getElementById('input-search');
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }, 180);
  });

  document.getElementById('select-map-filter')?.addEventListener('change', async (e) => {
    state.mapFilter = e.target.value;
    await refreshHealthAndDemos();
    render();
  });

  document.getElementById('btn-refresh-demos')?.addEventListener('click', async () => {
    await refreshHealthAndDemos();
    render();
  });

  document.querySelectorAll('[data-open-demo]').forEach((btn) => {
    btn.addEventListener('click', () => openDemoInViewer(btn.dataset.openDemo));
  });

  document.querySelectorAll('[data-delete-demo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteDemo;
      try {
        await api.deleteDemo(id);
        if (state.activeDemo?.metadata?.id === id) {
          state.activeDemo = null;
        }
        await refreshHealthAndDemos();
        render();
        setBanner('ok', 'Demo removed from library.');
      } catch (err) {
        setBanner('error', `Delete failed: ${err.message}`);
      }
    });
  });
}

function renderCrosshairConfigSlot() {
  const slot = document.getElementById('crosshair-cfg-slot');
  const btn = document.getElementById('btn-crosshair-cfg');
  if (btn) btn.classList.toggle('btn-active', state.showCrosshairConfig);
  if (!slot) return;
  if (!state.showCrosshairConfig) {
    slot.innerHTML = '';
    return;
  }
  slot.innerHTML = `<div class="row" style="padding-top:4px; border-top:1px solid var(--border); font-size:11px;">
    <label>Color <input type="color" id="xh-color" value="${esc(state.crosshair.color)}" style="width:24px; height:20px; padding:0; border:0; background:none;" /></label>
    <label>Len <input type="number" id="xh-size" min="2" max="16" value="${state.crosshair.size}" class="input" style="width:42px; padding:2px 4px;" /></label>
    <label>Gap <input type="number" id="xh-gap" min="0" max="12" value="${state.crosshair.gap}" class="input" style="width:42px; padding:2px 4px;" /></label>
    <label><input type="checkbox" id="xh-dot" ${state.crosshair.dot ? 'checked' : ''} /> Dot</label>
  </div>`;
  document.getElementById('xh-color')?.addEventListener('input', (e) => {
    state.crosshair.color = e.target.value;
    applyCrosshairDOM();
  });
  document.getElementById('xh-size')?.addEventListener('input', (e) => {
    state.crosshair.size = Math.max(2, Math.min(16, Number(e.target.value) || 6));
    applyCrosshairDOM();
  });
  document.getElementById('xh-gap')?.addEventListener('input', (e) => {
    state.crosshair.gap = Math.max(0, Math.min(12, Number(e.target.value) || 3));
    applyCrosshairDOM();
  });
  document.getElementById('xh-dot')?.addEventListener('change', (e) => {
    state.crosshair.dot = !!e.target.checked;
    applyCrosshairDOM();
  });
}

function mountAndBindViewer() {
  const stage = document.getElementById('three-stage');
  const overlay = document.getElementById('tags-overlay');
  const diagnostics = document.getElementById('render-diagnostics');
  const diagnosticsToggle = document.getElementById('btn-render-diagnostics');
  let lastDiagnosticsAt = -Infinity;
  const updateDiagnostics = () => {
    if (!state.showRenderDiagnostics) return;
    const v = window.__CS2_VIEWER__;
    const now = performance.now();
    if (!v || now - lastDiagnosticsAt < 250) return;
    lastDiagnosticsAt = now;
    const frameStats = v.frameMs ? `${v.fps} FPS · ${v.frameMs.toFixed(1)} ms/frame` : 'Sampling frame time…';
    diagnostics.textContent = `${v.rendererName}\n${frameStats} · ${v.drawCalls.toLocaleString()} draw calls · ${v.triangles.toLocaleString()} triangles`;
  };
  const setDiagnosticsVisible = (visible) => {
    state.showRenderDiagnostics = visible;
    diagnostics.hidden = !visible;
    diagnosticsToggle.setAttribute('aria-expanded', String(visible));
    lastDiagnosticsAt = -Infinity;
    updateDiagnostics();
  };
  const radarCanvas = document.getElementById('radar-canvas');
  if (radarCanvas) {
    radarInstance = new RadarRenderer(radarCanvas);
    if (state.radarData) radarInstance.setRadarData(state.radarData);
  }
  if (stage && !sceneInstance) {
    sceneInstance = new DemoScene(stage, overlay, {
      quality: state.qualitySetting,
      onCameraStateChange: ({ cameraMode, povSlot }) => {
        state.cameraMode = cameraMode;
        state.povSlot = povSlot;
        state.lastHudCamKey = '';
        updateViewerControlsDOM();
      },
      onFrameRender: (snapshot, currentTick, playing) => {
        updateLiveFrameHUD(snapshot, currentTick, playing);
        updateDiagnostics();
      },
      onQualityChange: ({ setting, active }) => {
        state.qualitySetting = setting;
        state.activeQuality = active;
        updateViewerControlsDOM();
      },
    });
    window.__CS2_SCENE__ = sceneInstance;
  }
  if (sceneInstance) {
    document.getElementById('software-renderer-warning').hidden = !sceneInstance.softwareRenderer;
    state.activeQuality = sceneInstance.activeQuality;
  }
  diagnosticsToggle.addEventListener('click', () => setDiagnosticsVisible(!state.showRenderDiagnostics));
  setDiagnosticsVisible(state.showRenderDiagnostics);

  renderTeamSideHudPanels();
  updateMatchHeaderScoreboard();
  applyCrosshairDOM();
  renderCrosshairConfigSlot();

  document.getElementById('btn-back-library')?.addEventListener('click', async () => {
    state.view = 'library';
    await refreshHealthAndDemos();
    render();
  });

  document.getElementById('btn-scoreboard')?.addEventListener('click', () => {
    state.showScoreboardModal = !state.showScoreboardModal;
    renderModalsDOM();
  });

  document.getElementById('btn-toggle-bookmarks')?.addEventListener('click', () => {
    state.showBookmarks = !state.showBookmarks;
    const drawer = document.getElementById('bookmarks-drawer');
    if (drawer) {
      drawer.style.display = state.showBookmarks ? 'flex' : 'none';
    }
    updateViewerControlsDOM();
  });

  document.querySelectorAll('[data-cam-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.camMode;
      state.cameraMode = mode;
      sceneInstance?.setCameraMode(mode, state.povSlot);
      state.lastHudCamKey = '';
      updateViewerControlsDOM();
    });
  });

  document.getElementById('btn-xray')?.addEventListener('click', () => {
    state.xray = !state.xray;
    sceneInstance?.setXray(state.xray);
    updateViewerControlsDOM();
  });

  document.getElementById('btn-tracers')?.addEventListener('click', () => {
    state.showTracers = !state.showTracers;
    sceneInstance?.setShowTracers(state.showTracers);
    updateViewerControlsDOM();
  });

  document.getElementById('btn-blind-mode')?.addEventListener('click', () => {
    state.blindMode = state.blindMode === 'observer' ? 'cs2' : 'observer';
    state.lastHudCamKey = '';
    updateViewerControlsDOM();
  });

  document.getElementById('btn-audio-toggle')?.addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    audioInstance.setEnabled(state.audioEnabled);
    updateViewerControlsDOM();
  });

  document.getElementById('select-quality')?.addEventListener('change', (e) => {
    const val = e.target.value || 'auto';
    state.qualitySetting = val;
    sceneInstance?.setQuality(val);
    updateViewerControlsDOM();
  });

  document.getElementById('btn-crosshair-cfg')?.addEventListener('click', () => {
    state.showCrosshairConfig = !state.showCrosshairConfig;
    renderCrosshairConfigSlot();
  });

  document.getElementById('btn-reset-cam')?.addEventListener('click', () => {
    sceneInstance?.resetTacticalCamera();
  });

  document.querySelectorAll('.round-pill').forEach((btn) => {
    btn.addEventListener('click', () => switchRound(Number(btn.dataset.round)));
  });

  document.getElementById('btn-play')?.addEventListener('click', () => {
    if (!sceneInstance || !state.roundReplay?.frames?.length) return;
    const maxT = state.roundReplay.frames[state.roundReplay.frames.length - 1].t;
    if (!sceneInstance.playing && sceneInstance.currentTick >= maxT - 1) {
      sceneInstance.currentTick = state.roundReplay.frames[0].t;
    }
    sceneInstance.playing = !sceneInstance.playing;
  });

  const stepTicks = (delta) => {
    if (!sceneInstance || !state.roundReplay?.frames?.length) return;
    const minT = state.roundReplay.frames[0].t;
    const maxT = state.roundReplay.frames[state.roundReplay.frames.length - 1].t;
    sceneInstance.playing = false;
    sceneInstance.currentTick = Math.max(minT, Math.min(maxT, sceneInstance.currentTick + delta));
  };

  document.getElementById('btn-step-back')?.addEventListener('click', () => stepTicks(-16));
  document.getElementById('btn-step-back-1')?.addEventListener('click', () => stepTicks(-1));
  document.getElementById('btn-step-fwd-1')?.addEventListener('click', () => stepTicks(1));
  document.getElementById('btn-step-fwd')?.addEventListener('click', () => stepTicks(16));

  document.getElementById('select-speed')?.addEventListener('change', (e) => {
    state.playbackSpeed = Number(e.target.value) || 1;
    if (sceneInstance) sceneInstance.playbackSpeed = state.playbackSpeed;
  });

  document.getElementById('timeline-scrubber')?.addEventListener('input', (e) => {
    if (!sceneInstance) return;
    sceneInstance.playing = false;
    sceneInstance.currentTick = Number(e.target.value);
  });

  document.getElementById('form-add-bookmark')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeDemo || !sceneInstance) return;
    const label = document.getElementById('input-bm-label')?.value?.trim();
    const note = document.getElementById('input-bm-note')?.value?.trim() || '';
    if (!label) return;
    const res = await api.createBookmark(state.activeDemo.metadata.id, {
      round_number: state.activeRoundNum,
      tick: Math.round(sceneInstance.currentTick),
      label,
      note,
      camera_mode: state.cameraMode,
      player_slot: state.povSlot,
    });
    state.activeDemo.bookmarks = [...(state.activeDemo.bookmarks || []), res.bookmark];
    document.getElementById('input-bm-label').value = '';
    document.getElementById('input-bm-note').value = '';
    updateViewerControlsDOM();
  });

  renderBookmarksPanel();
}

function mountLoadedReplayIntoFreshDom() {
  if (!sceneInstance || !state.roundReplay) return;
  const oldTick = sceneInstance.currentTick;
  const oldPlaying = sceneInstance.playing;
  sceneInstance.dispose();
  sceneInstance = null;
  mountAndBindViewer();
  loadViewerMatchAssetsAndRound(state.activeRoundNum).then(() => {
    if (sceneInstance) {
      sceneInstance.currentTick = oldTick;
      sceneInstance.playing = oldPlaying;
    }
  });
}

function bindModalHandlers() {
  document.getElementById('btn-close-scoreboard')?.addEventListener('click', () => {
    state.showScoreboardModal = false;
    renderModalsDOM();
  });

  document.getElementById('btn-close-assets')?.addEventListener('click', () => {
    state.showAssetsModal = false;
    renderModalsDOM();
  });

  document.getElementById('form-add-asset-dir')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = document.getElementById('input-asset-dir')?.value?.trim();
    if (!p) return;
    try {
      await api.addAssetDir(p);
      state.health = await api.health();
      renderModalsDOM();
      if (state.view === 'viewer') await loadViewerMatchAssetsAndRound(state.activeRoundNum);
    } catch (err) {
      alert(`Failed to add folder: ${err.message}`);
    }
  });

  document.querySelectorAll('[data-del-asset-dir]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api.deleteAssetDir(btn.dataset.delAssetDir);
      state.health = await api.health();
      renderModalsDOM();
      if (state.view === 'viewer') await loadViewerMatchAssetsAndRound(state.activeRoundNum);
    });
  });

  document.getElementById('form-upload-map-glb')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mapName = document.getElementById('input-asset-map-name')?.value?.trim();
    const file = document.getElementById('input-asset-map-file')?.files?.[0];
    if (!mapName || !file) return;
    await api.uploadMapAsset(mapName, file);
    state.health = await api.health();
    state.showAssetsModal = false;
    renderModalsDOM();
    if (state.view === 'viewer') await loadViewerMatchAssetsAndRound(state.activeRoundNum);
  });

  document.querySelectorAll('[data-del-map-asset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api.deleteMapAsset(btn.dataset.delMapAsset);
      state.health = await api.health();
      renderModalsDOM();
      if (state.view === 'viewer') await loadViewerMatchAssetsAndRound(state.activeRoundNum);
    });
  });

  document.getElementById('form-upload-player-glb')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = document.getElementById('input-asset-player-file')?.files?.[0];
    if (!file) return;
    await api.uploadPlayerAsset(file);
    state.health = await api.health();
    state.showAssetsModal = false;
    renderModalsDOM();
    if (state.view === 'viewer') await loadViewerMatchAssetsAndRound(state.activeRoundNum);
  });

  document.getElementById('btn-del-player-asset')?.addEventListener('click', async () => {
    await api.deletePlayerAsset();
    state.health = await api.health();
    renderModalsDOM();
    if (state.view === 'viewer') await loadViewerMatchAssetsAndRound(state.activeRoundNum);
  });
}

// Global viewer hotkeys
window.addEventListener('keydown', (e) => {
  if (state.view !== 'viewer' || !sceneInstance) return;
  if (e.code === 'F3') {
    e.preventDefault();
    if (!e.repeat) document.getElementById('btn-render-diagnostics')?.click();
    return;
  }
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

  if (e.code === 'Tab') {
    e.preventDefault();
    state.showScoreboardModal = !state.showScoreboardModal;
    renderModalsDOM();
  } else if (e.code === 'Space' && state.cameraMode !== 'free') {
    e.preventDefault();
    sceneInstance.playing = !sceneInstance.playing;
  } else if (e.code === 'ArrowLeft' && state.cameraMode !== 'free' && state.roundReplay?.frames?.length) {
    e.preventDefault();
    sceneInstance.playing = false;
    const minT = state.roundReplay.frames[0].t;
    sceneInstance.currentTick = Math.max(minT, sceneInstance.currentTick - 1);
  } else if (e.code === 'ArrowRight' && state.cameraMode !== 'free' && state.roundReplay?.frames?.length) {
    e.preventDefault();
    sceneInstance.playing = false;
    const maxT = state.roundReplay.frames[state.roundReplay.frames.length - 1].t;
    sceneInstance.currentTick = Math.min(maxT, sceneInstance.currentTick + 1);
  } else if (e.code === 'KeyX') {
    state.xray = !state.xray;
    sceneInstance.setXray(state.xray);
    updateViewerControlsDOM();
  } else if (e.code === 'KeyF') {
    state.cameraMode = 'free';
    sceneInstance.setCameraMode('free', state.povSlot);
    state.lastHudCamKey = '';
    updateViewerControlsDOM();
  } else if (e.code === 'KeyT') {
    state.cameraMode = 'tactical';
    sceneInstance.setCameraMode('tactical', state.povSlot);
    state.lastHudCamKey = '';
    updateViewerControlsDOM();
  } else if (/^Digit[0-9]$/.test(e.code)) {
    const num = Number(e.code.replace('Digit', ''));
    const slot = num === 0 ? 9 : num - 1;
    if (state.activeDemo?.players?.some((p) => p.slot === slot)) {
      state.cameraMode = 'pov';
      state.povSlot = slot;
      sceneInstance.setCameraMode('pov', slot);
      state.lastHudCamKey = '';
      updateViewerControlsDOM();
    }
  }
});

(async function boot() {
  try {
    await refreshHealthAndDemos();
  } catch (err) {
    state.statusBanner = { type: 'error', text: `Backend connection failed: ${err.message}` };
  }
  render();
})();
