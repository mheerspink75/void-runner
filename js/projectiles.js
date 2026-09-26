/**
 * projectiles.js — Enemy projectiles (acid globs, brute shockwaves).
 *
 * Pooled: a fixed array of reusable meshes, reactivated on spawn. Each
 * projectile handles its own gravity, lifetime, world collision and player
 * hit detection.
 */

import * as THREE from '../vendor/three.module.js';
import { glowSprite, sparkSprite } from './textures.js';
import { clamp, rand } from './utils.js';

const POOL_SIZE = 48;

export class ProjectileManager {
  constructor(scene, world, player, audio, effects) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.audio = audio;
    this.fx = effects;

    /** @type {Array<{active:boolean, mesh:THREE.Mesh, vel:THREE.Vector3, life:number, damage:number, gravity:number, radius:number, color:number, hostile:boolean}>} */
    this.pool = [];
    this._buildPool();
  }

  _buildPool() {
    // One shared geometry; per-projectile materials so colours can differ.
    const geo = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd24a,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.pool.push({
        active: false, mesh, mat,
        vel: new THREE.Vector3(),
        life: 0, maxLife: 1, damage: 10, gravity: 0, radius: 0.3,
        color: 0xffd24a,
      });
    }
  }

  _acquire() {
    for (const p of this.pool) if (!p.active) return p;
    return null;   // pool exhausted — drop the shot rather than grow unbounded
  }

  /**
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} dir normalised
   * @param {object} def  projectile config from CONFIG
   * @param {object} [opts] { scale, color, hostile }
   */
  spawn(pos, dir, def, opts = {}) {
    const p = this._acquire();
    if (!p) return null;

    const scale = opts.scale ?? 1;
    p.active = true;
    p.mesh.visible = true;
    p.mesh.position.copy(pos);
    p.mesh.scale.setScalar(def.radius * scale);
    p.mat.color.setHex(opts.color ?? def.color);
    p.mesh.material.opacity = 1;
    p.vel.copy(dir).multiplyScalar(def.speed);
    p.life = def.life;
    p.maxLife = def.life;
    p.damage = def.damage;
    p.gravity = def.gravity;
    p.radius = def.radius * scale;
    p.color = opts.color ?? def.color;

    this.audio.enemyShoot(pos.x, pos.y, pos.z);
    return p;
  }

  update(dt) {
    const px = this.player.position.x;
    const py = this.player.position.y + this.player.eyeHeight * 0.7;
    const pz = this.player.position.z;

    for (const p of this.pool) {
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) { this._kill(p); continue; }

      p.vel.y += p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);

      // Rotate for a rolling look
      p.mesh.rotation.x += dt * 6;
      p.mesh.rotation.y += dt * 4;

      // ---- player hit (sphere test) ----
      if (!this.player.dead) {
        const dx = p.mesh.position.x - px;
        const dy = p.mesh.position.y - py;
        const dz = p.mesh.position.z - pz;
        const r = p.radius + 0.55;
        if (dx * dx + dy * dy + dz * dz < r * r) {
          if (this.player.damage(p.damage, p.mesh.position.x, p.mesh.position.z)) {
            this.fx.explosion(p.mesh.position, 0.5, p.color);
            this._kill(p);
            continue;
          }
        }
      }

      // ---- world / floor collision ----
      const pos = p.mesh.position;
      const gy = this.world.groundHeight(pos.x, pos.z, pos.y + 0.2);
      if (pos.y <= gy + p.radius) {
        this.fx.impact(pos, new THREE.Vector3(0, 1, 0), p.color);
        this.fx.explosion(pos, 0.45, p.color);
        this._kill(p);
        continue;
      }
      if (this.world.isBlocked(pos.x, pos.z, p.radius, pos.y - p.radius, pos.y + p.radius)) {
        this.fx.explosion(pos, 0.45, p.color);
        this._kill(p);
        continue;
      }
      // Out of bounds
      if (Math.abs(pos.x) > 70 || Math.abs(pos.z) > 70) { this._kill(p); continue; }
    }
  }

  _kill(p) {
    p.active = false;
    p.mesh.visible = false;
  }

  /** Lead the target so AI can aim where the player is going. */
  static leadShot(origin, player, projectileSpeed) {
    const target = new THREE.Vector3(
      player.position.x,
      player.position.y + 1.0,
      player.position.z
    );
    const flat = new THREE.Vector3(
      target.x - origin.x, 0, target.z - origin.z
    );
    const dist = flat.length();
    // Iterative time-of-flight solve (two passes is enough for this scale)
    let t = dist / projectileSpeed;
    for (let i = 0; i < 2; i++) {
      const pred = new THREE.Vector3(
        player.position.x + player.velocity.x * t,
        target.y,
        player.position.z + player.velocity.z * t
      );
      flat.set(pred.x - origin.x, 0, pred.z - origin.z);
      t = flat.length() / projectileSpeed;
    }
    target.set(
      player.position.x + player.velocity.x * t,
      target.y,
      player.position.z + player.velocity.z * t
    );
    return target.sub(origin).normalize();
  }

  clear() {
    for (const p of this.pool) this._kill(p);
  }
}
