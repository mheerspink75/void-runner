/**
 * player.js — First-person player controller.
 *
 * Handles: mouse-look, accel/friction movement, sprint + stamina, crouch,
 * jump with coyote time, world collision, health/damage, and death.
 */

import * as THREE from '../vendor/three.module.js';
import { CONFIG, KEYS } from './config.js';
import { clamp, damp } from './utils.js';

const P = CONFIG.player;

export class Player {
  constructor(camera, world, audio) {
    this.camera = camera;
    this.world = world;
    this.audio = audio;

    this.position = new THREE.Vector3(0, 0, 26);
    this.velocity = new THREE.Vector3();
    this.vy = 0;
    this.onGround = false;
    this.groundTag = null;
    this.coyote = 0;
    this.hitWall = false;

    // Look angles
    this.yaw = Math.PI;         // face the arena center
    this.pitch = 0;

    // Stance
    this.crouching = false;
    this.eyeHeight = P.eyeHeight;
    this.sprinting = false;

    // ---- Dash ----
    this.dashCd = 0;
    this.dashT = 0;
    this.dashDir = new THREE.Vector3();
    this.iframes = 0;

    // ---- Melee ----
    this.meleeCd = 0;
    this.meleeAnim = 0;
    // `meleeT` is the swing clock; -1 means "no swing in flight". `meleeAnim`
    // is the remaining swing duration and is what the viewmodel reads.
    this.meleeT = -1;
    this.meleeResolved = true;

    // FOV kick
    this.fovOffset = 0;

    // Vitals
    this.health = P.maxHealth;
    this.stamina = P.maxStamina;
    this.dead = false;
    this.invuln = 0;

    // Stats
    this.distanceTravelled = 0;

    // Recoil / view kick offsets
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.landDip = 0;
    this.damageShake = 0;
    this.shakeT = 0;

    // Callbacks assigned by Game
    this.onDamage = null;
    this.onDeath = null;
    this.onLand = null;
    this.onStep = null;

    // Camera bob / tilt container lives on the camera itself
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();

    this._tmp = new THREE.Vector3();
    /** Scratch vectors reused by the per-frame camera path to avoid GC. */
    this._velFlat = new THREE.Vector3();
    this._lookScratch = new THREE.Vector3();
    this._rightScratch = new THREE.Vector3();
    this._wishDir = new THREE.Vector3();
  }

  reset() {
    this.position.set(0, 0, 26);
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.yaw = Math.PI;
    this.pitch = 0;
    this.health = P.maxHealth;
    this.stamina = P.maxStamina;
    this.dead = false;
    this.invuln = 0;
    this.iframes = 0;
    this.dashCd = 0;
    this.dashT = 0;
    this.meleeCd = 0;
    this.meleeAnim = 0;
    this.meleeT = -1;
    this.meleeResolved = true;
    this.fovOffset = 0;
    this.crouching = false;
    this.eyeHeight = P.eyeHeight;
    this.recoilPitch = this.recoilYaw = 0;
    this.landDip = 0;
    this.damageShake = 0;
    this.distanceTravelled = 0;
    this.bobPhase = 0;
  }

  get eyePosition() {
    return this._tmp.set(
      this.position.x,
      this.position.y + this.eyeHeight,
      this.position.z
    );
  }

  /** Unit forward vector on the XZ plane. */
  getForward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  getRight(out = new THREE.Vector3()) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Full 3D look direction including pitch. */
  getLookDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(
      -Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp
    );
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  // ==================================================================
  // Per-frame update
  // ==================================================================
  update(dt, input) {
    if (this.dead) {
      // Slow camera sink + roll on death
      this.eyeHeight = damp(this.eyeHeight, 0.32, 3, dt);
      this.pitch = damp(this.pitch, -0.35, 2.5, dt);
      this._applyCamera(dt);
      return;
    }

    this._look(dt, input);
    this._abilities(dt, input);
    this._move(dt, input);
    this._vitals(dt);
    this._applyCamera(dt);

    if (this.invuln > 0) this.invuln -= dt;
    if (this.iframes > 0) this.iframes -= dt;
    if (this.damageShake > 0) this.damageShake = Math.max(0, this.damageShake - dt * 2.4);
  }

