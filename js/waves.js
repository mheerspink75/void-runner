/**
 * waves.js — Wave director: decides what spawns when, and advances waves.
 */

import { CONFIG } from './config.js';
import { weightedPick, rand, clamp } from './utils.js';

const W = CONFIG.waves;

export class WaveDirector {
  constructor(enemyManager, audio) {
    this.enemies = enemyManager;
    this.audio = audio;

    this.wave = 0;
    this.state = 'idle';       // idle | break | spawning | fighting | complete
    this.stateT = 0;
    this.toSpawn = [];         // queue of enemy kinds
    this.spawnTimer = 0;
    this.won = false;
  }

  reset() {
    this.wave = 0;
    this.state = 'idle';
    this.stateT = 0;
    this.toSpawn.length = 0;
    this.spawnTimer = 0;
    this.won = false;
  }

  start() {
    this.reset();
    this._beginWave();
  }

  // ------------------------------------------------------------------
  // Wave composition
  // ------------------------------------------------------------------
  _buildQueue(n) {
    // Escalating mix. The `cost` field in CONFIG lets the director spend a
    // budget rather than counting bodies, so waves ramp smoothly.
    const mix = { ...W.mix };
    if (n >= 2) mix.stalker = clamp(0.18 + (n - 2) * 0.06, 0, 0.5);
    if (n >= 3) mix.spitter = clamp(0.12 + (n - 3) * 0.05, 0, 0.32);
    if (n >= 5) mix.brute = clamp(0.08 + (n - 5) * 0.04, 0, 0.3);

    // Spend a difficulty budget so tougher units replace trash over time.
    const budget = 6 + n * 2.6;
    const q = [];
    let spent = 0;
    let guard = 0;

    while (q.length < n && guard++ < n * 12) {
      const kind = weightedPick(mix);
      const cost = CONFIG.enemies[kind]?.cost ?? 1;
      // Do not let a single unit blow the whole budget early
      if (spent + cost > budget * 1.35) continue;
      q.push(kind);
      spent += cost;
    }
    // Top up if the budget blocked progress
    while (q.length < n) q.push('grunt');

    // Guarantee the signature units actually appear when advertised
    if (n >= 5 && !q.includes('brute')) q[q.length - 1] = 'brute';
    if (n >= 3 && !q.includes('spitter')) q[q.length - 1] = 'spitter';
    if (n >= 2 && !q.includes('stalker')) q[q.length - 2 % q.length] = 'stalker';

    return q;
  }

  _beginWave() {
    this.wave++;
    const count = Math.round(W.baseCount + this.wave * W.countGrowth);
    this.toSpawn = this._buildQueue(count);
    this.enemies.setWave?.(this.wave);
    this.state = 'spawning';
    this.stateT = 0;
    // Faster spawn cadence as waves get bigger, but still readable
    this.spawnTimer = 0.5;
    this.audio.waveStart(this.wave);
    this.onWaveStart?.(this.wave, count);
  }

  // ------------------------------------------------------------------
  // Update
  // ------------------------------------------------------------------
  update(dt) {
    this.stateT += dt;

    switch (this.state) {
      case 'break': {
        if (this.stateT >= W.breakTime) {
          if (this.wave >= W.total) {
            this.state = 'complete';
            this.won = true;
            this.onVictory?.();
          } else {
            this._beginWave();
          }
        }
        break;
      }

      case 'spawning': {
        this.spawnTimer -= dt;
        const alive = this.enemies.aliveCount;
        if (this.toSpawn.length && this.spawnTimer <= 0 && alive < W.maxAlive) {
          const kind = this.toSpawn.shift();
          this.enemies.spawn(kind);
          this.spawnTimer = rand(0.4, 0.9);
        }
        if (!this.toSpawn.length) {
          this.state = 'fighting';
          this.stateT = 0;
        }
        break;
      }

      case 'fighting': {
        if (this.enemies.aliveCount === 0) {
          this.audio.waveClear();
          this.onWaveClear?.(this.wave);
          if (this.wave >= W.total) {
            this.state = 'complete';
            this.won = true;
            this.onVictory?.();
          } else {
            this.state = 'break';
            this.stateT = 0;
          }
        }
        break;
      }
    }
  }

  get totalWaves() { return W.total; }
  get progress() {
    return clamp(this.wave / W.total, 0, 1);
  }
}
