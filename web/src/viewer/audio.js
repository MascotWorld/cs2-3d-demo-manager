// Lightweight Web Audio API synthesizer for CS2-style feedback (no external audio assets needed).

export class DemoAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.lastShotTick = -1;
    this.lastKillTick = -1;
    this.lastPlantTick = -1;
    this.lastBeepSecond = -1;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled && !this.ctx && typeof window !== 'undefined') {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        try {
          this.ctx = new AC();
        } catch {
          this.ctx = null;
        }
      }
    }
    if (this.enabled && this.ctx?.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  resetRound() {
    this.lastShotTick = -1;
    this.lastKillTick = -1;
    this.lastPlantTick = -1;
    this.lastBeepSecond = -1;
  }

  _tone(freq, dur, type = 'sine', gainVal = 0.05) {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  }

  _shotNoise(gainVal = 0.045) {
    if (!this.enabled || !this.ctx) return;
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 0.07);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.015));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 950;
    const gain = this.ctx.createGain();
    gain.gain.value = gainVal;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    src.start();
  }

  processTick({ playing, roundReplay, currentTick, clockInfo, povSlot, cameraMode }) {
    if (!this.enabled || !playing || !roundReplay) return;
    const tick = Math.round(currentTick);

    for (const sh of roundReplay.shots || []) {
      if (sh.tick > this.lastShotTick && sh.tick <= tick && tick - sh.tick <= 4) {
        const vol = cameraMode === 'pov' && sh.slot === povSlot ? 0.08 : 0.03;
        this._shotNoise(vol);
        this.lastShotTick = sh.tick;
        break;
      }
    }

    for (const k of roundReplay.kills || []) {
      if (k.tick > this.lastKillTick && k.tick <= tick && tick - k.tick <= 8) {
        this._tone(k.headshot ? 1120 : 620, 0.11, 'triangle', 0.06);
        this.lastKillTick = k.tick;
        break;
      }
    }

    if (clockInfo?.phase === 'planted') {
      const sec = Math.floor(clockInfo.secondsLeft * (clockInfo.secondsLeft < 10 ? 2 : 1));
      if (sec !== this.lastBeepSecond) {
        this.lastBeepSecond = sec;
        this._tone(1680, 0.045, 'square', 0.03);
      }
    }
  }
}