  // ------------------------------------------------------------------
  // Abilities: dash + melee
  // ------------------------------------------------------------------
  _abilities(dt, input) {
    if (this.dead) return;

    if (this.dashCd > 0) this.dashCd -= dt;
    if (this.meleeCd > 0) this.meleeCd -= dt;
    if (this.meleeAnim > 0) this.meleeAnim = Math.max(0, this.meleeAnim - dt);

    // Advance the swing timeline. -1 is the "no swing in progress" sentinel,
    // so an idle meleeAnim of 0 does not register as an in-flight swing.
    this._advanceMelee(dt);

    // ---- Dash ----
    if (this.dashT > 0) {
      this.dashT -= dt;
      const k = clamp(this.dashT / P.dashDuration, 0, 1);
      // Ease out so the dash feels snappy rather than linear
      const spd = P.dashSpeed * (0.35 + k * 0.65);
      this.velocity.x = this.dashDir.x * spd;
      this.velocity.z = this.dashDir.z * spd;
      if (this.dashT <= 0) {
        this.iframes = Math.max(0, this.iframes);
      }
    } else if (input.anyPressed(KEYS.dash) && this.dashCd <= 0 && this.stamina >= P.dashCost) {
      this._startDash(input);
    }

    // ---- Melee ----
    if (input.anyPressed(KEYS.melee) && this.meleeCd <= 0 && this.stamina >= P.meleeStaminaCost) {
      this._startMelee();
    }
  }

  _startDash(input) {
    // Dash in the movement direction, or straight forward if standing still.
    let dx = 0, dz = 0;
    if (input.moveForward) { dx -= Math.sin(this.yaw); dz -= Math.cos(this.yaw); }
    if (input.moveBack)    { dx += Math.sin(this.yaw); dz += Math.cos(this.yaw); }
    if (input.moveRight)   { dx += Math.cos(this.yaw); dz -= Math.sin(this.yaw); }
    if (input.moveLeft)    { dx -= Math.cos(this.yaw); dz += Math.sin(this.yaw); }

    if (dx === 0 && dz === 0) {
      // No input → dash forward
      dx = -Math.sin(this.yaw);
      dz = -Math.cos(this.yaw);
    } else {
      const l = Math.hypot(dx, dz);
      dx /= l; dz /= l;
    }

    this.dashDir.set(dx, 0, dz);
    this.dashT = P.dashDuration;
    this.dashCd = P.dashCooldown;
    this.stamina = Math.max(0, this.stamina - P.dashCost);
    this.iframes = P.dashIFrames;
    this.fovOffset = P.dashFovKick;

    this.onDash?.();
  }

  _startMelee() {
    this.meleeCd = P.meleeCooldown;
    this.meleeAnim = P.meleeSwing;   // counts down; drives the viewmodel swing
    this.meleeT = 0;                // counts up; drives the single damage tick
    this.meleeResolved = false;     // guarantees exactly one hit per swing
    this.stamina = Math.max(0, this.stamina - P.meleeStaminaCost);
    // `onMelee` is now a *swing started* notification. Damage is applied
    // later by `_advanceMelee` so the blade is visibly live when it connects.
    this.onMelee?.();
  }

  /**
   * Advance the swing timeline and fire the single hit at the configured
   * impact frame. Called every frame from _abilities.
   *
   * Splitting this out is what makes melee feel like an attack rather than an
   * instant delete: the enemy gets `meleeWindup` seconds to react, and the
   * impact shake/hitstop line up with the visible part of the swing.
   */
  _advanceMelee(dt) {
    if (this.meleeT < 0) return;
    this.meleeT += dt;
    if (this.meleeResolved) return;
    if (this.meleeT >= P.meleeHitPoint * P.meleeSwing) {
      this.meleeResolved = true;
      this.onMeleeHit?.();
    }
  }

