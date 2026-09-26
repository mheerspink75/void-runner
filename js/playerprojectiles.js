/**
 * playerprojectiles.js — Player-fired ballistic rounds (grenades).
 *
 * This is deliberately separate from `projectiles.js`, which is the *enemy*
 * projectile pool. The two have opposite ownership — one damages the player,
 * the other damages enemies — and mixing them would mean a single update loop
 * branching on allegiance every frame. Keeping them apart also means the
 * grenade's bounce/fuse/AoE logic cannot regress the spitter's shot.
 *
 * Pooled, like everything else here: a fixed set of meshes, reactivated on
 * spawn. Lights come from the shared `lightPool` — see the note in
 * `lightpool.js` about why adding/removing real lights is expensive.
 *
 * Detonation is the interesting part. A grenade does radial damage with
 * distance falloff, applies knockback, and respects enemy line of sight, so
 * you cannot simply blast someone through a wall.
 */

import * as THREE from '../vendor/three.module.js';
import { clamp } from './utils.js';

const POOL_SIZE = 24;

export class PlayerProjectileManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./world.js').World} world
   * @param {import('./player.js').Player} player
   * @param {object} effects Effects instance
   * @param {object} enemies  EnemyManager — needed for AoE target queries
   * @param {object} audio
   * @param {object} lightPool
   */
  constructor(scene, world, player, effects, enemies, audio, lightPool) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.fx = effects;
    this.enemies = enemies;
    this.audio = audio;
    this.lightPool = lightPool;

    /** @type {Array<object>} */
    this.pool = [];
    this._buildPool();

    // Wired by Game so a kill inside a blast still scores/combos normally.
    this.onBlastKill = null;

    this._v = new THREE.Vector3();
  }

  _buildPool() {
    // A grenade reads better as a small faceted shell than a smooth sphere.
    const geo = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x1d3a28,
        emissive: 0x7cff9b,
        emissiveIntensity: 2.4,
        roughness: 0.35,
        metalness: 0.2,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);

      // A dim trail glow that follows the shell, so the arc is readable in
      // flight. Additive sprite, no lighting cost.
      const glowMat = new THREE.SpriteMaterial({
        color: 0x7cff9b,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.setScalar(0.9);
      glow.visible = false;
      this.scene.add(glow);

      this.pool.push({
        active: false,
        mesh, mat, glow, glowMat,
        vel: new THREE.Vector3(),
        life: 0, maxLife: 1, fuse: 1, maxFuse: 1,
        radius: 0.18, gravity: -20,
        bounces: 0, maxBounces: 2,
        blastRadius: 6, blastDamage: 100, falloff: 0.25, knockback: 12,
        spin: new THREE.Vector3(),
      });
    }
  }

  _acquire() {
    for (const p of this.pool) if (!p.active) return p;
    return null;   // exhausted — drop the shot rather than grow unbounded
  }

  /**
   * Launch a grenade.
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} dir normalised
   * @param {object} def weapon's `projectile` block
   */
  spawn(pos, dir, def) {
    const p = this._acquire();
    if (!p) return null;

    p.active = true;
    p.mesh.visible = true;
    p.glow.visible = true;
    p.mesh.position.copy(pos);
    p.glow.position.copy(pos);
    p.mesh.scale.setScalar(def.radius);
    p.glow.scale.setScalar(def.radius * 4.5);
    p.mat.color.setHex(def.color);
    p.mat.emissive.setHex(def.color);
    p.glowMat.color.setHex(def.color);
    p.glowMat.opacity = 0.55;

    p.vel.copy(dir).multiplyScalar(def.speed);
    p.life = def.life;
    p.maxLife = def.life;
    p.fuse = def.fuse ?? def.life;
    p.maxFuse = p.fuse;
    p.radius = def.radius;
    p.gravity = def.gravity;
    p.bounces = 0;
    p.maxBounces = def.bounces ?? 0;
    p.blastRadius = def.blastRadius ?? 5;
    p.blastDamage = def.blastDamage ?? def.damage;
    p.falloff = def.falloff ?? 0.25;
    p.knockback = def.knockback ?? 10;

    // Tumble, so the shell does not look like a static dot.
    p.spin.set(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12
    );
    return p;
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.active) continue;

      p.life -= dt;
      p.fuse -= dt;
      // The fuse is the guarantee: a grenade detonates on the timer even if it
      // never touched anything, so a badly-thrown one is never simply lost.
      if (p.life <= 0 || p.fuse <= 0) { this._detonate(p); continue; }

      p.vel.y += p.gravity * dt;
      const pos = p.mesh.position;
      pos.addScaledVector(p.vel, dt);

      // Flash faster as the fuse runs down — the universal "this is about to
      // go off" cue, and readable at a glance mid-firefight. `maxFuse` is the
      // value it was spawned with, so urgency climbs 0 -> 1 over its life.
      const urgency = clamp(1 - p.fuse / Math.max(p.maxFuse, 0.001), 0, 1);
      const blink = p.fuse < 0.6 ? (Math.sin(p.fuse * 46) * 0.5 + 0.5) : 1;
      p.mat.emissiveIntensity = 2.4 + urgency * 2.4 * blink;
      p.glowMat.opacity = (0.45 + 0.3 * blink) * (0.6 + urgency * 0.4);

      // ---- bounce / detonate on contact ----
      const gy = this.world.groundHeight(pos.x, pos.z, pos.y + 0.2);
      const hitFloor = pos.y <= gy + p.radius;
      const hitWall = this.world.isBlocked(
        pos.x, pos.z, p.radius, pos.y - p.radius, pos.y + p.radius
      );

      if (hitFloor || hitWall) {
        if (p.bounces < p.maxBounces) {
          p.bounces++;
          if (hitFloor) {
            pos.y = gy + p.radius;
            p.vel.y = -p.vel.y * 0.42;
            // Ground friction: a grenade that bounces forever would never
            // settle, and the player loses track of where they threw it.
            p.vel.x *= 0.72;
            p.vel.z *= 0.72;
          } else {
            // Bounce straight back off a wall it ran into.
            if (this.world.isBlocked(pos.x + p.vel.x * dt, pos.z, p.radius,
                                     pos.y - p.radius, pos.y + p.radius)) p.vel.x *= -0.5;
            if (this.world.isBlocked(pos.x, pos.z + p.vel.z * dt, p.radius,
                                     pos.y - p.radius, pos.y + p.radius)) p.vel.z *= -0.5;
            p.vel.y *= 0.85;
          }
          this.fx.impact(pos, this._v.set(0, 1, 0), p.mat.emissive.getHex());
        } else {
          this._detonate(p);
          continue;
        }
      }

      // Straight into an enemy? Detonate rather than pass through, so a grenade
      // never skims past a husk without dealing damage.
      const contact = this._enemyContact(p);
      if (contact) { this._detonate(p, contact); continue; }

      // Out of bounds — clean up without a blast.
      if (Math.abs(pos.x) > 70 || Math.abs(pos.z) > 70 || pos.y < -5) {
        this._kill(p);
        continue;
      }

      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      p.glow.position.copy(pos);
    }
  }

  /** Nearest enemy whose body sphere the grenade is currently inside. */
  _enemyContact(p) {
    const pos = p.mesh.position;
    for (const e of this.enemies.enemies) {
      if (e.dead || e.pendingSpawn) continue;
      const r = e.def.radius + p.radius;
      const dy = pos.y - e.position.y;
      if (dy < -0.4 || dy > e.def.height + 0.4) continue;
      const dx = pos.x - e.position.x;
      const dz = pos.z - e.position.z;
      if (dx * dx + dz * dz < r * r) return e;
    }
    return null;
  }

  /**
   * Radial damage with distance falloff and line-of-sight occlusion, then
   * knockback. `@param {object} [directHit]` enemy struck point-blank, which
   * takes full damage regardless of where the blast centre ended up.
   */
  _blast(p, directHit) {
    const centre = p.mesh.position;
    const R = p.blastRadius;
    const maxD = p.blastDamage;
    const floor = p.falloff;
    let hits = 0;
    let killed = 0;

    for (const e of this.enemies.enemies) {
      if (e.dead || e.pendingSpawn) continue;

      // Measure to the enemy's centre of mass, not its feet, so a grenade on
      // the floor still reaches something standing on it.
      const cy = e.position.y + e.def.height * 0.5;
      const dx = e.position.x - centre.x;
      const dy = cy - centre.y;
      const dz = e.position.z - centre.z;
      const dist = Math.hypot(dx, dy, dz);

      const reach = R + e.def.radius;
      if (dist > reach) continue;

      // Cover blocks the blast: no damage through a wall, but a grenade that
      // detonates at the enemy's feet obviously still reaches them.
      // `rayBlocked` takes scalars, not vectors.
      if (dist > e.def.radius + 0.5 && this.world.rayBlocked(
        centre.x, centre.y, centre.z, e.position.x, cy, e.position.z
      )) continue;

      let dmg;
      if (e === directHit) {
        dmg = maxD;
      } else {
        // Linear falloff to `floor` of max at the outer edge. Linear rather
        // than squared because a squared curve is so steep at the edge that
        // the blast radius is meaningless past the first couple of units.
        const k = clamp(1 - (dist - e.def.radius) / R, 0, 1);
        dmg = maxD * (floor + (1 - floor) * k);
      }

      // Falloff already models the blast envelope; no extra durability scaling
      // here, or a grenade would stop being worth using against brutes.
      hits++;
      const wasDead = e.takeDamage(
        dmg, this._v.set(dx, 0, dz).normalize(), false, centre, this.fx
      );
      e.knockback(dx, dz, p.knockback * (0.4 + 0.6 * (dmg / maxD)));
      if (wasDead) { killed++; this.onBlastKill?.(e); }
    }

    return { hits, killed };
  }

  _detonate(p, directHit) {
    const pos = p.mesh.position.clone();
    this._blast(p, directHit);
    this.fx.explosion(pos, 1.35, p.mat.emissive.getHex());
    this.audio?.scatterShot?.();
    this._kill(p);
  }

  _kill(p) {
    p.active = false;
    p.mesh.visible = false;
    p.glow.visible = false;
  }

  clear() {
    for (const p of this.pool) if (p.active) this._kill(p);
  }

  get activeCount() {
    let n = 0;
    for (const p of this.pool) if (p.active) n++;
    return n;
  }
}
