/**
 * weapons.js — Weapon manager: viewmodel, hitscan firing, recoil,
 * reloading, ammo, and weapon switching.
 *
 * The viewmodel is a separate scene rendered in an overlay pass so it never
 * clips through world geometry.
 */

import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { clamp, rand, damp } from './utils.js';

const W = CONFIG.weapons;

/**
 * Animation blend lambdas, with a built-in fallback.
 *
 * `CONFIG.anim` is read defensively on purpose. A cached `config.js` from an
 * older session can be paired with a freshly-loaded `weapons.js`, and reading
 * a missing key throws every single frame from inside the animation loop,
 * which is a miserable thing to debug. Falling back to the shipped defaults
 * costs a few lines and degrades gracefully instead of hard-failing.
 */
const ANIM_DEFAULTS = {
  swayVelocityGain: 2.2,
  swayDamp: 9,
  swayReturn: 12,
  swayMaxX: 0.06,
  swayMaxY: 0.05,
  sprintDamp: 8,
  sprintBobDamp: 14,
  recoilDamp: 11,
  recoilRotDamp: 10,
  swapDamp: 16,
  landDamp: 18,
};
const A = { ...ANIM_DEFAULTS, ...(CONFIG.anim || {}) };

/**
 * Viewmodel tuning. The overlay camera is the origin looking down -Z, so the
 * weapon is held off to the lower-right and pushed forward. These values were
 * tuned against a 55° FOV so the gun reads at a natural size.
 */
const VM_SCALE = 0.30;
const VM_BASE = { x: 0.20, y: -0.20, z: -0.45 };

export class Weapons {
  constructor(renderer, camera, world, player, effects, audio) {
    this.renderer = renderer;
    this.camera = camera;
    this.world = world;
    this.player = player;
    this.fx = effects;
    this.audio = audio;

    // ---- viewmodel scene ----
    // The overlay camera sits at the origin looking down -Z. Keeping its near
    // plane far away avoids clipping the barrel while still reading as
    // "held in front of the face".
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(48, 1, 0.05, 20);
    this.vmLight = new THREE.DirectionalLight(0xbfd8ff, 2.0);
    this.vmLight.position.set(-1, 2, 1.5);
    this.vmScene.add(this.vmLight, new THREE.HemisphereLight(0x9fc4e0, 0x1a2430, 1.3));
    const vmFill = new THREE.PointLight(0x8fd0ff, 1.2, 6, 2);
    vmFill.position.set(0.4, 0.2, 0.4);
    this.vmScene.add(vmFill);

    this.vmRoot = new THREE.Group();
    this.vmScene.add(this.vmRoot);

    // Share the world environment map so the gun's metal reads correctly.
    // Assigned by Game after construction (needs the renderer for PMREM).
    this.envMap = null;

    // ---- weapon state ----
    /** @type {string[]} */
    this.slots = ['rifle', 'scatter', 'railgun', 'grenade'];
    this.slotIndex = 0;
    this.ammo = {};
    for (const id of this.slots) {
      this.ammo[id] = { mag: W[id].magSize, reserve: W[id].reserve };
    }
    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.reloadStep = 0;
    this.swapT = 0;

    // Charge weapons (railgun): 0..1 while the trigger is held
    this.charge = 0;
    this.charging = false;

    // Overdrive: temporary damage/fire-rate boost from pickups
    this.overdrive = 0;

    this.spreadHeat = 0;
    this.consecutive = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.headshots = 0;

    // Viewmodel animation state
    this.vmSway = { x: 0, y: 0 };
    this.vmSwayVel = { x: 0, y: 0 };
    this.vmRecoil = 0;
    this.vmRecoilRot = 0;
    this.bobPhase = 0;
    this.lastLookDX = 0;
    this.lastLookDY = 0;

    // Raycaster reused for all shooting
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 300;

    // Scratch vectors for the hitscan path (see _fireRay).
    this._ray = {
      dir: new THREE.Vector3(),
      up: new THREE.Vector3(),
      right: new THREE.Vector3(),
      realUp: new THREE.Vector3(),
    };
    this._mzScratch = new THREE.Vector3();
    this._mzOut = new THREE.Vector3();
    this._rayOrigin = new THREE.Vector3();
    // Cached world raycast targets. The static arena never changes, so this
    // is built once and copied per shot rather than re-spread each pellet.
    this._worldTargets = [...world.raycastables];
    this._targets = [];

    this.models = {};
    this._buildModels();

    // Events
    this.onFire = null;
    this.onReloadStart = null;
    this.onReloadEnd = null;
    this.onAmmoChange = null;
    this.onSwitch = null;
    this.onEmptyClick = null;
    this.onCharge = null;   // (0..1) — drives the HUD charge bar
    // (origin, dir, def) — fired instead of the hitscan ray when a weapon
    // carries a `projectile` block. Game wires this to the player projectile
    // pool, which keeps Weapons free of scene/collision ownership.
    this.onProjectile = null;
  }

