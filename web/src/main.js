import './styles.css';
import './viewer/hud.css';
import { operatorPortraits } from './viewer/portraits.js';
import { api } from './api.js';
import { DemoScene } from './viewer/scene.js';
import { RadarRenderer } from './viewer/radar.js';
import { DemoAudio } from './viewer/audio.js';
import {
  formatClock,
  computeRoundClock,
  isSniperWeapon,
  weaponCategory,
  unpackUtilityCounts,
  cycleAliveSlot,
  interpolateFrames,
  matchFinalByCurrentSides,
  roundAtTick,
} from './viewer/math.js';
import {
  weaponSvgIcon,
  configureHudAssets,
  hpCrossIcon,
  armorIcon,
  defuseKitIcon,
  skullIcon,
  deathNoticeIcon,
} from './viewer/icons.js';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 6, 8];

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
  roundRequest: 0,
  radarData: null,
  cameraMode: 'tactical',
  povSlot: 0,
  xray: true,
  showPlayerLabels: false,
  showTracers: true,
  blindMode: 'observer', // 'observer' | 'cs2'
  audioEnabled: false,
  playbackSpeed: 1,
  qualitySetting: 'auto', // 'auto' | 'high' | 'medium' | 'low'
  activeQuality: 'high',
  showRenderDiagnostics: false,
  showDemoControls: false,
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
    configureHudAssets(health.hud_assets);
    state.activeDemo = detail;
    state.showDemoControls = false;
    state.roundCache.clear();
    state.roundRequest++;
    state.roundReplay = null;
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
  sceneInstance.setPlayerLabels(state.showPlayerLabels);
  sceneInstance.setShowTracers(state.showTracers);
  sceneInstance.setRoundData(roundReplay, state.activeDemo.players);
  sceneInstance.playbackSpeed = state.playbackSpeed;
  if (preserveTick !== null) {
    sceneInstance.currentTick = preserveTick;
  }
  if (roundReplay.is_pov && Number.isInteger(roundReplay.pov_slot)) {
    state.cameraMode = 'pov';
    state.povSlot = roundReplay.pov_slot;
  }
  sceneInstance.setCameraMode(state.cameraMode, state.povSlot);
  state.lastHudTick = -1;
  state.lastHudCamKey = '';
  renderTeamSideHudPanels();
  updateViewerControlsDOM();
}

async function fetchCachedRound(demoId, roundNum) {
  const key = `${demoId}:${roundNum}`;
  const cached = state.roundCache.get(key);
  state.roundCache.delete(key);
  const request = cached || api.getRound(demoId, roundNum).catch((err) => {
    if (state.roundCache.get(key) === request) state.roundCache.delete(key);
    throw err;
  });
  state.roundCache.set(key, request);
  if (state.roundCache.size > 5) state.roundCache.delete(state.roundCache.keys().next().value);
  return request;
}

async function switchRound(roundNum, { tick, playing = false } = {}) {
  const match = state.activeDemo;
  const view = sceneInstance;
  if (!match || !view || !state.roundReplay) return;
  const request = ++state.roundRequest;
  view.playing = false;
  try {
    const rr = await fetchCachedRound(match.metadata.id, roundNum);
    if (state.roundRequest !== request || sceneInstance !== view || state.activeDemo !== match) return;
    state.activeRoundNum = roundNum;
    state.roundReplay = rr;
    audioInstance.resetRound();
    view.setRoundData(rr, match.players);
    if (Number.isFinite(tick)) {
      view.currentTick = Math.max(rr.frames[0].t, Math.min(rr.frames.at(-1).t, tick));
    }
    view.playing = playing;
    if (playing) preloadNextRound();
    state.lastHudTick = -1;
    state.lastHudCamKey = '';
    renderTeamSideHudPanels();
    updateViewerControlsDOM();
    if (state.showScoreboardModal) renderModalsDOM();
  } catch (err) {
    if (state.roundRequest === request) setBanner('error', `Could not load round ${roundNum}: ${err.message}`);
  }
}

function followingRound() {
  const rounds = state.activeDemo?.rounds || [];
  const index = rounds.findIndex((r) => r.round_number === state.activeRoundNum);
  return index < 0 ? null : rounds[index + 1];
}

function preloadNextRound() {
  const next = followingRound();
  if (next) fetchCachedRound(state.activeDemo.metadata.id, next.round_number).catch(() => {});
}

function advanceRound() {
  const next = followingRound();
  if (next) switchRound(next.round_number, { playing: true });
}

function seekMatchTick(tick) {
  if (!Number.isFinite(tick) || !sceneInstance || !state.roundReplay) return;
  const target = roundAtTick(state.activeDemo.rounds, tick);
  if (!target) return;
  if (target.round_number !== state.activeRoundNum) {
    switchRound(target.round_number, { tick });
  } else {
    state.roundRequest++;
    sceneInstance.playing = false;
    const frames = state.roundReplay.frames;
    sceneInstance.currentTick = Math.max(frames[0].t, Math.min(tick, frames.at(-1).t));
  }
}

function togglePlayback() {
  const frames = state.roundReplay?.frames;
  if (!sceneInstance || !frames?.length) return;
  if (!sceneInstance.playing && sceneInstance.currentTick >= frames.at(-1).t) {
    if (followingRound()) {
      advanceRound();
      return;
    }
    sceneInstance.currentTick = frames[0].t;
  }
  sceneInstance.playing = !sceneInstance.playing;
  if (sceneInstance.playing) preloadNextRound();
}

function cycleSpectator(direction) {
  if (!sceneInstance || !state.roundReplay) return;
  const snapshot = interpolateFrames(state.roundReplay.frames, sceneInstance.currentTick);
  if (!snapshot) return;
  const next = cycleAliveSlot(snapshot.players, state.povSlot, direction);
  if (next >= 0) sceneInstance.setCameraMode(state.cameraMode === 'chase' ? 'chase' : 'pov', next);
}