  /**
   * Find enemies inside the melee cone. Consumed by the Game via a callback so
   * the player module does not need a reference to the enemy manager.
   */
  meleeTargets(enemies) {
    const origin = this.eyePosition.clone();
    const fwd = this.getLookDir(new THREE.Vector3());
    const out = [];
    for (const e of enemies) {
      if (e.dead || e.pendingSpawn) continue;
      const dx = e.position.x - this.position.x;
      const dz = e.position.z - this.position.z;
      const dy = e.position.y + e.def.height * 0.5 - (this.position.y + this.eyeHeight);
      const dist = Math.hypot(dx, dy, dz);
      if (dist > P.meleeRange + e.def.radius) continue;
      // Must be within the cone in front of the player
      const dot = (dx * fwd.x + dz * fwd.z) / (Math.hypot(dx, dz) || 1);
      if (dot < Math.cos(P.meleeArc)) continue;
      out.push({ enemy: e, dist });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  // ------------------------------------------------------------------
  // Look
  // ------------------------------------------------------------------
  _look(dt, input) {
    const { dx, dy } = input.consumeLook();
    const s = CONFIG.look.sensitivity / Math.max(input.sensitivity, 1e-4);
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    this.pitch = clamp(this.pitch, -CONFIG.look.pitchLimit, CONFIG.look.pitchLimit);

    // Recoil recovery
    this.recoilPitch = damp(this.recoilPitch, 0, 12, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 12, dt);
  }

  // ------------------------------------------------------------------
  // Movement
  // ------------------------------------------------------------------
  _move(dt, input) {
    // ---- stance ----
    const wantCrouch = input.crouchHeld;
    if (!wantCrouch && this.crouching && !this._headBlocked()) {
      this.crouching = false;
    } else if (wantCrouch) {
      this.crouching = true;
    }

    // ---- desired horizontal direction ----
    this.getForward(this._fwd);
    this.getRight(this._right);
    this._wish.set(0, 0, 0);
    if (input.moveForward) this._wish.add(this._fwd);
    if (input.moveBack) this._wish.sub(this._fwd);
    if (input.moveRight) this._wish.add(this._right);
    if (input.moveLeft) this._wish.sub(this._right);
    if (this._wish.lengthSq() > 0) this._wish.normalize();

    // ---- sprint + stamina ----
    const movingForward = input.moveForward && !input.moveBack;
    const wantsSprint = input.sprintHeld && movingForward && !this.crouching &&
                        this.stamina > 0 && this._wish.lengthSq() > 0;
    this.sprinting = wantsSprint;

    if (wantsSprint) {
      this.stamina = Math.max(0, this.stamina - P.staminaDrain * dt);
      if (this.stamina <= 0) this.sprinting = false;
    } else {
      const regen = this.crouching ? P.staminaRegen * 0.6 : P.staminaRegen;
      this.stamina = Math.min(P.maxStamina, this.stamina + regen * dt);
    }

    // ---- target speed ----
    let target = P.walkSpeed;
    if (this.crouching) target = P.crouchSpeed;
    else if (this.sprinting) target = P.sprintSpeed;

    // ---- accel / friction ----
    // Accelerate the velocity toward the desired velocity. This is stable at
    // any framerate and cannot be out-paced by friction (which is what caps
    // top speed in a naive "accel then friction" model).
    const control = this.onGround ? 1 : P.airControl;
    const rate = P.accel * control;

    if (this._wish.lengthSq() > 0) {
      const tx = this._wish.x * target;
      const tz = this._wish.z * target;
      const dvx = tx - this.velocity.x;
      const dvz = tz - this.velocity.z;
      const dLen = Math.hypot(dvx, dvz);
      if (dLen > 1e-5) {
        // Never let a single frame overshoot the target velocity.
        const step = Math.min(dLen, rate * dt);
        this.velocity.x += (dvx / dLen) * step;
        this.velocity.z += (dvz / dLen) * step;
      }
    } else if (this.onGround) {
      // Only apply ground friction when there is no movement input.
      const sp = this.speed;
      if (sp > 0) {
        const drop = Math.max(sp, 3.0) * P.friction * dt;
        const k = Math.max(0, sp - drop) / sp;
        this.velocity.x *= k;
        this.velocity.z *= k;
      }
    }

    // ---- jump ----
    if (input.jumpPressed && (this.onGround || this.coyote > 0) && !this.crouching) {
      this.vy = P.jumpVelocity;
      this.onGround = false;
      this.coyote = 0;
    }

    // ---- gravity ----
    this.vy += CONFIG.world.gravity * dt;
    // Terminal velocity
    this.vy = Math.max(this.vy, -60);

    // ---- integrate + collide ----
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.vy * dt;

    this.hitWall = this.world.resolve(this.position, P.radius, this._bodyHeight());

    // Ground state is set by world.resolve() (arena floor + cover tops)
    const wasOnGround = this.onGround;
    this.onGround = !!this.position.onGround;
    this.position.onGround = false;
    this.groundTag = this.position.groundTag || this.groundTag;

    if (this.onGround) {
      if (this.vy < 0) this.vy = 0;
      this.coyote = P.coyoteTime;
      if (!wasOnGround) {
        // Landing impact
        const impact = clamp(-this.vy * 0.012, 0, 0.35);
        this.landDip = impact;
        this.onLand?.(impact);
      }
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
    }

    // Safety net: never let the player fall out of the world
    if (this.position.y < -4) {
      this.position.set(0, 0, 26);
      this.vy = 0;
    }

    // ---- head bob + footsteps ----
    const moveSpeed = this.speed;
    if (this.onGround && moveSpeed > 1) {
      const prevPhase = this.bobPhase;
      this.bobPhase += dt * moveSpeed * (this.sprinting ? 1.5 : 1.28);
      this.distanceTravelled += moveSpeed * dt;
      // Footstep on each bob trough
      if (Math.floor(prevPhase / Math.PI) !== Math.floor(this.bobPhase / Math.PI)) {
        this.onStep?.(this.sprinting, this.crouching);
      }
    } else {
      this.bobAmount = damp(this.bobAmount, 0, 6, dt);
    }

    this.bobAmount = damp(
      this.bobAmount, clamp(moveSpeed / P.sprintSpeed, 0, 1), 7, dt
    );
  }

  _bodyHeight() {
    return this.crouching ? 1.25 : 1.85;
  }

  _headBlocked() {
    // Can we stand up? Check for a collider intersecting the taller body.
    return this.world.isBlocked(
      this.position.x, this.position.z, P.radius * 0.9,
      this.position.y + 1.0, this.position.y + 1.9
    );
  }

  // ------------------------------------------------------------------
  // Vitals
  // ------------------------------------------------------------------
  _vitals(dt) {
    if (this.health <= 0 && !this.dead) {
      this.dead = true;
      this.onDeath?.();
    }
  }

  /**
   * Apply damage. Returns true if the damage landed.
   */
  damage(amount, fromX, fromZ) {
    // Dash grants i-frames — a skilled dodge should actually work.
    if (this.dead || this.invuln > 0 || this.iframes > 0) return false;
    this.health = Math.max(0, this.health - amount);
    this.invuln = P.invulnTime;
    this.damageShake = 1;

    this.audio.playerHurt();
    this.onDamage?.(amount, this.health);

    if (this.health <= 0) {
      this.dead = true;
      this.onDeath?.();
    }
    return true;
  }

  heal(amount) {
    if (this.dead) return 0;
    const before = this.health;
    this.health = Math.min(P.maxHealth, this.health + amount);
    return this.health - before;
  }

  // ------------------------------------------------------------------
  // Camera
  // ------------------------------------------------------------------
  _applyCamera(dt) {
    // Crouch transition
    const targetEye = this.crouching ? P.crouchEyeHeight : P.eyeHeight;
    this.eyeHeight = damp(this.eyeHeight, targetEye, 14, dt);

    // Land dip recovery
    this.landDip = damp(this.landDip, 0, 7, dt);

    // ---- FOV kick: sprint + speed + dash ----
    const baseFov = CONFIG.look.fovBase;
    let targetFov = baseFov;
    if (this.sprinting) targetFov += CONFIG.look.fovSprintBoost * 0.6;
    targetFov += (this.speed / P.sprintSpeed) * 6;
    if (this.dashT > 0) targetFov += CONFIG.look.fovDashKick;
    if (this.fovOffset > 0) this.fovOffset = damp(this.fovOffset, 0, 8, dt);
    targetFov += this.fovOffset;
    if (this.camera.isPerspectiveCamera) {
      this.camera.fov = damp(this.camera.fov, targetFov, 9, dt);
      this.camera.updateProjectionMatrix();
    }

    // Head bob
    const bobY = Math.sin(this.bobPhase * 2) * 0.045 * this.bobAmount;
    const bobX = Math.sin(this.bobPhase) * 0.035 * this.bobAmount;

    // Damage shake (view-local; PostFX adds screen-space shake on top)
    let shakeX = 0, shakeY = 0;
    if (this.damageShake > 0) {
      const t = performance.now() * 0.05;
      shakeX = Math.sin(t * 1.7) * 0.035 * this.damageShake;
      shakeY = Math.cos(t * 2.3) * 0.030 * this.damageShake;
    }

    this.camera.position.set(
      this.position.x,
      this.position.y + this.eyeHeight - this.landDip + bobY,
      this.position.z
    );
    this.camera.position.x += bobX * Math.cos(this.yaw);
    this.camera.position.z -= bobX * Math.sin(this.yaw);

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw + this.recoilYaw;
    this.camera.rotation.x = this.pitch + this.recoilPitch;
    this.camera.rotation.z = 0;

    // Subtle roll while strafing for weight
    this._velFlat.set(this.velocity.x, 0, this.velocity.z);
    const strafeRoll = this.getRight(this._tmp).dot(this._velFlat) / P.sprintSpeed;
    this.camera.rotation.z += -clamp(strafeRoll, -1, 1) * 0.022;
  }

  /** Apply weapon recoil kick. */
  addRecoil(pitch, yaw) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
  }
}