  get def() { return W[this.slots[this.slotIndex]]; }
  get current() { return this.ammo[this.slots[this.slotIndex]]; }
  get name() { return this.def.name; }

  /** Display names in slot order, for the HUD slot row. */
  get weaponNames() { return this.slots.map((id) => W[id].name); }

  /** 1.0 normally, higher while an overdrive pickup is active. */
  get powerMultiplier() {
    return this.overdrive > 0
      ? CONFIG.pickups.overdriveMultiplier
      : 1;
  }

  reset() {
    for (const id of this.slots) {
      this.ammo[id].mag = W[id].magSize;
      this.ammo[id].reserve = W[id].reserve;
    }
    this.slotIndex = 0;
    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.spreadHeat = 0;
    this.consecutive = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.headshots = 0;
    this.charge = 0;
    this.charging = false;
    this.overdrive = 0;
    this.swapT = 0;
    this._showModel(0);
  }

  // ==================================================================
  // Viewmodel construction
  // ==================================================================
  _buildModels() {
    // Viewmodel materials are deliberately lighter than their world-space
    // counterparts: the overlay scene has few lights, and a near-black gun
    // reads as a silhouette rather than a weapon.
    const dark = new THREE.MeshStandardMaterial({ color: 0x5a6875, roughness: 0.42, metalness: 0.8 });
    const mid = new THREE.MeshStandardMaterial({ color: 0x8a9bab, roughness: 0.32, metalness: 0.85 });
    const glow = new THREE.MeshStandardMaterial({
      color: 0x1a4a55, emissive: 0x00e5ff, emissiveIntensity: 3.2, roughness: 0.2,
    });
    const wood = new THREE.MeshStandardMaterial({ color: 0xa06a42, roughness: 0.7, metalness: 0.05 });

    // ---------- PULSE RIFLE ----------
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 0.62), dark);
      body.position.set(0, 0, -0.18);
      g.add(body);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.5, 10), mid);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.015, -0.58);
      g.add(barrel);

      // Energy coils along the barrel
      for (let i = 0; i < 4; i++) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.012, 6, 14), glow);
        coil.position.set(0, 0.015, -0.42 - i * 0.11);
        g.add(coil);
      }

      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.42), mid);
      rail.position.set(0, 0.09, -0.24);
      g.add(rail);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.3), dark);
      stock.position.set(0, -0.02, 0.22);
      g.add(stock);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.1), dark);
      grip.position.set(0, -0.14, 0.04);
      grip.rotation.x = -0.28;
      g.add(grip);

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.13), mid);
      mag.position.set(0, -0.16, -0.14);
      mag.rotation.x = 0.1;
      g.add(mag);

      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.05, 0.09), glow);
      sight.position.set(0, 0.12, -0.5);
      g.add(sight);

      // Muzzle tip marker (used for flash + tracer origin)
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.015, -0.84);
      g.add(muzzle);

      g.userData.muzzle = muzzle;
      this.models.rifle = g;
      this.vmRoot.add(g);
    }

    // ---------- SCATTER CANNON ----------
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.16, 0.5), wood);
      body.position.set(0, 0, -0.1);
      g.add(body);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.058, 0.62, 12), mid);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.02, -0.55);
      g.add(barrel);

      const underBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.44, 10), dark);
      underBarrel.rotation.x = Math.PI / 2;
      underBarrel.position.set(0, -0.045, -0.5);
      g.add(underBarrel);

      // Pump handle
      const pump = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.18), dark);
      pump.position.set(0, -0.05, -0.4);
      g.add(pump);
      g.userData.pump = pump;

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.34), wood);
      stock.position.set(0, -0.02, 0.26);
      stock.rotation.x = 0.06;
      g.add(stock);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.19, 0.1), dark);
      grip.position.set(0, -0.14, 0.06);
      grip.rotation.x = -0.3;
      g.add(grip);

      const heat = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.2), glow);
      heat.position.set(0, 0.09, -0.16);
      g.add(heat);

      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.02, -0.88);
      g.add(muzzle);
      g.userData.muzzle = muzzle;

      this.models.scatter = g;
      this.vmRoot.add(g);
    }

    // ---------- ARC LANCE (railgun) ----------
    {
      const g = new THREE.Group();
      const arcGlow = new THREE.MeshStandardMaterial({
        color: 0x3a2a55, emissive: 0x9d6aff, emissiveIntensity: 3.4, roughness: 0.2,
      });

      // Long, slender body
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.7), dark);
      body.position.set(0, 0, -0.22);
      g.add(body);

      // Twin rails running the length
      for (const sx of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.78, 8), mid);
        rail.rotation.x = Math.PI / 2;
        rail.position.set(sx * 0.045, 0.01, -0.5);
        g.add(rail);
      }

      // Charge coils — these brighten as the weapon charges
      const coils = [];
      for (let i = 0; i < 5; i++) {
        const c = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.014, 6, 16), arcGlow.clone());
        c.position.set(0, 0.01, -0.32 - i * 0.13);
        g.add(c);
        coils.push(c);
      }
      g.userData.coils = coils;
      g.userData.arcMat = arcGlow;

      // Rear capacitor stack
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 10), mid);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(0, 0.06, 0.05);
      g.add(cap);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.3), dark);
      stock.position.set(0, -0.02, 0.26);
      g.add(stock);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.09), dark);
      grip.position.set(0, -0.13, 0.08);
      grip.rotation.x = -0.3;
      g.add(grip);

      // Emitter prongs at the muzzle
      for (const sx of [-1, 1]) {
        const prong = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.05, 0.14), mid);
        prong.position.set(sx * 0.04, 0.01, -0.86);
        g.add(prong);
      }

      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.01, -0.94);
      g.add(muzzle);
      g.userData.muzzle = muzzle;

      this.models.railgun = g;
      this.vmRoot.add(g);
    }

    // ---------- ARC LOBBER (grenade launcher) ----------
    {
      const g = new THREE.Group();
      // Warm green so it reads as a separate tool at a glance rather than a
      // recoloured railgun, and so it is visually tied to the green projectile
      // it throws.
      const shell = new THREE.MeshStandardMaterial({ color: 0x4a5a52, roughness: 0.55, metalness: 0.6 });
      const hot = new THREE.MeshStandardMaterial({
        color: 0x12301f, emissive: 0x7cff9b, emissiveIntensity: 2.6, roughness: 0.25,
      });

      // Fat, stubby tube — the opposite silhouette to the ARC LANCE, so the
      // weapon reads as "short arcing launcher" from the shape alone.
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.56, 14), shell);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(0, 0.01, -0.3);
      g.add(tube);

      // Reinforcing bands around the barrel
      for (const z of [-0.12, -0.34, -0.52]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.092, 0.014, 6, 16), mid);
        band.position.set(0, 0.01, z);
        g.add(band);
      }

      // Loading drum — rotates while a shell is chambered (see userData.drum)
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.13, 12), mid);
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, -0.02, -0.16);
      g.add(drum);
      g.userData.drum = drum;

      // Glowing chamber indicator, brightens on cooldown
      const chamber = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 10), hot);
      chamber.rotation.x = Math.PI / 2;
      chamber.position.set(0.055, 0.06, -0.16);
      g.add(chamber);
      g.userData.chamberMat = hot;

      // Muzzle bell
      const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.07, 0.1, 14), mid);
      bell.rotation.x = Math.PI / 2;
      bell.position.set(0, 0.01, -0.6);
      g.add(bell);

      // Grip and stock
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.17, 0.09), shell);
      grip.position.set(0, -0.12, -0.04);
      grip.rotation.x = -0.28;
      g.add(grip);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.26), shell);
      stock.position.set(0, -0.01, 0.14);
      g.add(stock);

      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.01, -0.66);
      g.add(muzzle);
      g.userData.muzzle = muzzle;

      this.models.grenade = g;
      this.vmRoot.add(g);
    }

    this._showModel(0);
  }

  _showModel(index) {
    for (let i = 0; i < this.slots.length; i++) {
      const id = this.slots[i];
      const m = this.models[id];
      if (!m) continue;
      m.visible = i === index;
    }
  }

  /** Current world-space muzzle position for tracers/flashes. */
  muzzleWorld(out = new THREE.Vector3()) {
    const m = this.models[this.slots[this.slotIndex]];
    const muzzle = m?.userData.muzzle;
    if (!muzzle) return out.set(0, 0, 0);
    // Approximate: eye position + forward * 0.8 + right * 0.16 - up * 0.1
    const p = this.player;
    out.set(
      p.position.x, p.position.y + p.eyeHeight, p.position.z
    );
    // Reuse scratch vectors — this is called on every shot.
    const f = p.getLookDir(this._mzScratch);
    out.addScaledVector(f, 0.9);
    out.x += Math.cos(p.yaw) * 0.18;
    out.z += -Math.sin(p.yaw) * 0.18;
    out.y -= 0.08;
    return out;
  }

  // ==================================================================
  // Firing
  // ==================================================================

  /**
   * Try to fire.
   * Charge weapons: holding the trigger builds `charge`; the shot only
   * releases once the weapon is fully charged (or the trigger is released
   * early for a weak shot).
   * @returns {boolean} true if a shot went off
   */
  tryFire(enemies, triggerHeld) {
    const d = this.def;

    // ---- charge weapons ----
    if (d.isCharge) {
      if (this.reloading || this.swapT > 0) return false;

      if (this.current.mag <= 0) {
        if (this.charge > 0) { this.charge = 0; this.charging = false; }
        this.audio.dryFire();
        this.onEmptyClick?.();
        this._startReload();
        this.cooldown = 0.3;
        return false;
      }

      if (triggerHeld && this.cooldown <= 0) {
        // Hold to charge. Rate is per-second, driven from update().
        this.charging = true;
        this.onCharge?.(this.charge);
        if (this.charge >= 1) {
          this._releaseCharge(d, enemies, true);
        }
        return false;
      }

      // Trigger released
      if (this.charging) {
        this._releaseCharge(d, enemies, false);
        return true;
      }
      return false;
    }

    // ---- normal weapons ----
    if (this.reloading || this.swapT > 0) return false;
    if (this.cooldown > 0) return false;
    if (this.charge > 0) { this.charge = 0; this.charging = false; this.onCharge?.(0); }

    if (this.current.mag <= 0) {
      this.audio.dryFire();
      this.onEmptyClick?.();
      this._startReload();
      this.cooldown = 0.25;
      return false;
    }

    this.current.mag--;
    this.shotsFired++;
    // Overdrive increases fire rate
    this.cooldown = 60 / (d.rpm * (this.overdrive > 0 ? 1.35 : 1));
    this.consecutive++;
    this.spreadHeat = clamp(this.spreadHeat + 0.28, 0, 1.4);

    // Auto-reload the instant the magazine runs dry, rather than waiting for
    // the player to press fire again. Without this, an empty weapon that is
    // still being held down dry-fires once per trigger pull, which reads as
    // the gun being broken. Reloading here means the next shot is always
    // available, and `_startReload` is a no-op if the reserve is empty.
    if (this.current.mag <= 0) this._startReload();

    // Ballistic weapons skip the hitscan path entirely: the round is handed to
    // the projectile pool and the real damage happens on detonation. Doing it
    // here (rather than behind a separate flag in `main.js`) keeps the ammo,
    // cooldown and recoil accounting identical for every weapon.
    if (d.projectile) {
      this._fireProjectile(d);
      this._shotFeedback(d, { hit: false, headshot: false, killed: false, damage: 0 });
      return true;
    }

    const pellets = d.pellets || 1;
    const anyHit = { hit: false, headshot: false, killed: false, damage: 0 };

    for (let i = 0; i < pellets; i++) {
      const h = this._fireRay(enemies, d);
      if (h.hit) {
        anyHit.hit = true;
        anyHit.killed = anyHit.killed || h.killed;
        if (h.headshot) anyHit.headshot = true;
        anyHit.damage += h.damage || 0;
      }
    }

    this._shotFeedback(d, anyHit);
    return true;
  }

  /** Fire a charged railgun shot. */
  _releaseCharge(d, enemies, full) {
    const power = clamp(this.charge, 0.25, 1);
    this.current.mag--;
    this.shotsFired++;
    this.charge = 0;
    this.charging = false;
    this.onCharge?.(0);

    // A fully-charged shot pierces; a partial one is weak and single-target.
    const pierce = full ? d.pierce : 0;
    const result = this._piercingRay(enemies, { ...d, pierce, damage: d.damage * power * this.powerMultiplier });

    this.audio.enemyShoot(
      this.player.position.x, this.player.position.y + 1.4, this.player.position.z
    );
    this.audio.scatterShot();

    const mz = this.muzzleWorld(this._mzOut);
    this.fx.muzzleFlash(mz, d.muzzleColor, 7);
    this.fx.tracer(mz, this._lastHitPoint, d.tracerColor, 0.06, 0.18);

    this.player.addRecoil(d.recoil, 0);
    this.vmRecoil = Math.min(this.vmRecoil + 0.12, 0.2);
    this.vmRecoilRot = Math.min(this.vmRecoilRot + 0.3, 0.45);
    this.cooldown = 60 / d.rpm;
    this.consecutive = 0;
    this.spreadHeat = 0;

    // Same auto-reload rule as the normal path (see tryFire).
    if (this.current.mag <= 0) this._startReload();

    this.onFire?.({ weapon: d, charged: true, result });
    this.onAmmoChange?.();
  }

  /** Shared post-shot feedback: audio, flash, tracer, recoil. */
  _shotFeedback(d, anyHit) {
    if (d.id === 'rifle') this.audio.rifleShot();
    else if (d.id === 'scatter') this.audio.scatterShot();
    else if (d.id === 'grenade') this.audio.launcherShot();
    else this.audio.scatterShot();

    const mz = this.muzzleWorld(this._mzOut);
    // A lobbed round should not draw a hitscan tracer — it is an arc through
    // the air, so the projectile's own mesh is the visual.
    const isBallistic = !!d.projectile;
    this.fx.muzzleFlash(mz, d.muzzleColor, d.id === 'scatter' ? 5 : 3);
    if (!isBallistic) {
      this.fx.tracer(
        mz, this._lastHitPoint, d.tracerColor,
        d.id === 'scatter' ? 0.02 : 0.035, 0.055
      );
    }

    const kick = d.recoil * (1 + this.spreadHeat * 0.25);
    this.player.addRecoil(
      kick * (d.id === 'scatter' ? 1.5 : 1),
      rand(-kick * 0.4, kick * 0.4)
    );
    this.vmRecoil = Math.min(this.vmRecoil + kick * 12, 0.14);
    this.vmRecoilRot = Math.min(this.vmRecoilRot + kick * 9, 0.3);
    this.onFire?.({ weapon: d, ...anyHit });
    this.onAmmoChange?.();
  }

  /**
   * Launch a ballistic round through the Game-supplied projectile pool.
   *
   * The direction is the aim direction with a small cone of spread, matching
   * the hitscan weapons so the two feel like they share a trigger. A slight
   * upward bias helps a flat-aimed grenade clear waist-high cover instead of
   * bouncing straight back into the player's face.
   */
  _fireProjectile(d) {
    if (!this.onProjectile) return;
    const dir = this.player.getLookDir(this._ray.dir).clone();
    const spread = this._currentSpread();
    if (spread > 0) {
      const right = new THREE.Vector3().crossVectors(dir, this._ray.up.set(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, dir).normalize();
      const rMag = Math.sqrt(Math.random()) * spread;
      const theta = Math.random() * Math.PI * 2;
      dir.addScaledVector(right, Math.cos(theta) * rMag);
      dir.addScaledVector(up, Math.sin(theta) * rMag);
    }
    // Muzzle-relative launch, so the round does not spawn inside the camera.
    const mz = this.muzzleWorld(this._mzOut);
    // Slight upward bias: a flat-aimed grenade would bounce straight back off
    // cover at the player's feet.
    dir.y += 0.12;
    dir.normalize();
    this.onProjectile(mz, dir, d.projectile, d);
  }

  _currentSpread() {
    const d = this.def;
    let s = d.spread;
    if (this.player.speed > 1.5) s = d.spreadMoving;
    // Consecutive shots bloom
    s *= 1 + Math.min(this.consecutive, 12) * 0.09;
    // Crouching tightens
    if (this.player.crouching) s *= 0.7;
    return s;
  }

  /**
   * Ray that continues through up to `pierce` enemies.
   * Used by the railgun; each hit applies full damage.
   */
  _piercingRay(enemies, d) {
    const origin = this._rayOrigin.copy(this.player.eyePosition);
    const dir = this.player.getLookDir(this._ray.dir);
    this.raycaster.set(origin, dir);
    this.raycaster.far = d.range;

    const targets = this._targets;
    targets.length = 0;
    for (const t of this._worldTargets) targets.push(t);
    // Skip enemies that have not finished materialising — their hitboxes are
    // hidden but would still be raycastable.
    for (const e of enemies) {
      if (e.dead || e.pendingSpawn) continue;
      targets.push(e.hitMesh, e.headMesh);
    }

    const hits = this.raycaster.intersectObjects(targets, false);
    this._lastHitPoint = origin.clone().addScaledVector(dir, d.range);
    this._pierced = [];

    if (!hits.length) return { hit: false, damage: 0, killed: false };

    hits.sort((a, b) => a.distance - b.distance);

    const hitEnemies = new Set();
    let remaining = d.pierce;
    let killed = false;
    let total = 0;

    for (const h of hits) {
      if (remaining <= 0) break;
      const enemy = h.object.userData.enemyRef;
      if (!enemy) {
        // Stop at world geometry
        this._lastHitPoint.copy(h.point);
        const n = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
          : new THREE.Vector3(0, 1, 0);
        this.fx.impact(h.point, n, 0xd7b4ff);
        break;
      }
      if (hitEnemies.has(enemy)) continue;   // already damaged by this shot

      hitEnemies.add(enemy);
      remaining--;

      const isHead = h.object.userData.headshot;
      const dmg = d.damage * (isHead ? d.headshotMul : 1);
      const wasKilled = enemy.takeDamage(dmg, dir, isHead, h.point, this.fx);
      this.shotsHit++;
      if (isHead) this.headshots++;
      total += dmg;
      killed = killed || wasKilled;

      this.fx.blood(h.point, dir.clone().negate(), 1.8);
      this.fx.popup(h.point, String(Math.round(dmg)), 'crit');
      this.audio.impact(h.point.x, h.point.y, h.point.z, true);
      this._pierced.push(enemy);
    }

    this._lastHitPoint.copy(
      hits[Math.min(hits.length - 1, this._pierced.length)].point
    );

    return { hit: hitEnemies.size > 0, damage: total, killed, count: hitEnemies.size };
  }

  /** Cast one pellet. Populates this._lastHitPoint. */
  _fireRay(enemies, d) {
    // Scratch vectors: this runs once per pellet, and the rifle fires ~12
    // shots/second, so allocating here shows up as GC pressure.
    const s = this._ray;
    const origin = this._rayOrigin.copy(this.player.eyePosition);
    const dir = this.player.getLookDir(s.dir);

    // Apply spread as a random cone offset
    const spread = this._currentSpread();
    const a = rand(0, Math.PI * 2);
    const rMag = Math.sqrt(Math.random()) * spread;
    s.up.set(0, 1, 0);
    s.right.crossVectors(dir, s.up).normalize();
    s.realUp.crossVectors(s.right, dir).normalize();
    dir.addScaledVector(s.right, Math.cos(a) * rMag);
    dir.addScaledVector(s.realUp, Math.sin(a) * rMag);
    dir.normalize();

    this.raycaster.set(origin, dir);
    this.raycaster.far = d.range;

    // Collect candidates: world meshes + enemy hitboxes (body AND head)
    const targets = this._targets;
    targets.length = 0;
    for (const t of this._worldTargets) targets.push(t);
    // Skip enemies that have not finished materialising — their hitboxes are
    // hidden but would still be raycastable.
    for (const e of enemies) {
      if (e.dead || e.pendingSpawn) continue;
      targets.push(e.hitMesh, e.headMesh);
    }

    const hits = this.raycaster.intersectObjects(targets, false);
    this._lastHitPoint = origin.clone().addScaledVector(dir, d.range);

    if (!hits.length) return { hit: false };

    // Nearest world hit (to know how far the pellet travelled)
    let nearest = hits[0];
    for (const h of hits) {
      if (h.distance < nearest.distance) nearest = h;
    }

    // Separate enemy hits from world hits
    const enemyHits = hits.filter((h) => h.object.userData.enemyRef);

    if (enemyHits.length) {
      const h = enemyHits[0];
      const enemy = h.object.userData.enemyRef;
      const isHead = h.object.userData.headshot;
      this._lastHitPoint.copy(h.point);

      const dmg = d.damage * (isHead ? d.headshotMul : 1) * this.powerMultiplier;
      this.fx.setIchor(enemy.def.emissive);
      const killed = enemy.takeDamage(dmg, dir, isHead, h.point, this.fx);

      this.shotsHit++;
      if (isHead) this.headshots++;

      this.audio.impact(h.point.x, h.point.y, h.point.z, isHead);
      this.fx.blood(h.point, dir.clone().negate(), isHead ? 1.6 : 1);
      this.fx.popup(h.point, String(Math.round(dmg)), isHead ? 'crit' : '');

      return { hit: true, headshot: isHead, killed, damage: dmg, point: h.point };
    }

    // World hit
    const p = nearest.point;
    const n = nearest.face
      ? nearest.face.normal.clone().transformDirection(nearest.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    this._lastHitPoint.copy(p);
    this.fx.impact(p, n, 0x9ff8ff);
    this.fx.decal(p, n);
    this.audio.impact(p.x, p.y, p.z, false);
    return { hit: false };
  }

  // ==================================================================
  // Reload
  // ==================================================================
  _startReload() {
    if (this.reloading) return false;
    const d = this.def;
    const a = this.current;
    if (a.mag >= d.magSize) return false;
    if (a.reserve <= 0) return false;

    this.reloading = true;
    this.reloadT = 0;
    this.reloadStep = 0;
    this.onReloadStart?.(d);
    return true;
  }

  cancelReload() {
    if (!this.reloading) return;
    this.reloading = false;
    this.reloadT = 0;
    this.onReloadEnd?.(false);
  }

  _finishReload() {
    const d = this.def;
    const a = this.current;
    const need = d.magSize - a.mag;
    const take = Math.min(need, a.reserve);
    a.mag += take;
    a.reserve -= take;
    this.reloading = false;
    this.audio.reloadDone();
    this.onReloadEnd?.(true);
    this.onAmmoChange?.();
  }

  /** Add reserve ammo (from pickups). Returns amount actually added. */
  addAmmo(mult = 1) {
    let added = 0;
    for (const id of this.slots) {
      const d = W[id];
      const a = this.ammo[id];
      const before = a.reserve;
      a.reserve = Math.min(d.maxReserve, a.reserve + Math.round(d.magSize * mult));
      added += a.reserve - before;
    }
    if (added > 0) this.onAmmoChange?.();
    return added;
  }

  /**
   * Per-wave resupply. Tops every weapon up by a fraction of a magazine and
   * guarantees the reserve never falls below a floor fraction of its cap.
   *
   * The point is attrition insurance, not a free reload: the fractions are
   * deliberately small, so arriving at a wave nearly empty still leaves the
   * player short and scavenged pickups stay worth chasing. Returns the total
   * number of rounds added, for the HUD banner.
   */
  resupplyForWave() {
    const magFrac = CONFIG.waves.resupplyMagFraction ?? 0;
    const reserveFloor = CONFIG.waves.resupplyReserveFloor ?? 0;
    let added = 0;

    for (const id of this.slots) {
      const d = W[id];
      const a = this.ammo[id];

      // Top up the reserve first, so a reload is always possible afterwards.
      const floor = Math.floor(d.maxReserve * reserveFloor);
      if (a.reserve < floor) {
        added += floor - a.reserve;
        a.reserve = floor;
      }
      // Then top up the loaded magazine, without exceeding its capacity.
      if (magFrac > 0 && a.mag < d.magSize) {
        const want = Math.round(d.magSize * magFrac);
        const take = Math.min(want, d.magSize - a.mag, a.reserve);
        if (take > 0) {
          a.mag += take;
          a.reserve -= take;
          added += take;
        }
      }
    }

    if (added > 0) this.onAmmoChange?.();
    return added;
  }

  // ==================================================================
  // Weapon switching
  // ==================================================================
  switchTo(index) {
    if (index === this.slotIndex || index < 0 || index >= this.slots.length) return false;
    if (this.swapT > 0) return false;
    this.slotIndex = index;
    // Switching away mid-reload abandons it. Route through cancelReload so
    // listeners (the HUD reload indicator) are told, instead of silently
    // clearing the flag and leaving "RELOADING" on screen forever.
    if (this.reloading) this.cancelReload();
    this.reloadT = 0;
    this.swapT = 0.38;
    this.consecutive = 0;
    this.spreadHeat = 0;
    this._showModel(index);
    this.audio.weaponSwap();
    this.onSwitch?.(this.def);
    this.onAmmoChange?.();
    return true;
  }

  nextWeapon() {
    return this.switchTo((this.slotIndex + 1) % this.slots.length);
  }

  // ==================================================================
  // Per-frame update
  // ==================================================================
  update(dt, input, player) {
    // cooldowns
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.swapT > 0) this.swapT -= dt;
    if (this.consecutive > 0 && this.cooldown <= 0) {
      this.consecutive = Math.max(0, this.consecutive - dt * 22);
    }
    this.spreadHeat = Math.max(0, this.spreadHeat - dt * 1.9);

    // overdrive timer
    if (this.overdrive > 0) {
      this.overdrive = Math.max(0, this.overdrive - dt);
      if (this.overdrive === 0) this.onAmmoChange?.();
    }

    // ---- charge build (must happen before tryFire reads it) ----
    if (this.charging && this.def.isCharge && this.cooldown <= 0) {
      const rate = 1 / (this.def.chargeTime || 1);
      this.charge = clamp(this.charge + dt * rate, 0, 1);
      this.onCharge?.(this.charge);
    }

    // reload
    if (this.reloading) {
      this.reloadT += dt;
      const d = this.def;
      const stepTime = d.reloadTime / 3;
      const step = Math.floor(this.reloadT / stepTime);
      if (step !== this.reloadStep && step < 3) {
        this.reloadStep = step;
        this.audio.reloadStep(step);
      }
      if (this.reloadT >= d.reloadTime) this._finishReload();
    }

    // input
    if (input.reloadPressed) this._startReload();

    if (input.pressed('Digit1')) this.switchTo(0);
    if (input.pressed('Digit2')) this.switchTo(1);
    if (input.pressed('Digit3')) this.switchTo(2);
    if (input.pressed('Digit4')) this.switchTo(3);
    const wheel = input.consumeWheel();
    if (wheel !== 0) this.nextWeapon();

    // ---- viewmodel animation ----
    this._animateViewmodel(dt, input);
  }

  /** Activate an overdrive buff. */
  activateOverdrive(duration) {
    this.overdrive = Math.max(this.overdrive, duration);
    this.onAmmoChange?.();
  }

  get overdriveActive() { return this.overdrive > 0; }

  _animateViewmodel(dt, input) {
    const m = this.models[this.slots[this.slotIndex]];
    if (!m) return;

    // ==================================================================
    // Layered pose model
    // ==================================================================
    // Each layer below computes an *offset* from the rest pose, and the
    // layers are summed at the end. Two rules make this feel smooth rather
    // than snappy:
    //   1. Nothing is ever assigned directly. Every value is a `damp` toward
    //      a target, so a state change mid-frame eases in instead of popping.
    //   2. Transient one-shots (recoil, melee, land) are *additive and
    //      decaying*, so they can overlap the continuous layers (sprint, bob)
    //      without either one cancelling the other.
    let px = 0, py = 0, pz = 0;      // positional offsets
    let rx = 0, ry = 0, rz = 0;      // rotational offsets

    // ---- Layer 1: locomotion bob (continuous, speed-driven) ----
    // Amplitude follows a damped value rather than raw speed, so the bob
    // eases in when you start running instead of appearing at full depth.
    this.bobAmp = damp(this.bobAmp || 0,
      clamp(this.player.speed / CONFIG.player.sprintSpeed, 0, 1), A.sprintBobDamp, dt);
    this.bobPhase += dt * (6 + this.player.speed * 0.9);
    px += Math.sin(this.bobPhase) * 0.010 * this.bobAmp;
    py += Math.abs(Math.cos(this.bobPhase)) * -0.012 * this.bobAmp;

    // ---- Layer 2: sway (lags the camera, gives the weapon mass) ----
    // A spring-damper: mouse delta feeds a velocity, which decays to zero and
    // is then integrated into an offset that itself damps back to rest. Two
    // stages is what stops the gun from looking welded to the screen.
    const lookDX = -this.player.recoilYaw;
    const lookDY = -this.player.recoilPitch;
    this.vmSwayVel.x += lookDX * A.swayVelocityGain;
    this.vmSwayVel.y += lookDY * A.swayVelocityGain;
    this.vmSwayVel.x = damp(this.vmSwayVel.x, 0, A.swayDamp, dt);
    this.vmSwayVel.y = damp(this.vmSwayVel.y, 0, A.swayDamp, dt);
    this.vmSway.x = damp(this.vmSway.x, clamp(this.vmSwayVel.x, -A.swayMaxX, A.swayMaxX), A.swayReturn, dt);
    this.vmSway.y = damp(this.vmSway.y, clamp(this.vmSwayVel.y, -A.swayMaxY, A.swayMaxY), A.swayReturn, dt);
    // Sway also rolls the weapon slightly, which reads as wrist articulation.
    px += this.vmSway.x;
    py += this.vmSway.y;
    rz += -this.vmSway.x * 1.6;

    // ---- Layer 3: recoil (additive, fast attack / slow decay) ----
    this.vmRecoil = damp(this.vmRecoil, 0, A.recoilDamp, dt);
    this.vmRecoilRot = damp(this.vmRecoilRot, 0, A.recoilRotDamp, dt);
    pz += this.vmRecoil * 0.16;    // pushes the barrel back toward the camera
    py -= this.vmRecoil * 0.10;    // and kicks it up
    rx += this.vmRecoilRot * 0.6;  // muzzle rises, then settles

    // ---- Layer 4: reload (dip + roll, shaped by a sine envelope) ----
    if (this.reloading) {
      const d = this.def;
      const k = clamp(this.reloadT / d.reloadTime, 0, 1);
      // sin(k*PI) gives 0→1→0, so the gun leaves and returns to rest exactly
      // as the reload completes. No snap at either end.
      const s = Math.sin(k * Math.PI);
      py -= s * 0.16;
      rx += s * 0.30;
      ry += s * 0.24;
      rz += s * 0.18;
    }

    // ---- Layer 5: weapon swap (raise/lower) ----
    if (this.swapT > 0) {
      const k = clamp(this.swapT / 0.38, 0, 1);
      py -= Math.sin(k * Math.PI) * 0.3;
    }

    // ---- Layer 6: melee swing ----
    // Driven by the player's swing clock, not a local timer, so the weapon
    // motion and the hit-detection frame are guaranteed to be the same
    // animation. The curve is asymmetric on purpose: a fast windup, a fast
    // strike, and a slower recovery — that is what gives a swing its weight.
    const swing = this.player.meleeAnim > 0
      ? 1 - this.player.meleeAnim / CONFIG.player.meleeSwing
      : -1;
    if (swing >= 0) {
      const P = CONFIG.player;
      const impact = P.meleeHitPoint;
      // Windup: pull back and up. Strike: sweep down and across.
      let amount;
      if (swing < impact) {
        // ease-in over the windup
        amount = -Math.pow(swing / impact, 1.6);
      } else {
        // ease-out through the strike and recovery
        const k = (swing - impact) / Math.max(1e-4, 1 - impact);
        amount = (1 - k * k) * (1 - k * 0.25);
      }
      // Push the weapon down and in, and roll it across the view.
      py += amount * -0.30;
      pz += amount * 0.14;
      rx += amount * 0.55;
      rz += amount * -0.75;
      ry += amount * 0.30;
      // A small counter-rotation of the whole viewmodel sells the effort.
      ry -= amount * 0.12;
    }

    // ---- Layer 7: sprint (tilts the weapon out of the way) ----
    const sprintTilt = this.player.sprinting && this.bobAmp > 0.85 ? 1 : 0;
    this._sprintTilt = damp(this._sprintTilt || 0, sprintTilt, A.sprintDamp, dt);
    rx += this._sprintTilt * 0.25;
    ry += this._sprintTilt * 0.55;
    rz += this._sprintTilt * 0.35;

    // ==================================================================
    // Compose and apply
    // ==================================================================
    m.position.set(VM_BASE.x + px, VM_BASE.y + py, VM_BASE.z + pz);
    m.rotation.set(rx, ry, -0.03 + rz);
    m.scale.setScalar(VM_SCALE);

    // Pump action on the scatter gun
    const pump = m.userData.pump;
    if (pump) {
      const cyc = clamp(this.cooldown / (60 / W.scatter.rpm), 0, 1);
      pump.position.z = -0.4 + cyc * 0.1;
    }

    // Railgun coils brighten and pulse with the charge level
    const coils = m.userData.coils;
    if (coils) {
      const c = this.charge;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.012);
      for (let i = 0; i < coils.length; i++) {
        // Emitters light up progressively toward the muzzle as charge builds
        const seg = clamp(c * coils.length - i, 0, 1);
        coils[i].material.emissiveIntensity = 0.6 + seg * (3.5 + pulse * 3.5);
        coils[i].scale.setScalar(1 + seg * 0.28);
      }
    }
  }

  // ==================================================================
  // Render (overlay pass, no depth clipping with world)
  // ==================================================================
  render() {
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();

    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.vmScene, this.vmCamera);
    this.renderer.autoClear = true;
  }

  /** Hide the viewmodel (used on death). */
  setVisible(v) {
    this.vmRoot.visible = v;
    for (const k in this.models) this.models[k].visible = v && k === this.slots[this.slotIndex];
  }
}
