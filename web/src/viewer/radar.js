// Pure 2D Tactical Radar renderer (uses CS2 radar PNG with Valve overview calibration, else CSGEO1 contour).
import { worldToOverviewRadar } from './math.js';

export class RadarRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.radarData = null;
    this.image = null;
    this.lowerImage = null;
    this.contourCanvas = null;
  }

  setRadarData(data) {
    this.radarData = data || null;
    this.image = null;
    this.lowerImage = null;
    this.contourCanvas = null;

    if (data?.image_url) {
      const img = new Image();
      img.onload = () => {
        this.image = img;
      };
      img.src = data.image_url;
    }

    if (data?.lower_image_url) {
      const limg = new Image();
      limg.onload = () => {
        this.lowerImage = limg;
      };
      limg.src = data.lower_image_url;
    }

    if (data?.contour?.cells?.length) {
      this._buildContourCanvas(data.contour);
    }
  }

  _buildContourCanvas(contour) {
    const off = document.createElement('canvas');
    off.width = contour.width;
    off.height = contour.height;
    const octx = off.getContext('2d');
    const imgData = octx.createImageData(contour.width, contour.height);
    const d = imgData.data;

    for (let cy = 0; cy < contour.height; cy++) {
      const dstY = contour.height - 1 - cy;
      for (let cx = 0; cx < contour.width; cx++) {
        const cell = contour.cells[cy * contour.width + cx];
        const idx = (dstY * contour.width + cx) * 4;
        if (cell === 2) {
          // Walkable corridor/bombsite floor (clean slate blue-gray)
          d[idx] = 68;
          d[idx + 1] = 88;
          d[idx + 2] = 116;
          d[idx + 3] = 240;
        } else if (cell === 1) {
          // Solid wall/structure
          d[idx] = 28;
          d[idx + 1] = 37;
          d[idx + 2] = 52;
          d[idx + 3] = 245;
        } else {
          d[idx + 3] = 0;
        }
      }
    }
    octx.putImageData(imgData, 0, 0);
    this.contourCanvas = off;
  }

  _worldToRadar(x, y, w, h, bounds, useOverview) {
    if (useOverview && this.radarData?.overview) {
      const ov = worldToOverviewRadar(x, y, w, this.radarData.overview);
      if (ov) return ov;
    }
    const minX = bounds.minX;
    const maxX = bounds.maxX;
    const minY = bounds.minY;
    const maxY = bounds.maxY;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const pad = 10;
    const innerW = w - pad * 2;
    const innerH = h - pad * 2;
    const scale = Math.min(innerW / spanX, innerH / spanY);
    const offX = pad + (innerW - spanX * scale) * 0.5;
    const offY = pad + (innerH - spanY * scale) * 0.5;
    return [offX + (x - minX) * scale, offY + (maxY - y) * scale];
  }

  render({ snapshot, roundReplay, currentTick, povSlot, cameraMode, mapBounds, cameraWorldZ = null }) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(13, 18, 28, 0.95)';
    ctx.fillRect(0, 0, w, h);

    const ov = this.radarData?.overview;
    const lowerZ = typeof ov?.lower_z === 'number' ? ov.lower_z : null;
    let isLowerLevel = false;
    if (lowerZ !== null && snapshot?.players) {
      if (cameraMode === 'pov' && snapshot.players[povSlot]?.[0] === 1) {
        isLowerLevel = snapshot.players[povSlot][4] < lowerZ;
      } else if (cameraMode === 'free' && typeof cameraWorldZ === 'number') {
        isLowerLevel = cameraWorldZ < lowerZ;
      }
    }

    const activeImg = isLowerLevel && this.lowerImage ? this.lowerImage : this.image;
    const useOverview = !!(activeImg && ov);

    const c = this.radarData?.contour;
    const bounds = c
      ? { minX: c.min_x, maxX: c.max_x, minY: c.min_y, maxY: c.max_y }
      : {
          minX: mapBounds?.min?.[0] ?? -2000,
          maxX: mapBounds?.max?.[0] ?? 2000,
          minY: -(mapBounds?.max?.[2] ?? 2000),
          maxY: -(mapBounds?.min?.[2] ?? -2000),
        };

    if (activeImg) {
      ctx.globalAlpha = 0.94;
      ctx.drawImage(activeImg, 0, 0, w, h);
      ctx.globalAlpha = 1;
    } else if (this.contourCanvas) {
      const [x0, y1] = this._worldToRadar(bounds.minX, bounds.minY, w, h, bounds, false);
      const [x1, y0] = this._worldToRadar(bounds.maxX, bounds.maxY, w, h, bounds, false);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.contourCanvas, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      ctx.imageSmoothingEnabled = true;
    }

    // Update level label if multi-level map
    const lvlBadge = document.getElementById('radar-level-badge');
    if (lvlBadge) {
      if (lowerZ !== null) {
        lvlBadge.style.display = 'inline-block';
        lvlBadge.textContent = isLowerLevel ? 'LOWER' : 'UPPER';
      } else {
        lvlBadge.style.display = 'none';
      }
    }

    if (!snapshot || !roundReplay) return;
    const tickRate = roundReplay.tick_rate || 64;

    // Active Infernos (Molotov / Incendiary)
    for (const inf of roundReplay.infernos || []) {
      if (currentTick < inf.start_tick || (inf.end_tick > 0 && currentTick > inf.end_tick)) continue;
      const pts = inf.points?.length ? inf.points : inf.center ? [inf.center] : [];
      ctx.fillStyle = 'rgba(249, 115, 22, 0.56)';
      for (const pt of pts) {
        const [rx, ry] = this._worldToRadar(pt[0], pt[1], w, h, bounds, useOverview);
        ctx.beginPath();
        ctx.arc(rx, ry, 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Active Smokes
    for (const sm of roundReplay.smokes || []) {
      if (currentTick < sm.start_tick || currentTick > sm.end_tick) continue;
      const [rx, ry] = this._worldToRadar(sm.position[0], sm.position[1], w, h, bounds, useOverview);
      ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(rx, ry, 8.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Active Grenades in flight
    for (const g of roundReplay.grenades || []) {
      if (!g.traj?.length) continue;
      const tEnd = g.det_tick || g.end_tick || g.traj[g.traj.length - 1][0];
      if (currentTick < g.throw_tick || currentTick > tEnd) continue;
      let pt = g.traj[g.traj.length - 1];
      for (let i = 0; i < g.traj.length; i++) {
        if (g.traj[i][0] >= currentTick) {
          pt = g.traj[i];
          break;
        }
      }
      const [rx, ry] = this._worldToRadar(pt[1], pt[2], w, h, bounds, useOverview);
      ctx.fillStyle =
        g.type === 'flash'
          ? '#fef08a'
          : g.type === 'he'
          ? '#ef4444'
          : g.type === 'smoke'
          ? '#cbd5e1'
          : '#fb923c';
      ctx.beginPath();
      ctx.arc(rx, ry, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Recent gunshot flashes
    const flashWin = Math.max(4, Math.round(0.22 * tickRate));
    for (const sh of roundReplay.shots || []) {
      if (sh.tick > currentTick || currentTick - sh.tick > flashWin) continue;
      const [rx, ry] = this._worldToRadar(sh.origin[0], sh.origin[1], w, h, bounds, useOverview);
      ctx.strokeStyle = 'rgba(253, 224, 71, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rx, ry, 6.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Bomb
    if (snapshot.bomb && snapshot.bomb[4] !== 5) {
      const [bx, by] = this._worldToRadar(snapshot.bomb[0], snapshot.bomb[1], w, h, bounds, useOverview);
      const bState = snapshot.bomb[4];
      const pulse = bState === 3 ? 0.55 + 0.45 * Math.sin(performance.now() * 0.015) : 1;
      ctx.fillStyle = bState === 3 ? `rgba(239, 68, 68, ${pulse})` : '#facc15';
      ctx.fillRect(bx - 3.5, by - 3.5, 7, 7);
      if (bState === 3) {
        ctx.strokeStyle = '#fca5a5';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(bx, by, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Dead player X marks
    const players = snapshot.players || [];
    for (let slot = 0; slot < players.length; slot++) {
      const p = players[slot];
      if (!p || p[0] === 1 || (p[2] === 0 && p[3] === 0)) continue;
      const [rx, ry] = this._worldToRadar(p[2], p[3], w, h, bounds, useOverview);
      ctx.strokeStyle = p[1] === 3 ? 'rgba(75,163,255,0.5)' : 'rgba(245,166,35,0.5)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(rx - 3, ry - 3);
      ctx.lineTo(rx + 3, ry + 3);
      ctx.moveTo(rx + 3, ry - 3);
      ctx.lineTo(rx - 3, ry + 3);
      ctx.stroke();
    }

    // Alive players with FOV cones & slot numbers
    for (let slot = 0; slot < players.length; slot++) {
      const p = players[slot];
      if (!p || p[0] !== 1) continue;
      const [rx, ry] = this._worldToRadar(p[2], p[3], w, h, bounds, useOverview);
      const yawRad = (p[5] * Math.PI) / 180;
      const dirX = Math.cos(yawRad);
      const dirY = -Math.sin(yawRad);
      const isObs = cameraMode === 'pov' && povSlot === slot;
      const color = isObs ? '#ffffff' : p[1] === 3 ? '#8fa7d6' : '#e9b160';
      const sameFloor = lowerZ === null || (p[4] < lowerZ) === isLowerLevel;
      ctx.globalAlpha = sameFloor ? 1.0 : 0.4;
      const heading = Math.atan2(dirY, dirX);

      // Only the spectated player shows a facing wedge, like the native radar
      if (isObs) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.arc(rx, ry, 20, heading - 0.4, heading + 0.4);
        ctx.closePath();
        ctx.fill();
      }

      // Player marker: heading triangle, team colored
      const size = isObs ? 6.6 : 5.2;
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(6, 8, 11, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rx + Math.cos(heading) * size, ry + Math.sin(heading) * size);
      ctx.lineTo(rx + Math.cos(heading + 2.5) * size * 0.82, ry + Math.sin(heading + 2.5) * size * 0.82);
      ctx.lineTo(rx + Math.cos(heading - 2.5) * size * 0.82, ry + Math.sin(heading - 2.5) * size * 0.82);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }
  }
}
