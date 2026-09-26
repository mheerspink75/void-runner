/**
 * audio.js — Fully procedural audio via the Web Audio API.
 *
 * No sample files: every sound is synthesized (oscillators + noise buffers).
 * Includes a 3D-ish panner helper so enemy sounds attenuate by distance.
 */

import { clamp, rand } from './utils.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.listener = { x: 0, y: 0, z: 0, fx: 0, fz: -1 };
    this.muted = false;
    this.ready = false;
    this._noise = null;
    this._musicTimer = null;
    this._step = 0;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Must be called from a user gesture (browsers block autoplay). */
  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);

    // Gentle limiter so overlapping explosions never clip.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.limiter.connect(this.master);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.limiter);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.0;
    this.musicBus.connect(this.limiter);

    // Shared reverb-ish send for a bit of space.
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = this._impulse(1.6, 2.6);
    this.verbGain = this.ctx.createGain();
    this.verbGain.gain.value = 0.22;
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.limiter);

    this._buildNoise();
    this.ready = true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  toggleMute() { return this.setMuted(!this.muted); }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  // ------------------------------------------------------------------
  // Buffers
  // ------------------------------------------------------------------

  _buildNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;
  }

  _impulse(duration, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * duration);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // ------------------------------------------------------------------
  // Low-level helpers
  // ------------------------------------------------------------------

  /** Distance + direction aware panner node for a world position. */
  _panner(x, y, z, maxDist = 55) {
    const L = this.listener;
    const dx = x - L.x, dy = y - L.y, dz = z - L.z;
    const dist = Math.hypot(dx, dy, dz);
    const atten = clamp(1 - dist / maxDist, 0, 1);
    const g = this.ctx.createGain();
    g.gain.value = atten * atten;

    if (dist > 0.2) {
      const p = this.ctx.createStereoPanner
        ? this.ctx.createStereoPanner()
        : null;
      if (p) {
        // Project onto the listener's right vector (fx, fz) to get L/R.
        const rx = -L.fz, rz = L.fx;
        const pan = clamp((dx * rx + dz * rz) / dist, -1, 1);
        p.pan.value = pan;
        p.connect(g);
        g.connect(this.sfxBus);
        return { node: g, atten, dist };
      }
    }
    g.connect(this.sfxBus);
    return { node: g, atten, dist };
  }

  _osc(type, freq, dur, gain, dest, detune = 0) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    g.gain.value = 0;
    o.connect(g);
    g.connect(dest || this.sfxBus);
    const t = this.now;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.02);
    return { o, g, t };
  }

  _burst(dur, gain, dest, filterType = 'lowpass', freq = 2000, q = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(dest || this.sfxBus);
    const t = this.now;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.start(t);
    src.stop(t + dur + 0.02);
    return { src, f, g, t };
  }

  // ------------------------------------------------------------------
  // Weapon sounds
  // ------------------------------------------------------------------

  rifleShot() {
    if (!this.ready || this.muted) return;
    // Sharp crack
    this._burst(0.09, 0.5, this.sfxBus, 'highpass', 1400, 0.7);
    // Body thump
    const { o } = this._osc('square', 180, 0.1, 0.28);
    o.frequency.exponentialRampToValueAtTime(52, this.now + 0.09);
    // High zing tail
    this._osc('sawtooth', 2400, 0.07, 0.09);
    // Room tail
    const b = this._burst(0.3, 0.13, this.verb, 'lowpass', 900);
    b.g.gain.setValueAtTime(0.13, this.now);
  }

  scatterShot() {
    if (!this.ready || this.muted) return;
    this._burst(0.22, 0.65, this.sfxBus, 'lowpass', 2400, 0.4);
    const { o } = this._osc('sawtooth', 120, 0.28, 0.35);
    o.frequency.exponentialRampToValueAtTime(35, this.now + 0.26);
    this._burst(0.55, 0.28, this.verb, 'lowpass', 700);
  }

  /**
   * Grenade launcher report: a lower, airier thump than the rifle — it is
   * propelling a heavy shell in an arc, not a flat bullet. Plus a short
   * pneumatic hiss on the release.
   */
  launcherShot() {
    if (!this.ready || this.muted) return;
    // Wide low thump
    this._burst(0.16, 0.5, this.sfxBus, 'lowpass', 900, 0.5);
    const { o } = this._osc('square', 120, 0.2, 0.3);
    o.frequency.exponentialRampToValueAtTime(38, this.now + 0.18);
    // Pneumatic release
    this._burst(0.2, 0.14, this.sfxBus, 'bandpass', 1800, 1.2);
    // Room tail
    this._burst(0.45, 0.18, this.verb, 'lowpass', 620);
  }

  dryFire() {
    if (!this.ready || this.muted) return;
    this._osc('square', 1400, 0.045, 0.14);
    this._osc('square', 900, 0.035, 0.09);
  }

  reloadStep(i = 0) {
    if (!this.ready || this.muted) return;
    const f = [520, 380, 700][i % 3];
    this._osc('square', f, 0.06, 0.15);
    this._burst(0.05, 0.14, this.sfxBus, 'bandpass', 2600, 2.5);
  }

  reloadDone() {
    if (!this.ready || this.muted) return;
    this._osc('triangle', 900, 0.1, 0.2);
    this._osc('triangle', 1350, 0.14, 0.16);
  }

  weaponSwap() {
    if (!this.ready || this.muted) return;
    this._osc('triangle', 300, 0.08, 0.16);
    this._osc('triangle', 480, 0.1, 0.13);
  }

  // ------------------------------------------------------------------
  // Impact / hit sounds
  // ------------------------------------------------------------------

  impact(x, y, z, crit = false) {
    if (!this.ready || this.muted) return;
    const p = this._panner(x, y, z, 70);
    if (p.atten <= 0.01) return;
    if (crit) {
      this._osc('square', 1500, 0.08, 0.3 * p.atten, p.node);
      this._osc('sine', 2400, 0.16, 0.2 * p.atten, p.node);
    } else {
      this._burst(0.06, 0.3 * p.atten, p.node, 'bandpass', 1800, 1.2);
      this._osc('triangle', 620, 0.05, 0.14 * p.atten, p.node);
    }
  }

  flesh(x, y, z) {
    if (!this.ready || this.muted) return;
    const p = this._panner(x, y, z, 60);
    if (p.atten <= 0.01) return;
    this._burst(0.12, 0.42 * p.atten, p.node, 'lowpass', 700, 0.8);
    this._osc('sine', 110, 0.1, 0.22 * p.atten, p.node);
  }

  // ------------------------------------------------------------------
  // Enemy sounds
  // ------------------------------------------------------------------

  growl(x, y, z, kind = 'grunt') {
    if (!this.ready || this.muted) return;
    const p = this._panner(x, y, z, 48);
    if (p.atten <= 0.01) return;
    const base = kind === 'brute' ? 55 : kind === 'stalker' ? 190 : 105;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = kind === 'stalker' ? 1400 : 620;
    o.type = kind === 'stalker' ? 'sine' : 'sawtooth';
    o.frequency.setValueAtTime(base, this.now);
    o.frequency.exponentialRampToValueAtTime(base * 0.55, this.now + 0.5);
    // Vibrato for a throaty quality
    const lfo = this.ctx.createOscillator();
    const lfoG = this.ctx.createGain();
    lfo.frequency.value = 7;
    lfoG.gain.value = base * 0.16;
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    g.gain.setValueAtTime(0, this.now);
    g.gain.linearRampToValueAtTime(0.3 * p.atten, this.now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, this.now + 0.55);
    o.connect(f); f.connect(g); g.connect(p.node);
    o.start(this.now); lfo.start(this.now);
    o.stop(this.now + 0.6); lfo.stop(this.now + 0.6);
  }

  enemyDeath(x, y, z) {
    if (!this.ready || this.muted) return;
    const p = this._panner(x, y, z, 70);
    if (p.atten <= 0.01) return;
    this._burst(0.4, 0.5 * p.atten, p.node, 'lowpass', 900, 0.7);
    const { o } = this._osc('sawtooth', 220, 0.42, 0.3 * p.atten, p.node);
    o.frequency.exponentialRampToValueAtTime(38, this.now + 0.4);
    this._burst(0.6, 0.2 * p.atten, this.verb, 'lowpass', 600);
  }

  playerHurt() {
    if (!this.ready || this.muted) return;
    this._osc('sawtooth', 320, 0.22, 0.3);
    this._burst(0.25, 0.3, this.sfxBus, 'lowpass', 800);
  }

  playerDeath() {
    if (!this.ready || this.muted) return;
    const { o } = this._osc('sawtooth', 260, 1.6, 0.4);
    o.frequency.exponentialRampToValueAtTime(28, this.now + 1.5);
    this._burst(1.4, 0.35, this.sfxBus, 'lowpass', 500);
    this._burst(1.0, 0.3, this.verb, 'lowpass', 400);
  }

  enemyShoot(x, y, z) {
    if (!this.ready || this.muted) return;
    const p = this._panner(x, y, z, 75);
    if (p.atten <= 0.01) return;
    this._burst(0.12, 0.32 * p.atten, p.node, 'bandpass', 900, 1.4);
    const { o } = this._osc('square', 420, 0.11, 0.18 * p.atten, p.node);
    o.frequency.exponentialRampToValueAtTime(120, this.now + 0.1);
  }

  // ------------------------------------------------------------------
  // UI / pickup sounds
  // ------------------------------------------------------------------

  uiClick() {
    if (!this.ready || this.muted) return;
    this._osc('square', 880, 0.05, 0.12);
  }

  pickup(kind = 'ammo') {
    if (!this.ready || this.muted) return;
    if (kind === 'health') {
      this._osc('sine', 520, 0.14, 0.22);
      this._osc('sine', 780, 0.2, 0.18);
    } else {
      this._osc('square', 660, 0.06, 0.16);
      this._osc('square', 990, 0.1, 0.14);
    }
  }

  waveStart(n) {
    if (!this.ready || this.muted) return;
    const base = 180 * Math.pow(1.06, n);
    [0, 0.14, 0.3].forEach((d, i) => {
      setTimeout(() => {
        if (!this.ready) return;
        this._osc('sawtooth', base * (i + 1), 0.4, 0.24);
        this._osc('sine', base * (i + 1) * 0.5, 0.5, 0.2);
      }, d * 1000);
    });
    this._burst(1.0, 0.2, this.verb, 'lowpass', 800);
  }

  waveClear() {
    if (!this.ready || this.muted) return;
    [523, 659, 784, 1047].forEach((f, i) => {
      setTimeout(() => this.ready && this._osc('triangle', f, 0.35, 0.2), i * 110);
    });
  }

  victory() {
    if (!this.ready || this.muted) return;
    [392, 523, 659, 784, 1047, 1319].forEach((f, i) => {
      setTimeout(() => {
        if (!this.ready) return;
        this._osc('triangle', f, 0.7, 0.22);
        this._osc('sine', f * 0.5, 0.8, 0.16);
      }, i * 150);
    });
  }

  // ------------------------------------------------------------------
  // Music: a slow evolving synth pad + pulse, driven by a scheduler
  // ------------------------------------------------------------------

  startMusic() {
    if (!this.ready || this._musicTimer) return;
    this.musicBus.gain.cancelScheduledValues(this.now);
    this.musicBus.gain.setTargetAtTime(0.3, this.now, 1.5);
    this._step = 0;
    this._musicTimer = setInterval(() => this._musicTick(), 500);
  }

  stopMusic() {
    if (this._musicTimer) {
      clearInterval(this._musicTimer);
      this._musicTimer = null;
    }
    if (this.musicBus) {
      this.musicBus.gain.setTargetAtTime(0, this.now, 0.4);
    }
  }

  /** Tension 0..1 raises the tempo and adds layers. */
  setTension(t) { this._tension = clamp(t, 0, 1); }

  _musicTick() {
    if (!this.ready || this.muted) return;
    const t = this.now;
    const step = this._step++;
    const tension = this._tension || 0;

    // Minor key root movement: Am → F → C → G (i - VI - III - VII)
    const roots = [110, 87.31, 130.81, 98];
    const bar = Math.floor(step / 8) % 4;
    const root = roots[bar];

    // Bass pulse on every 4th step
    if (step % 4 === 0) {
      this._osc('sine', root / 2, 0.7, 0.5, this.musicBus);
      this._osc('triangle', root / 2, 0.5, 0.18, this.musicBus);
    }

    // Arp appears with tension
    if (tension > 0.2 && step % 2 === 0) {
      const scale = [0, 3, 5, 7, 10, 12];
      const semi = scale[(step / 2) % scale.length];
      const f = root * 2 * Math.pow(2, semi / 12);
      this._osc('square', f, 0.22, 0.06 * tension, this.musicBus);
    }

    // Hat / tick
    if (step % 2 === 1 && tension > 0.45) {
      this._burst(0.04, 0.06 * tension, this.musicBus, 'highpass', 6000);
    }

    // Pad swell at the top of each bar
    if (step % 8 === 0) {
      [0, 7, 15].forEach((semi) => {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 700 + tension * 1600;
        o.type = 'sawtooth';
        o.frequency.value = root * 2 * Math.pow(2, semi / 12);
        o.detune.value = rand(-8, 8);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.035 + tension * 0.03, t + 0.9);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
        o.connect(f); f.connect(g); g.connect(this.musicBus);
        g.connect(this.verb);
        o.start(t); o.stop(t + 3.7);
      });
    }
  }

  // ------------------------------------------------------------------
  // Listener update (called each frame)
  // ------------------------------------------------------------------

  setListener(pos, forward) {
    this.listener.x = pos.x;
    this.listener.y = pos.y;
    this.listener.z = pos.z;
    this.listener.fx = forward.x;
    this.listener.fz = forward.z;
  }
}

export const audio = new AudioEngine();
