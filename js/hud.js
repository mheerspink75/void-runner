/**
 * hud.js — DOM HUD binding: health, ammo, score, wave banner, killfeed,
 * minimap, and screen feedback (hitmarker, damage vignette).
 */

import { CONFIG } from './config.js';
import { clamp, fmt } from './utils.js';

export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'),
      score: $('stat-score'),
      wave: $('stat-wave'),
      enemies: $('stat-enemies'),
      banner: $('wave-banner'),
      bannerTitle: $('wave-banner').querySelector('h2'),
      bannerSub: $('wave-banner').querySelector('p'),
      barHealth: $('bar-health'),
      textHealth: $('text-health'),
      barStamina: $('bar-stamina'),
      staminaShell: $('stamina-shell'),
      barAmmo: $('bar-ammo'),
      textAmmo: $('text-ammo'),
      textReserve: $('text-ammo-reserve'),
      textWeapon: $('text-weapon'),
      slotRow: $('weapon-slots'),
      reloadHint: $('reload-hint'),
      chargeBar: $('charge-bar'),
      barCharge: $('bar-charge'),
      abDash: $('ab-dash'),
      abDashFill: $('ab-dash-fill'),
      abMelee: $('ab-melee'),
      abMeleeFill: $('ab-melee-fill'),
      overdrive: $('overdrive'),
      odFill: $('od-fill'),
      hitmarker: $('hitmarker'),
      crosshair: $('crosshair'),
      damageVig: $('damage-vignette'),
      lowVig: $('lowhealth-vignette'),
      flash: $('flash'),
      killfeed: $('killfeed'),
      minimap: $('minimap'),
      buffOverdrive: $('buff-overdrive'),
      buffOverdriveTimer: $('overdrive-timer'),
      buffDash: $('buff-dash'),
      buffDashTimer: $('dash-timer'),
    };

    this.ctx = this.el.minimap.getContext('2d');
    this._lastScore = 0;
    this._lastHealth = -1;
    this._lastAmmo = '-1';
    this._lastEnemies = -1;
    this._lastWave = -1;
    this._vigTimer = 0;
    this._playerScreen = { x: 0, y: 0 };
  }

  show() { this.el.hud.classList.remove('hidden'); }
  hide() { this.el.hud.classList.add('hidden'); }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------
  setScore(v) {
    if (v === this._lastScore) return;
    this._lastScore = v;
    this.el.score.textContent = fmt(v);
    this.el.score.classList.remove('bump');
    void this.el.score.offsetWidth;
    this.el.score.classList.add('bump');
  }

  setWave(v) {
    if (v === this._lastWave) return;
    this._lastWave = v;
    this.el.wave.textContent = `${v}`;
  }

  setEnemies(v) {
    if (v === this._lastEnemies) return;
    this._lastEnemies = v;
    this.el.enemies.textContent = `${v}`;
  }

  setHealth(cur, max) {
    const r = Math.round(cur);
    if (r === this._lastHealth) return;
    this._lastHealth = r;
    const pct = clamp(cur / max, 0, 1) * 100;
    this.el.barHealth.style.width = pct + '%';
    this.el.textHealth.textContent = r;
    this.el.barHealth.classList.toggle('low', pct < 30);
    this.el.lowVig.style.opacity = pct < 30 ? '' : '0';
    if (pct < 30) this.el.lowVig.classList.remove('hidden');
    else this.el.lowVig.classList.add('hidden');
  }

  setStamina(cur, max) {
    const pct = clamp(cur / max, 0, 1) * 100;
    this.el.barStamina.style.width = pct + '%';
    // Only show when it matters
    const show = pct < 99;
    this.el.staminaShell.classList.toggle('hidden', !show);
  }

  setAmmo(mag, magSize, reserve) {
    // The dedupe must consider the RESERVE as well as the magazine. Keying
    // only on `mag` meant a per-wave resupply that topped up reserves without
    // changing the loaded rounds updated nothing on screen — the grant
    // happened, it was just invisible.
    const key = `${mag}/${reserve}`;
    if (key === this._lastAmmo) return;
    this._lastAmmo = key;
    this.el.textAmmo.textContent = mag;
    this.el.textReserve.textContent = `/ ${reserve}`;
    const pct = (mag / magSize) * 100;
    this.el.barAmmo.style.width = pct + '%';
    this.el.barAmmo.classList.toggle('empty', mag === 0);
    this.el.textAmmo.parentElement.classList.toggle('dry', mag === 0);
  }

  /**
   * Reflect the equipped weapon slot in the HUD.
   * @param {number} index  0-based slot
   * @param {string[]} names weapon display names, in slot order
   */
  setSlot(index, names) {
    if (!this.el.slotRow) return;
    const cells = this.el.slotRow.children;
    for (let i = 0; i < cells.length; i++) {
      const active = i === index;
      cells[i].classList.toggle('active', active);
      const label = cells[i].querySelector('.slot-name');
      if (label && names && names[i]) label.textContent = names[i];
    }
  }

  setWeapon(name) {
    this.el.textWeapon.textContent = name;
  }

  setReloading(on) {
    this.el.reloadHint.classList.toggle('hidden', !on);
  }

  /** Railgun charge level, 0..1. */
  setCharge(v) {
    const show = v > 0.001;
    this.el.chargeBar.classList.toggle('hidden', !show);
    this.el.barCharge.style.width = (v * 100).toFixed(1) + '%';
    this.el.barCharge.classList.toggle('full', v >= 0.999);
  }

  /**
   * Ability cooldown meters.
   * @param {number} dashK   0..1 ready fraction
   * @param {number} meleeK 0..1 ready fraction
   */
  setAbilities(dashK, meleeK) {
    this._setAbility(this.el.abDash, this.el.abDashFill, dashK);
    this._setAbility(this.el.abMelee, this.el.abMeleeFill, meleeK);
  }

  _setAbility(box, fill, k) {
    fill.style.width = (Math.max(0, Math.min(1, k)) * 100) + '%';
    box.classList.toggle('cooling', k < 0.999);
  }

  /** Overdrive timer, 0 hides the indicator. */
  setOverdrive(t, max) {
    const show = t > 0.01;
    this.el.overdrive.classList.toggle('hidden', !show);
    if (show) this.el.odFill.style.width = (Math.min(1, t / max) * 100) + '%';
  }

  // ------------------------------------------------------------------
  // Feedback
  // ------------------------------------------------------------------
  hitmark(kill = false) {
    const h = this.el.hitmarker;
    h.classList.remove('show');
    h.classList.toggle('kill', kill);
    void h.offsetWidth;
    h.classList.add('show');
  }

  crosshairKick() {
    const c = this.el.crosshair;
    c.classList.add('kick');
    setTimeout(() => c.classList.remove('kick'), 90);
  }

  crosshairOnTarget(on) {
    this.el.crosshair.classList.toggle('enemy', on);
  }

  damageFlash() {
    const f = this.el.flash;
    f.classList.remove('fire');
    void f.offsetWidth;
    f.classList.add('fire');

    this.el.damageVig.style.opacity = '1';
    this._vigTimer = 0.45;
  }

  killfeed(text, crit = false) {
    const d = document.createElement('div');
    d.className = 'kf-item' + (crit ? ' crit' : '');
    d.textContent = text;
    this.el.killfeed.appendChild(d);
    setTimeout(() => d.remove(), 3500);
    // Cap the list
    while (this.el.killfeed.children.length > 6) {
      this.el.killfeed.firstChild.remove();
    }
  }

  waveBanner(n, total, subtitle = '') {
    const b = this.el.banner;
    this.el.bannerTitle.textContent = `WAVE ${n}`;
    this.el.bannerSub.textContent = subtitle || `HOSTILES INBOUND · ${n} / ${total}`;
    b.classList.remove('hidden');
    // Restart the animation
    b.style.animation = 'none';
    void b.offsetWidth;
    b.style.animation = '';
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.add('hidden'), 3000);
  }

  clearBanner() {
    clearTimeout(this._bannerT);
    this.el.banner.classList.add('hidden');
  }

  // ------------------------------------------------------------------
  // Per-frame
  // ------------------------------------------------------------------
  update(dt) {
    if (this._vigTimer > 0) {
      this._vigTimer -= dt;
      if (this._vigTimer <= 0) this.el.damageVig.style.opacity = '0';
    }
  }

  // ------------------------------------------------------------------
  // Minimap
  // ------------------------------------------------------------------
  /**
   * @param {THREE.Vector3} playerPos
   * @param {number} playerYaw
   * @param {Array} enemies
   * @param {Array} pickups
   */
  drawMinimap(playerPos, playerYaw, enemies, pickups, world) {
    const c = this.ctx;
    const W = this.el.minimap.width;
    const H = this.el.minimap.height;
    const cx = W / 2, cy = H / 2;
    const scale = 0.55;   // px per world unit

    c.clearRect(0, 0, W, H);

    // Background
    c.save();
    c.beginPath();
    c.arc(cx, cy, W / 2, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = 'rgba(4, 10, 16, 0.85)';
    c.fillRect(0, 0, W, H);

    c.translate(cx, cy);
    c.rotate(-playerYaw);      // rotate so the player's facing is up

    // Grid
    c.strokeStyle = 'rgba(0, 229, 255, 0.10)';
    c.lineWidth = 1;
    for (let g = -60; g <= 60; g += 20) {
      c.beginPath();
      c.moveTo(g * scale, -H); c.lineTo(g * scale, H);
      c.moveTo(-W, g * scale); c.lineTo(W, g * scale);
      c.stroke();
    }

    // Arena bounds
    const half = CONFIG.world.halfSize;
    c.strokeStyle = 'rgba(0, 229, 255, 0.55)';
    c.lineWidth = 1.5;
    c.strokeRect(-half * scale, -half * scale, half * 2 * scale, half * 2 * scale);

    // Central platform
    c.fillStyle = 'rgba(0, 229, 255, 0.18)';
    c.fillRect(-7 * scale, -7 * scale, 14 * scale, 14 * scale);

    // Player dot
    c.fillStyle = '#00e5ff';
    c.beginPath();
    c.arc(0, 0, 3.5, 0, Math.PI * 2);
    c.fill();

    // Enemies
    for (const e of enemies) {
      if (e.dead) continue;
      const ex = (e.position.x - playerPos.x) * scale;
      const ez = (e.position.z - playerPos.z) * scale;
      if (Math.hypot(ex, ez) > W / 2 - 4) continue;
      c.fillStyle = e.kind === 'brute' ? '#ff2d55' : e.kind === 'stalker' ? '#7a5cff' : '#ff7a95';
      c.beginPath();
      c.arc(ex, ez, e.kind === 'brute' ? 4 : 3, 0, Math.PI * 2);
      c.fill();
    }

    // Pickups
    for (const p of pickups) {
      const px = (p.group.position.x - playerPos.x) * scale;
      const pz = (p.group.position.z - playerPos.z) * scale;
      if (Math.hypot(px, pz) > W / 2 - 4) continue;
      c.fillStyle = p.kind === 'health' ? '#ff2d55' : '#39ff88';
      c.fillRect(px - 1.5, pz - 1.5, 3, 3);
    }

    c.restore();

    // Sweep line
    c.save();
    c.translate(cx, cy);
    const sweep = (performance.now() / 1400) % (Math.PI * 2);
    const grad = c.createLinearGradient(0, 0, Math.cos(sweep) * W, Math.sin(sweep) * W);
    grad.addColorStop(0, 'rgba(0,229,255,0.30)');
    grad.addColorStop(1, 'rgba(0,229,255,0)');
    c.strokeStyle = grad;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(sweep) * W, Math.sin(sweep) * W);
    c.stroke();
    c.restore();
  }
}