function getRoundTeamForPlayer(player, rr) {
  const liveSide = sceneInstance?.roundReplay === rr ? sceneInstance?.roundTeams.get(player.slot) : null;
  if (liveSide) return liveSide;
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

  const portraits = operatorPortraits([[3, sceneInstance?.ctPlayerTemplate], [2, sceneInstance?.tPlayerTemplate]]);
  const rowHtml = (p, portrait, side) => `
    <button type="button" class="cs2-card ${side}" id="hud-player-${p.slot}" data-pov-slot="${p.slot}" title="${esc(p.name)}" aria-label="Spectate ${esc(p.name)}">
      <span class="cs2-card-name">${esc(p.name)}</span>
      <span class="cs2-card-body">
        ${portrait ? `<img class="cs2-card-portrait" src="${portrait}" alt="">` : ''}
      </span>
      <span class="cs2-card-hp-row">100</span>
      <span class="cs2-card-money"></span>
      <span class="cs2-card-bar"><i style="width:100%;"></i></span>
      <span class="cs2-card-gear"></span>
    </button>
  `;

  ctEl.innerHTML = ctPlayers.map((p) => rowHtml(p, portraits.get(3), 'ct')).join('');
  tEl.innerHTML = tPlayers.map((p) => rowHtml(p, portraits.get(2), 't')).join('');

  document.querySelectorAll('[data-pov-slot]').forEach((el) => {
    el.addEventListener('click', () => {
      const slot = Number(el.dataset.povSlot);
      state.cameraMode = state.cameraMode === 'chase' ? 'chase' : 'pov';
      state.povSlot = slot;
      sceneInstance?.setCameraMode(state.cameraMode, slot);
      state.lastHudCamKey = '';
      updateViewerControlsDOM();
    });
  });
}

function utilityIcons(inventory, className, limit = Infinity) {
  return [
    ['smoke', 'smokegrenade', 'Smoke'],
    ['flash', 'flashbang', 'Flashbang'],
    ['he', 'hegrenade', 'HE grenade'],
    ['molly', 'molotov', 'Molotov / incendiary'],
    ['decoy', 'decoy', 'Decoy'],
    ['c4', 'c4', 'C4'],
  ].flatMap(([key, weapon, label]) => Array.from({ length: inventory[key] }, () =>
    `<span class="${className}${key === 'c4' ? ' is-c4' : ''}" title="${label}">${weaponSvgIcon(weapon, 'inventory-svg')}</span>`,
  )).slice(0, limit).join('');
}

// Native CS2-style playback transport: round band timeline with kill/bomb markers,
// a playhead, play/pause, single-tick steps, 15s skips, round navigation, the clock,
// the raw tick and the speed selector.
function updateTransportPanel() {
  const rr = state.roundReplay;
  const timeline = document.getElementById('cs2-transport-timeline');
  const rounds = state.activeDemo?.rounds || [];
  if (!timeline || !rr?.frames?.length) {
    if (timeline) timeline.innerHTML = '';
    return;
  }

  const minT = rr.frames[0].t;
  const maxT = rr.frames[rr.frames.length - 1].t;
  const span = Math.max(1, maxT - minT);
  const current = sceneInstance?.currentTick ?? minT;
  const pct = Math.max(0, Math.min(100, ((current - minT) / span) * 100));

  const roundBands = rounds
    .filter((r) => r.end_tick >= minT && r.start_tick <= maxT)
    .map((r) => {
      const left = Math.max(0, ((r.start_tick - minT) / span) * 100);
      const right = Math.min(100, ((r.end_tick - minT) / span) * 100);
      const win = r.winner_team === 3 ? 'win-ct' : r.winner_team === 2 ? 'win-t' : '';
      const cur = r.round_number === state.activeRoundNum ? ' current' : '';
      return `<span class="cs2-transport-round ${win}${cur}" style="left:${left}%;width:${Math.max(0.6, right - left)}%" title="Round ${r.round_number}${r.win_reason ? ` · ${esc(r.win_reason)}` : ''}">${r.round_number}</span>`;
    });

  const markers = [];
  for (const k of rr.kills || []) {
    const p = ((k.tick - minT) / span) * 100;
    if (p < 0 || p > 100) continue;
    const cls = k.killer_team === 3 ? 'marker-kill-ct' : 'marker-kill-t';
    markers.push(
      `<span class="cs2-transport-marker ${cls}" style="left:${p}%" title="${esc(k.killer_name)} [${esc(k.weapon)}] ${esc(k.victim_name)} · tick ${k.tick}" data-tick="${k.tick}"></span>`
    );
  }
  for (const be of rr.bomb_events || []) {
    if (!['planted', 'defused', 'exploded'].includes(be.type)) continue;
    const p = ((be.tick - minT) / span) * 100;
    if (p < 0 || p > 100) continue;
    markers.push(
      `<span class="cs2-transport-marker marker-bomb" style="left:${p}%" title="Bomb ${esc(be.type)}${be.site ? ` ${esc(be.site)}` : ''} · tick ${be.tick}" data-tick="${be.tick}"></span>`
    );
  }

  const html = `${roundBands.join('')}${markers.join('')}<span class="cs2-transport-playhead" style="left:${pct}%"></span>`;
  if (timeline.innerHTML !== html) timeline.innerHTML = html;

  const rate = rr.tick_rate || 64;
  const elapsed = (current - minT) / rate;
  const total = (maxT - minT) / rate;
  const timeEl = document.getElementById('cs2-transport-time');
  if (timeEl) timeEl.textContent = `${formatClock(Math.max(0, elapsed))} / ${formatClock(total)}`;
  const tickEl = document.getElementById('cs2-transport-tick');
  if (tickEl) tickEl.textContent = String(Math.round(current)).padStart(6, '0');
  const roundEl = document.getElementById('cs2-transport-round');
  if (roundEl) roundEl.textContent = `R${state.activeRoundNum}`;
  const playerEl = document.getElementById('cs2-transport-player');
  if (playerEl) {
    const name = state.activeDemo?.players?.find((p) => p.slot === state.povSlot)?.name;
    playerEl.textContent = name || '—';
  }
  const playEl = document.getElementById('cs2-btn-play');
  if (playEl) playEl.textContent = sceneInstance?.playing ? 'PAUSE' : 'PLAY';
}

function updateMatchHeaderScoreboard() {
  const strip = document.getElementById('match-scoreboard-strip');
  if (!state.activeDemo) return;
  const d = state.activeDemo;
  if (strip) {
    const overtime = state.roundReplay?.overtime;
    strip.textContent = `Round ${state.activeRoundNum}/${d.rounds.length}${overtime ? ` · OT ${overtime}` : ''}`;
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
  document.getElementById('pov-recording-warning').hidden = !rr?.is_pov;
  document.getElementById('cs2-radar')?.classList.toggle('is-round', !!rr?.is_pov);
  const matchScrubber = document.getElementById('match-timeline-scrubber');
  if (matchScrubber && rr?.frames?.length && !followingRound()) {
    matchScrubber.max = String(Math.max(Number(matchScrubber.max), rr.frames.at(-1).t));
  }
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
  const labelsBtn = document.getElementById('btn-labels');
  if (labelsBtn) labelsBtn.classList.toggle('btn-active', state.showPlayerLabels);
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
  const matchScrubber = document.getElementById('match-timeline-scrubber');
  if (matchScrubber && document.activeElement !== matchScrubber) matchScrubber.value = String(Math.round(currentTick));

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

  updateMatchHeaderScoreboard();

  updateTransportPanel();

  // Round Clock + Bomb Plant/Defuse Bar
  const clockBox = document.getElementById('round-clock-box');
  const clockText = document.getElementById('round-clock-text');
  const clockPhase = document.getElementById('round-clock-phase');
  const actionBar = document.getElementById('bomb-action-bar');
  const actionText = document.getElementById('bomb-action-text');
  const actionFill = document.getElementById('bomb-action-fill');
  if (clockBox && clockText && clockPhase && clockInfo) {
    clockBox.dataset.phase = clockInfo.phase;
    clockBox.dataset.team = String(clockInfo.team || 0);
    if (clockInfo.phase === 'planted') {
      clockPhase.textContent = clockInfo.site ? `C4 [${clockInfo.site}]` : 'C4 PLANTED';
      clockText.textContent = clockInfo.clockText;
    } else if (clockInfo.phase === 'freeze') {
      clockPhase.textContent = 'FREEZE';
      clockText.textContent = clockInfo.clockText;
    } else if (clockInfo.phase === 'defused' || clockInfo.phase === 'exploded') {
      clockPhase.textContent = 'BOMB';
      clockText.textContent = clockInfo.clockText;
    } else if (clockInfo.phase === 'pause' || clockInfo.phase === 'timeout') {
      clockPhase.textContent = clockInfo.phase === 'pause' ? 'PAUSED' : `TIMEOUT · ${clockInfo.team === 3 ? 'CT' : 'T'}`;
      clockText.textContent = clockInfo.clockText;
    } else if (clockInfo.phase === 'round_over') {
      clockPhase.textContent = 'ROUND OVER';
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

  const outcome = document.getElementById('round-end-banner');
  const round = rr?.summary;
  const winner = round?.winner_team;
  const roundOver = (winner > 0 || /^draw$/i.test(round?.win_reason || '')) && round.end_tick > 0 && currentTick >= round.end_tick;
  if (round) {
    for (const [side, score] of [[3, round.score_ct], [2, round.score_t]]) {
      const node = document.getElementById(side === 3 ? 'hud-score-ct' : 'hud-score-t');
      const value = String(Math.max(0, score - (!roundOver && winner === side ? 1 : 0)));
      if (node && node.textContent !== value) node.textContent = value;
    }
  }
  if (outcome) {
    outcome.hidden = !roundOver;
    if (roundOver) {
      const mvp = state.activeDemo.players?.find((player) => player.slot === rr.mvp?.slot);
      outcome.dataset.winner = String(winner);
      outcome.querySelector('strong').textContent = winner === 3 ? 'Counter-Terrorists Win' : winner === 2 ? 'Terrorists Win' : 'Round Draw';
      outcome.querySelector('.round-end-reason').textContent = winner ? round.win_reason : '';
      const mvpLine = outcome.querySelector('.round-end-mvp');
      mvpLine.hidden = !mvp;
      mvpLine.querySelector('.round-end-mvp-name').textContent = mvp ? `MVP: ${mvp.name}` : '';
    }
  }

  const weapons = rr?.weapons || [];
  const obsSlot = snapshot?.observedSlot ?? state.povSlot;
  const obs = state.cameraMode === 'pov' ? snapshot?.players?.[obsSlot] : null;
  const radarPlayer = state.cameraMode === 'chase' ? snapshot?.players?.[obsSlot] : obs;
  const place = radarPlayer?.[0] === 1 ? rr?.places?.[radarPlayer[26]] : '';
  const callout = document.getElementById('radar-callout');
  const calloutMap = document.getElementById('radar-label');
  if (calloutMap) calloutMap.textContent = state.activeDemo.metadata.map_name;
  const calloutPlace = document.getElementById('radar-level-badge');
  if (calloutPlace) {
    calloutPlace.textContent = place
      ? place.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
      : '';
  }
  if (callout) callout.hidden = !place;
  const obsAlive = !!(obs && obs[0] === 1 && (obs[7] || 0) > 0);
  const damage = document.getElementById('pov-damage');
  if (damage) {
    const hurts = rr?.hurts || [];
    const windowStart = currentTick - tickRate * 0.75;
    const latest = obsAlive && !snapshot?.deathCamActive && hurts.findLast((h) =>
      h.tick <= currentTick && h.tick >= windowStart && h.dmg_hp > 0 && (h.attacker_slot === obsSlot || h.victim_slot === obsSlot));
    damage.hidden = !latest;
    if (latest) {
      const taken = latest.victim_slot === obsSlot;
      const attacker = taken ? snapshot?.players?.[latest.attacker_slot] : null;
      let direction = '';
      if (attacker?.[0] === 1 && latest.attacker_slot !== obsSlot) {
        const bearing = Math.atan2(attacker[3] - obs[3], attacker[2] - obs[2]) * 180 / Math.PI - obs[5];
        const relative = ((bearing + 180) % 360 + 360) % 360 - 180;
        direction = Math.abs(relative) <= 45 ? ' · FRONT' : Math.abs(relative) >= 135 ? ' · REAR' : relative > 0 ? ' · LEFT' : ' · RIGHT';
      }
      damage.classList.toggle('taken', taken);
      damage.textContent = `${taken ? '−' : '+'}${latest.dmg_hp} HP ${taken ? 'TAKEN' : 'DEALT'}${direction}`;
      damage.style.opacity = String(Math.min(1, (latest.tick - windowStart) / (tickRate * 0.25)));
    }
  }
  const obsWeapon = obs && obs[13] >= 0 && weapons[obs[13]] ? weapons[obs[13]] : '';
  const obsZoom = obs ? obs[10] || 0 : 0;
  const inventory = document.getElementById('pov-inventory');
  inventory.hidden = state.cameraMode !== 'pov' || !obsAlive || !!snapshot?.deathCamActive;
  if (!inventory.hidden) {
    const flags = obs[14] || 0;
    const util = unpackUtilityCounts(obs[19] || 0);
    const inventoryHtml = `${utilityIcons(util, 'cs2-utility-icon', 4)}${flags & 2 ? defuseKitIcon('cs2-utility-icon') : ''}`;
    if (inventory.innerHTML !== inventoryHtml) inventory.innerHTML = inventoryHtml;
  }
  const sniperScoped = state.cameraMode === 'pov' && obsAlive && isSniperWeapon(obsWeapon) && obsZoom > 0;

  // Crosshair & Sniper Scope overlay
  const xhEl = document.getElementById('pov-crosshair');
  const scopeEl = document.getElementById('sniper-scope-overlay');
  if (xhEl) {
    xhEl.style.display = state.cameraMode === 'pov' && obsAlive && !sniperScoped ? 'block' : 'none';
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
  const flashFrac = state.cameraMode === 'pov' && obsAlive ? obs[11] || 0 : 0;
  const flashAlpha = state.cameraMode === 'pov' && obsAlive ? obs[12] || 1 : 0;

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
    if (state.cameraMode === 'pov' && obsAlive && !snapshot?.deathCamActive) {
      const isCT = obs[1] === 3;
      const hp = Math.round(obs[7] || 0);
      const armor = Math.round(obs[8] || 0);
      const flags = obs[14] || 0;
      const hasHelm = (flags & 1) !== 0;
      const hasKit = (flags & 2) !== 0;
      const mag = obs[16] >= 0 ? Math.round(obs[16]) : null;
      const res = obs[17] >= 0 ? Math.round(obs[17]) : null;
      const buyPhase = clockInfo?.phase === 'freeze';
      const money = document.getElementById('pov-hud-money');
      money.textContent = buyPhase && obs[15] >= 0 ? `$${Math.round(obs[15])}` : '';
      money.style.display = buyPhase ? '' : 'none';

      document.getElementById('pov-observer-name').textContent = state.activeDemo?.players?.find((p) => p.slot === obsSlot)?.name ?? '';
      document.getElementById('pov-observer-weapon').textContent = obsWeapon || 'Knife';
      povHud.style.display = 'flex';
      povHud.classList.toggle('team-ct', isCT);
      povHud.classList.toggle('team-t', !isCT);
      povHud.classList.remove('deathcam-mode');
      const hpEl = document.getElementById('pov-hud-hp');
      const arEl = document.getElementById('pov-hud-armor');
      const wEl = document.getElementById('pov-hud-weapon');
      const ammoEl = document.getElementById('pov-hud-ammo');
      if (hpEl) {
        hpEl.innerHTML = `${hpCrossIcon('cs2-hp-cross')}<span>${hp}</span>`;
      }
      if (arEl) {
        arEl.innerHTML = `${armorIcon(hasHelm, 'cs2-armor-icon')}<span>${armor}</span>${hasKit ? defuseKitIcon('cs2-armor-icon') : ''}`;
      }
      if (wEl) {
        wEl.innerHTML = weaponSvgIcon(obsWeapon || 'knife', 'cs2-weapon-silhouette');
        wEl.title = obsWeapon || 'Knife';
      }
      if (ammoEl) {
        ammoEl.innerHTML = mag !== null
          ? `<span class="cs2-ammo-mag">${mag}</span><span class="cs2-ammo-sep">/</span><span class="cs2-ammo-res">${res ?? 0}</span>`
          : '';
      }
    } else if (state.cameraMode === 'pov' && (snapshot?.deathCamActive || (state.cameraMode === 'pov' && obs && !obsAlive))) {
      const killEv = (rr?.kills || []).find((k) => k.victim_slot === obsSlot && k.tick <= rounded);
      povHud.style.display = 'flex';
      povHud.classList.add('deathcam-mode');
      const hpEl = document.getElementById('pov-hud-hp');
      const arEl = document.getElementById('pov-hud-armor');
      const wEl = document.getElementById('pov-hud-weapon');
      const ammoEl = document.getElementById('pov-hud-ammo');
      if (hpEl) {
        hpEl.innerHTML = `${skullIcon('cs2-hp-cross')}<span>0</span>`;
      }
      if (arEl) arEl.innerHTML = '';
      if (wEl) {
        wEl.innerHTML = killEv
          ? `<span class="cs2-kill-note">KILLED BY ${esc(killEv.killer_name)}</span>`
          : `<span class="cs2-kill-note">ELIMINATED</span>`;
      }
      if (ammoEl) ammoEl.innerHTML = killEv ? weaponSvgIcon(killEv.weapon, 'cs2-weapon-silhouette') : '';
    } else {
      povHud.style.display = 'none';
    }
  }

  // Top CS2 roster cards indexed strictly by `player.slot`
  if (snapshot && state.activeDemo) {
    const buyPhase = clockInfo?.phase === 'freeze';
    const aliveBySide = [0, 0, 0, 0];
    for (const p of snapshot.players) {
      if (p?.[0] === 1 && p[7] > 0 && (p[1] === 2 || p[1] === 3)) aliveBySide[p[1]]++;
    }
    const aliveIcon = '<svg viewBox="0 0 12 16" aria-hidden="true"><circle cx="6" cy="3" r="2.6"/><path d="M6 6.4c-3 0-4.6 1.6-4.6 4v2.2h9.2V10.4c0-2.4-1.6-4-4.6-4z"/></svg>';
    document.getElementById('hud-alive-ct').innerHTML = `${aliveIcon}<span>${aliveBySide[3]}</span>`;
    document.getElementById('hud-alive-t').innerHTML = `${aliveIcon}<span>${aliveBySide[2]}</span>`;
    for (const player of state.activeDemo.players) {
      const slot = player.slot;
      const row = document.getElementById(`hud-player-${slot}`);
      if (!row) continue;
      const p = snapshot.players[slot];
      const alive = !!(p && p[0] === 1 && (p[7] || 0) > 0);
      const hp = alive ? Math.round(p[7]) : 0;
      const armor = alive ? Math.round(p[8] || 0) : 0;
      const flags = p ? p[14] || 0 : 0;
      const hasKit = (flags & 2) !== 0;
      const hasHelm = (flags & 1) !== 0;
      const wIdx = p ? p[13] : -1;
      const weapon = wIdx >= 0 && weapons[wIdx] ? weapons[wIdx] : '';
      const flash = p ? p[11] || 0 : 0;
      row.classList.toggle('cs2-card-dead', !alive);
      row.classList.toggle('cs2-card-observed', (state.cameraMode === 'pov' || state.cameraMode === 'chase') && obsSlot === slot);
      const hpEl = row.querySelector('.cs2-card-hp-row');
      const fillEl = row.querySelector('.cs2-card-bar > i');
      const gearEl = row.querySelector('.cs2-card-gear');
      const moneyEl = row.querySelector('.cs2-card-money');
      if (moneyEl) {
        moneyEl.textContent = buyPhase && alive ? `$${Math.round(p ? p[15] || 0 : 0)}` : '';
      }
      if (hpEl) hpEl.textContent = alive ? String(hp) : '\u00d7';
      if (fillEl) fillEl.style.width = `${hp}%`;
      if (gearEl) {
        gearEl.innerHTML = alive
          ? `${weaponSvgIcon(weapon || 'knife', 'cs2-card-weapon')}${flash > 0.15 ? deathNoticeIcon('blind', 'cs2-card-icon') : ''}${armor > 0 ? armorIcon(hasHelm, 'cs2-card-icon') : ''}${hasKit ? defuseKitIcon('cs2-card-icon') : ''}${utilityIcons(unpackUtilityCounts(p[19]), 'cs2-card-icon', 3)}`
          : '';
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
        const inPov = state.cameraMode === 'pov';
        const isDeath = inPov && k.victim_slot === obsSlot;
        const isObserved = inPov && (k.killer_slot === obsSlot || k.assister_slot === obsSlot);
        const assistHtml = k.assister_name
          ? `<span class="kf-assist">${k.assisted_flash ? deathNoticeIcon('flash-assist', 'kf-mod-icon') : '+'}<span class="${k.assister_team === 3 ? 'kf-ct' : 'kf-t'}">${esc(k.assister_name)}</span></span>`
          : '';
        const before = [[k.attacker_blind, 'blind'], [k.no_scope, 'noscope']].map(([enabled, icon]) => enabled ? deathNoticeIcon(icon, 'kf-mod-icon') : '').join('');
        const after = [[k.wallbang, 'wallbang'], [k.through_smoke, 'smoke'], [k.headshot, 'headshot']].map(([enabled, icon]) => enabled ? deathNoticeIcon(icon, 'kf-mod-icon') : '').join('');
        return `<div class="cs2-killfeed-item ${isDeath ? 'kf-death' : isObserved ? 'kf-highlight' : ''}">
          ${before}
          <span class="kf-killer">
            <span class="${k.killer_team === 3 ? 'kf-ct' : 'kf-t'}">${esc(k.killer_name)}</span>
            ${assistHtml}
          </span>
          <span class="kf-weapon" title="${esc(k.weapon)}">${weaponSvgIcon(k.weapon, 'kf-w-svg')}</span>
          <span class="kf-mods">${after}</span>
          <span class="kf-victim ${k.victim_team === 3 ? 'kf-ct' : 'kf-t'}">${esc(k.victim_name)}</span>
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
      <div class="software-renderer-warning" id="software-renderer-warning" role="status" hidden>
        <strong>Software rendering detected.</strong> In your browser’s System settings, enable graphics acceleration when available, then relaunch the browser.
      </div>
      <div class="software-renderer-warning" id="pov-recording-warning" role="status" hidden>
        <strong>POV recording.</strong> Players outside the recorder’s potentially visible set may be missing or stale.
      </div>
      <div class="stage-wrap">
        <div class="three-container" id="three-stage"></div>
        <pre class="render-diagnostics" id="render-diagnostics" aria-label="Renderer diagnostics" hidden></pre>
        <div class="tags-overlay" id="tags-overlay"></div>
        <div class="sniper-scope-overlay" id="sniper-scope-overlay"></div>
        <div class="pov-crosshair" id="pov-crosshair"></div>
        <div class="pov-damage" id="pov-damage" hidden></div>
        <div class="round-end-banner" id="round-end-banner" hidden>
          <div class="round-end-main"><span class="round-end-emblem" aria-hidden="true">★</span><strong></strong><span class="round-end-reason"></span></div>
          <div class="round-end-mvp" hidden><span class="round-end-mvp-star" aria-hidden="true">★</span><span class="round-end-mvp-name"></span></div>
        </div>
        <div class="flash-vignette" id="flash-vignette"></div>
        <div class="flash-blind-full" id="flash-blind-full"></div>
        <div class="flash-meter" id="flash-meter">
          <span id="flash-meter-text">FLASHED</span>
          <div class="flash-meter-bar"><div class="flash-meter-fill" id="flash-meter-fill" style="width:0%"></div></div>
        </div>

        <div class="cs2-radar" id="cs2-radar">
          <canvas id="radar-canvas" width="258" height="258"></canvas>
          <span class="cs2-radar-callout" id="radar-callout">
            <span class="cs2-callout-map" id="radar-label">${esc(meta.map_name)}</span>
            <span id="radar-level-badge">UPPER</span>
          </span>
        </div>

        <div class="cs2-top">
          <aside class="cs2-team ct" id="team-hud-ct" aria-label="Counter-Terrorists"></aside>
          <div class="cs2-centre">
            <div class="cs2-clock" id="round-clock-box">
              <span id="round-clock-text">1:55</span>
              <span class="cs2-clock-phase" id="round-clock-phase">LIVE</span>
            </div>
            <div class="cs2-scores">
              <div class="cs2-score ct">
                <b id="hud-score-ct">0</b>
                <span class="cs2-alive ct" id="hud-alive-ct" aria-label="Counter-Terrorists alive"></span>
              </div>
              <div class="cs2-score t">
                <b id="hud-score-t">0</b>
                <span class="cs2-alive t" id="hud-alive-t" aria-label="Terrorists alive"></span>
              </div>
            </div>
            <div class="bomb-action-bar" id="bomb-action-bar">
              <span id="bomb-action-text">DEFUSING</span>
              <div class="bomb-action-track"><div class="bomb-action-fill" id="bomb-action-fill" style="width:0%"></div></div>
            </div>
          </div>
          <aside class="cs2-team t" id="team-hud-t" aria-label="Terrorists"></aside>
        </div>

        <div class="cs2-bottom" id="pov-bottom-hud">
          <div class="cs2-bottom-left">
            <span class="cs2-money" id="pov-hud-money"></span>
            <div class="cs2-hp-plate">
              <span class="cs2-hp-value"><span id="pov-hud-hp">100</span></span>
              <span class="cs2-armor" id="pov-hud-armor"></span>
            </div>
          </div>
          <div class="cs2-bottom-right">
            <div class="cs2-utility" id="pov-inventory" aria-label="Observed player equipment" hidden></div>
            <div class="cs2-ammo-plate">
              <span class="cs2-weapon-silhouette" id="pov-hud-weapon"></span>
              <span class="cs2-ammo" id="pov-hud-ammo">30 / 90</span>
            </div>
          </div>
        </div>
        <div class="cs2-observer" id="pov-observer">
          <span id="pov-observer-name"></span>
          <span class="cs2-observer-weapon" id="pov-observer-weapon"></span>
        </div>
        <div class="cs2-killfeed" id="killfeed-list" aria-label="Kill feed"></div>
        <span class="cs2-round-strip" id="match-scoreboard-strip" hidden></span>

        <div class="cs2-transport" id="cs2-transport" aria-label="Playback controls">
          <div class="cs2-transport-timeline" id="cs2-transport-timeline"></div>
          <div class="cs2-transport-row">
            <button type="button" class="cs2-transport-btn primary" id="cs2-btn-play" title="Play / pause (Space)">PLAY</button>
            <button type="button" class="cs2-transport-btn" id="cs2-btn-step-back" title="Step back one tick">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2 4 8l7 6zm-7 0h2v12H4z"/></svg>
            </button>
            <button type="button" class="cs2-transport-btn" id="cs2-btn-step-fwd" title="Step forward one tick">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2l7 6-7 6zm7 0h2v12h-2z"/></svg>
            </button>
            <button type="button" class="cs2-transport-btn" id="cs2-btn-skip-back" title="Back 15 seconds">&minus;15s</button>
            <button type="button" class="cs2-transport-btn" id="cs2-btn-skip-fwd" title="Forward 15 seconds">+15s</button>
            <span class="cs2-transport-sep" aria-hidden="true"></span>
            <span class="cs2-transport-round-nav">
              <button type="button" class="cs2-transport-btn" id="cs2-btn-prev-round" title="Previous round">&lsaquo;</button>
              <span id="cs2-transport-round">R1</span>
              <button type="button" class="cs2-transport-btn" id="cs2-btn-next-round" title="Next round">&rsaquo;</button>
            </span>
            <span class="cs2-transport-sep" aria-hidden="true"></span>
            <span class="cs2-transport-round-nav">
              <button type="button" class="cs2-transport-btn" id="cs2-btn-prev-player" title="Previous player">&lsaquo;</button>
              <span id="cs2-transport-player">—</span>
              <button type="button" class="cs2-transport-btn" id="cs2-btn-next-player" title="Next player">&rsaquo;</button>
            </span>
            <span class="cs2-transport-sep" aria-hidden="true"></span>
            <span class="cs2-transport-time" id="cs2-transport-time">0:00 / 0:00</span>
            <span class="cs2-transport-tick" id="cs2-transport-tick">000000</span>
            <span class="cs2-transport-speed" id="cs2-transport-speed" role="group" aria-label="Playback speed"></span>
          </div>
        </div>
      </div>
      <details class="demo-tools" id="demo-tools" ${state.showDemoControls ? 'open' : ''}>
        <summary class="demo-tools-toggle">Demo UI <kbd>Shift+F2</kbd></summary>
        <div class="demo-tools-content">
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
          <div class="demo-tools-panels">
            <div class="cam-toolbar">
              <div class="cam-toolbar-hdr">
                <span class="muted" style="font-size:11px; font-weight:600;">CAMERA &amp; OVERLAYS</span>
                <span class="shortcuts-hint">WASD Free · 1-0 POV · X X-Ray</span>
              </div>
              <div class="spectator-cameras">
                <button class="btn btn-sm" data-cam-mode="tactical" id="btn-cam-tactical">Tactical [T]</button>
                <button class="btn btn-sm" data-cam-mode="free" id="btn-cam-free">Free [F]</button>
                <button class="btn btn-sm" data-cam-mode="pov" id="btn-cam-pov">1st POV</button>
                <button class="btn btn-sm" data-cam-mode="chase" id="btn-cam-chase">Chase [V]</button>
              </div>
              <div class="row">
                <button class="btn btn-sm" id="btn-spec-prev" style="flex:1;">Previous alive [</button>
                <button class="btn btn-sm" id="btn-spec-next" style="flex:1;">Next alive ]</button>
              </div>
              <div class="row">
                <button class="btn btn-sm" id="btn-xray" style="flex:1;">X-Ray [X]</button>
                <button class="btn btn-sm ${state.showPlayerLabels ? 'btn-active' : ''}" id="btn-labels" style="flex:1;">Names [N]</button>
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
          </div>
          <footer class="timeline-bar">
            <div class="rounds-strip">
              ${d.rounds
                .map(
                  (r) => `<button class="round-pill ${r.winner_team === 3 ? 'win-ct' : r.winner_team === 2 ? 'win-t' : ''} ${r.round_number === state.activeRoundNum ? 'active' : ''}" data-round="${r.round_number}" title="Round ${r.round_number}: ${esc(r.win_reason)}">R${r.round_number}</button>`
                )
                .join('')}
            </div>
            <div class="match-transport">
              <label for="match-timeline-scrubber">Match timeline</label>
              <input id="match-timeline-scrubber" type="range" min="${d.rounds[0]?.start_tick || 0}" max="${Math.max(d.rounds.at(-1)?.official_end_tick || 0, d.rounds.at(-1)?.end_tick || 0)}" />
              <button class="btn btn-sm" id="btn-skip-back">−15 s</button>
              <button class="btn btn-sm" id="btn-skip-fwd">+15 s</button>
              <button class="btn btn-sm" id="btn-next-kill">Next kill</button>
              <form class="match-go-to" id="form-go-to-tick">
                <input class="input" id="input-go-to-tick" type="number" step="1" aria-label="Target tick" placeholder="Tick" required />
                <button class="btn btn-sm" type="submit">Go to tick</button>
              </form>
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
        </div>
      </details>
    </main>
  `;
}

function renderModals() {
  let html = '';
  if (state.showScoreboardModal && state.activeDemo) {
    const players = state.activeDemo.players || [];
    const rr = state.roundReplay;
    const f0 = rr?.frames?.[0]?.p;
    const snapPlayers = rr?.frames?.length ? interpolateFrames(rr.frames, sceneInstance?.currentTick ?? rr.frames[0].t)?.players : null;

    const ctList = [];
    const tList = [];
    for (const p of players) {
      const t = getRoundTeamForPlayer(p, rr);
      if (t === 3) ctList.push(p);
      else tList.push(p);
    }

    const renderTeamTable = (title, cls, list, curScore, finalScore) => `
      <section class="sb-team ${cls}">
        <header class="sb-team-hdr ${cls}">
          <span class="sb-team-score">${curScore}</span>
          <span class="sb-team-name">${title}</span>
          <span class="sb-team-final">Match Final: ${finalScore}</span>
        </header>
        <table class="sb-table">
        <thead>
          <tr><th scope="col">Player</th><th scope="col">Money</th><th scope="col">K</th><th scope="col">A</th><th scope="col">D</th><th scope="col">HS%</th><th scope="col">ADR</th><th scope="col">Equip.</th></tr>
        </thead>
        <tbody>
          ${list
            .map((p) => {
              const live = snapPlayers?.[p.slot] || f0?.[p.slot];
              const alive = live ? live[0] === 1 : true;
              const hp = live && live[0] === 1 ? Math.round(live[7]) : 0;
              const money = live && live.length > 15 ? Math.round(live[15] || 0) : 0;
              const eqVal = live && live.length > 18 ? Math.round(live[18] || 0) : 0;
              return `<tr class="${alive ? '' : 'sb-row-dead'} ${p.slot === state.povSlot && (state.cameraMode === 'pov' || state.cameraMode === 'chase') ? 'sb-observed' : ''}">
                <td><span class="sb-player"><span class="sb-slot">${alive ? (p.slot + 1) % 10 : '×'}</span><span class="sb-player-name">${esc(p.name)}</span><span class="sb-player-hp">${alive ? hp : '—'}</span></span></td>
                <td>$${money}</td>
                <td>${p.kills}</td>
                <td>${p.assists}</td>
                <td>${p.deaths}</td>
                <td>${p.hs_pct.toFixed(0)}%</td>
                <td>${p.adr.toFixed(1)}</td>
                <td>$${eqVal}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
        </table>
      </section>
    `;

    const roundSum =
      state.activeDemo.rounds.find((r) => r.round_number === state.activeRoundNum) || rr?.summary;
    const inProgress = (sceneInstance?.currentTick ?? 0) < (roundSum?.end_tick ?? 0);
    const curCT = roundSum ? Math.max(0, roundSum.score_ct - Number(inProgress && roundSum.winner_team === 3)) : state.activeDemo.metadata.score_ct;
    const curT = roundSum ? Math.max(0, roundSum.score_t - Number(inProgress && roundSum.winner_team === 2)) : state.activeDemo.metadata.score_t;
    const final = matchFinalByCurrentSides(
      players, sceneInstance?.roundTeams || new Map(), state.activeDemo.metadata.score_ct, state.activeDemo.metadata.score_t,
    );

    html += `
      <div class="modal-backdrop" id="modal-scoreboard">
        <div class="scoreboard-card" role="dialog" aria-modal="true" aria-label="5v5 Scoreboard">
          <header class="scoreboard-top">
            <div><strong>5v5 Scoreboard</strong><span>Competitive | ${esc(state.activeDemo.metadata.map_name)}</span></div>
            <div class="scoreboard-match-score"><b class="score-ct">${curCT}</b><span class="scoreboard-round">Round ${state.activeRoundNum}/${state.activeDemo.rounds.length}</span><b class="score-t">${curT}</b></div>
            <button class="scoreboard-close" id="btn-close-scoreboard" aria-label="Close scoreboard (Tab)">×</button>
          </header>
          ${renderTeamTable('COUNTER-TERRORISTS', 'ct', ctList, curCT, final.ct)}
          <div class="scoreboard-history" aria-label="Round history">${state.activeDemo.rounds.map((r) =>
            `<span class="${r.round_number >= state.activeRoundNum ? '' : r.winner_team === 3 ? 'ct' : r.winner_team === 2 ? 't' : ''}${r.round_number === state.activeRoundNum ? ' current' : ''}" title="Round ${r.round_number}">${r.round_number}</span>`,
          ).join('')}</div>
          ${renderTeamTable('TERRORISTS', 't', tList, curT, final.t)}
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
      ${state.view === 'library' ? renderTopbar() : ''}
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
  const demoTools = document.getElementById('demo-tools');
  demoTools.addEventListener('toggle', () => { state.showDemoControls = demoTools.open; });
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
      onRoundEnd: advanceRound,
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
  updateViewerControlsDOM();
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
  document.getElementById('btn-spec-prev')?.addEventListener('click', () => cycleSpectator(-1));
  document.getElementById('btn-spec-next')?.addEventListener('click', () => cycleSpectator(1));

  document.getElementById('btn-xray')?.addEventListener('click', () => {
    state.xray = !state.xray;
    sceneInstance?.setXray(state.xray);
    updateViewerControlsDOM();
  });
  document.getElementById('btn-labels')?.addEventListener('click', () => {
    state.showPlayerLabels = !state.showPlayerLabels;
    sceneInstance?.setPlayerLabels(state.showPlayerLabels);
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

  document.getElementById('btn-play')?.addEventListener('click', togglePlayback);

  // Native transport bar (CS2 demo player style)
  const transportTimeline = document.getElementById('cs2-transport-timeline');
  const transportStep = (delta) => {
    if (!sceneInstance || !state.roundReplay?.frames?.length) return;
    const minT = state.roundReplay.frames[0].t;
    const maxT = state.roundReplay.frames[state.roundReplay.frames.length - 1].t;
    sceneInstance.playing = false;
    sceneInstance.currentTick = Math.max(minT, Math.min(maxT, sceneInstance.currentTick + delta));
  };
  const transportSkip = (seconds) => {
    if (!sceneInstance || !state.roundReplay) return;
    seekMatchTick(sceneInstance.currentTick + seconds * state.roundReplay.tick_rate);
  };
  document.getElementById('cs2-btn-play')?.addEventListener('click', togglePlayback);
  document.getElementById('cs2-btn-step-back')?.addEventListener('click', () => transportStep(-1));
  document.getElementById('cs2-btn-step-fwd')?.addEventListener('click', () => transportStep(1));
  document.getElementById('cs2-btn-skip-back')?.addEventListener('click', () => transportSkip(-15));
  document.getElementById('cs2-btn-skip-fwd')?.addEventListener('click', () => transportSkip(15));
  document.getElementById('cs2-btn-prev-round')?.addEventListener('click', () => {
    const rounds = state.activeDemo?.rounds || [];
    const prev = [...rounds].reverse().find((r) => r.round_number < state.activeRoundNum);
    if (prev) switchRound(prev.round_number);
  });
  document.getElementById('cs2-btn-next-round')?.addEventListener('click', () => {
    const rounds = state.activeDemo?.rounds || [];
    const next = rounds.find((r) => r.round_number > state.activeRoundNum);
    if (next) switchRound(next.round_number);
  });
  document.getElementById('cs2-btn-prev-player')?.addEventListener('click', () => cycleSpectator(-1));
  document.getElementById('cs2-btn-next-player')?.addEventListener('click', () => cycleSpectator(1));
  transportTimeline?.addEventListener('click', (e) => {
    if (!sceneInstance || !state.roundReplay?.frames?.length) return;
    if (e.target.classList.contains('cs2-transport-marker')) {
      const t = Number(e.target.dataset.tick);
      if (!Number.isNaN(t)) sceneInstance.currentTick = t;
      return;
    }
    const rect = transportTimeline.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const minT = state.roundReplay.frames[0].t;
    const maxT = state.roundReplay.frames[state.roundReplay.frames.length - 1].t;
    sceneInstance.playing = false;
    sceneInstance.currentTick = Math.round(minT + ratio * (maxT - minT));
  });
  const transportSpeed = document.getElementById('cs2-transport-speed');
  if (transportSpeed) {
    transportSpeed.innerHTML = SPEEDS.map((sp) =>
      `<button type="button" class="cs2-transport-speed-btn${state.playbackSpeed === sp ? ' active' : ''}" data-speed="${sp}">${sp}x</button>`
    ).join('');
    transportSpeed.querySelectorAll('[data-speed]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.playbackSpeed = Number(btn.dataset.speed) || 1;
        if (sceneInstance) sceneInstance.playbackSpeed = state.playbackSpeed;
        transportSpeed.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', b === btn));
        const traySpeed = document.getElementById('select-speed');
        if (traySpeed) traySpeed.value = String(state.playbackSpeed);
      });
    });
  }
  document.getElementById('match-timeline-scrubber')?.addEventListener('change', (e) => seekMatchTick(Number(e.target.value)));
  for (const [id, seconds] of [['btn-skip-back', -15], ['btn-skip-fwd', 15]]) {
    document.getElementById(id)?.addEventListener('click', () => {
      if (sceneInstance && state.roundReplay) seekMatchTick(sceneInstance.currentTick + seconds * state.roundReplay.tick_rate);
    });
  }
  document.getElementById('btn-next-kill')?.addEventListener('click', () => {
    const current = sceneInstance?.currentTick;
    const next = state.activeDemo?.kills?.find((kill) => kill.tick > current);
    if (next) seekMatchTick(next.tick);
  });
  document.getElementById('form-go-to-tick')?.addEventListener('submit', (e) => {
    e.preventDefault();
    seekMatchTick(document.getElementById('input-go-to-tick').valueAsNumber);
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
  if (e.code === 'F2' && e.shiftKey) {
    e.preventDefault();
    const tools = document.getElementById('demo-tools');
    if (tools && !e.repeat) tools.open = !tools.open;
    return;
  }
  if (e.code === 'Escape' && state.showScoreboardModal) {
    state.showScoreboardModal = false;
    renderModalsDOM();
    return;
  }
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
    togglePlayback();
  } else if (e.code === 'PageUp' || e.code === 'PageDown' || e.code === 'BracketLeft' || e.code === 'BracketRight') {
    e.preventDefault();
    cycleSpectator(e.code === 'PageUp' || e.code === 'BracketLeft' ? -1 : 1);
  } else if (e.code === 'KeyV') {
    sceneInstance.setCameraMode('chase', state.povSlot);
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
  } else if (e.code === 'KeyN') {
    state.showPlayerLabels = !state.showPlayerLabels;
    sceneInstance.setPlayerLabels(state.showPlayerLabels);
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
      state.cameraMode = state.cameraMode === 'chase' ? 'chase' : 'pov';
      state.povSlot = slot;
      sceneInstance.setCameraMode(state.cameraMode, slot);
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
