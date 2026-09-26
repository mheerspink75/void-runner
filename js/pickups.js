/**
 * pickups.js — Floating pickups dropped by enemies.
 *
 * Types: health, ammo, stamina, overdrive.
 * Pickups are launched with a small pop, settle onto geometry, magnetise
 * toward the player when close, and expire.
 */

import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { rand, clamp, damp } from './utils.js';
import { glowSprite } from './textures.js';

const P = CONFIG.pickups;

export class PickupManager {
  constructor(scene, world, player, audio, effects, lightPool) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.audio = audio;
    this.fx = effects;
    // Shared light pool — see lightpool.js. Pickup templates must not bake in
    // their own PointLight, because a light baked into a template is cloned
    // into every drop, so the scene's light count would track live pickups.
    this.lightPool = lightPool;
    /** @type {Array<{group:THREE.Group,kind:string,life:number,phase:number,spin:number,value:number}>} */
    this.items = [];

    this._buildTemplates();
  }

  _buildTemplates() {
    // ---------- HEALTH: red cross cube ----------
    const health = new THREE.Group();
    const hMat = new THREE.MeshStandardMaterial({
      color: 0x3a0e1a, emissive: 0xff2d55, emissiveIntensity: 2.4, roughness: 0.3,
    });
    health.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), hMat));
    health.add(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.14, 0.53), hMat));
    health.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.52, 0.53), hMat));
    this.tplHealth = health;

    // ---------- AMMO: cyan crate with rounds ----------
    const ammo = new THREE.Group();
    const aMat = new THREE.MeshStandardMaterial({
      color: 0x0a2230, emissive: 0x00e5ff, emissiveIntensity: 2.4, roughness: 0.3,
    });
    ammo.add(new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.32, 0.62), aMat));
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.1), aMat);
    lip.position.set(0, 0.18, -0.2);
    ammo.add(lip);
    for (const sx of [-1, 1]) {
      const rnd = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 8), aMat);
      rnd.position.set(sx * 0.14, 0.18, 0.05);
      ammo.add(rnd);
    }
    this.tplAmmo = ammo;

    // ---------- STAMINA: green capsule ----------
    const stam = new THREE.Group();
    const sMat = new THREE.MeshStandardMaterial({
      color: 0x0f2a18, emissive: 0x39ff88, emissiveIntensity: 2.4, roughness: 0.3,
    });
    const sBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.28, 4, 10), sMat);
    sBody.rotation.z = Math.PI / 2;
    stam.add(sBody);
    this.tplStamina = stam;

    // ---------- OVERDRIVE: orange hex core ----------
    const od = new THREE.Group();
    const oMat = new THREE.MeshStandardMaterial({
      color: 0x3a2408, emissive: 0xffa32a, emissiveIntensity: 3.0, roughness: 0.2,
    });
    od.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), oMat));
    const oRing = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.03, 6, 20), oMat);
    oRing.rotation.x = Math.PI / 2;
    od.add(oRing);
    this.tplOverdrive = od;

    this._haloBase = glowSprite('#ffffff');
  }

  _template(kind) {
    switch (kind) {
      case 'health': return this.tplHealth;
      case 'ammo': return this.tplAmmo;
      case 'stamina': return this.tplStamina;
      case 'overdrive': return this.tplOverdrive;
      default: return this.tplAmmo;
    }
  }

  _tint(kind) {
    switch (kind) {
      case 'health': return 0xff2d55;
      case 'stamina': return 0x39ff88;
      case 'overdrive': return 0xffa32a;
      default: return 0x00e5ff;
    }
  }

  _defaultValue(kind) {
    switch (kind) {
      case 'health': return P.healthAmount;
      case 'stamina': return P.staminaAmount;
      case 'ammo': return P.ammoAmount;
      case 'overdrive': return P.overdriveDuration;
      default: return P.ammoAmount;
    }
  }

  /** Drop a pickup at the given world position. */
  drop(kind, x, y, z, value) {
    const g = this._template(kind).clone(true);

    // Halo so pickups read from a distance
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._haloBase,
      color: this._tint(kind),
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    halo.scale.setScalar(1.6);
    g.add(halo);

    g.position.set(x, Math.max(y, 0.5), z);
    this.scene.add(g);

    // Illumination from the shared pool so live pickups never change the
    // scene's light count. Optional: if the pool is full the pickup still
    // reads via its emissive materials and halo.
    const light = this.lightPool?.acquire(
      g.position.x, g.position.y + 0.3, g.position.z,
      this._tint(kind), 2.2, 7
    ) ?? null;

    this.items.push({
      group: g,
      halo,
      light,
      kind,
      life: P.lifetime,
      phase: rand(0, Math.PI * 2),
      spin: rand(0.8, 1.6) * P.spinSpeed,
      value: value ?? this._defaultValue(kind),
      // Small pop so drops scatter rather than stacking
      vel: new THREE.Vector3(rand(-1.4, 1.4), rand(2.5, 4.5), rand(-1.4, 1.4)),
      magnetised: false,
    });
  }

  /** Choose what to drop when an enemy dies, weighted by need. */
  rollDrop(x, y, z, chance) {
    if (Math.random() > chance) return;
    const hurt = this.player.health < 50;
    const tired = this.player.stamina < 35;
    const roll = Math.random();

    if (hurt && roll < 0.55) this.drop('health', x, y, z);
    else if (tired && roll < 0.42) this.drop('stamina', x, y, z);
    else if (roll < 0.30) this.drop('overdrive', x, y, z);
    else if (roll < 0.52) this.drop('health', x, y, z);
    else this.drop('ammo', x, y, z);
  }

  update(dt) {
    const px = this.player.position.x;
    const py = this.player.position.y;
    const pz = this.player.position.z;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      it.phase += dt * P.bobSpeed;

      const pos = it.group.position;
      const dx = px - pos.x;
      const dz = pz - pos.z;
      const dy = (py + 0.9) - pos.y;
      const dist = Math.hypot(dx, dy, dz);

      // ---- magnetise when reasonably close ----
      if (dist < P.magnetRadius * 2.2) it.magnetised = true;
      if (it.magnetised) {
        const pull = 16 / Math.max(dist, 0.4);
        it.vel.x += (dx / (dist || 1)) * pull * dt;
        it.vel.y += (dy / (dist || 1)) * pull * dt;
        it.vel.z += (dz / (dist || 1)) * pull * dt;
      }

      // ---- integrate ----
      pos.x += it.vel.x * dt;
      pos.y += it.vel.y * dt;
      pos.z += it.vel.z * dt;

      if (!it.magnetised) {
        it.vel.y -= 14 * dt;               // gravity
        it.vel.x *= Math.max(0, 1 - 2.2 * dt);
        it.vel.z *= Math.max(0, 1 - 2.2 * dt);
      }

      // ---- settle on the floor / platform ----
      const gy = this.world.groundHeight(pos.x, pos.z, pos.y + 0.3);
      if (pos.y <= gy + 0.55) {
        pos.y = gy + 0.55;
        if (!it.magnetised) it.vel.y = 0;
      }

      // ---- idle animation ----
      if (!it.magnetised) {
        pos.y += Math.sin(it.phase) * P.bobHeight * dt * 6;
        it.group.rotation.y += dt * it.spin;
        it.group.rotation.x = Math.sin(it.phase * 0.5) * 0.22;
      }
      if (it.halo) {
        it.halo.material.opacity = 0.32 + Math.sin(it.phase * 1.6) * 0.16;
      }
      if (it.light) {
        // The light is a scene-level object, not a child of the pickup group,
        // so it has to be told where the pickup is each frame.
        it.light.position.set(pos.x, pos.y + 0.3, pos.z);
      }

      // ---- expire blink ----
      if (it.life < 4) {
        it.group.visible = Math.floor(it.life * 8) % 2 === 0;
      }

      // ---- collect ----
      if (dist < 1.35 && this._collect(it)) {
        this.scene.remove(it.group);
        it.halo?.material.dispose();
        if (it.light) this.lightPool?.release(it.light);
        this.items.splice(i, 1);
        continue;
      }

      if (it.life <= 0) {
        this.scene.remove(it.group);
        it.halo?.material.dispose();
        if (it.light) this.lightPool?.release(it.light);
        this.items.splice(i, 1);
      }
    }
  }

  _collect(it) {
    const pos = it.group.position;
    const at = new THREE.Vector3(pos.x, pos.y + 0.5, pos.z);

    switch (it.kind) {
      case 'health': {
        if (this.player.health >= CONFIG.player.maxHealth) return false;
        const healed = this.player.heal(it.value);
        this.audio.pickup('health');
        this.fx.popup(at, `+${Math.round(healed)}`, 'incoming');
        this.onCollect?.('health', healed);
        return true;
      }

      case 'stamina': {
        if (this.player.stamina >= CONFIG.player.maxStamina) return false;
        this.player.stamina = Math.min(
          CONFIG.player.maxStamina, this.player.stamina + it.value
        );
        this.audio.pickup('ammo');
        this.fx.popup(at, `+${it.value} STAM`, 'incoming');
        this.onCollect?.('stamina', it.value);
        return true;
      }

      case 'overdrive': {
        this.audio.pickup('health');
        this.fx.popup(at, 'OVERDRIVE', 'crit');
        this.onCollect?.('overdrive', it.value);
        return true;
      }

      case 'ammo':
      default: {
        // The Game handler reports how much ammo was actually taken; if the
        // player is already full, leave the pickup on the ground.
        const got = this.onCollect ? this.onCollect('ammo', it.value) : it.value;
        if (got === 0) return false;
        this.audio.pickup('ammo');
        return true;
      }
    }
  }

  clear() {
    for (const it of this.items) {
      this.scene.remove(it.group);
      it.halo?.material.dispose();
      if (it.light) this.lightPool?.release(it.light);
    }
    this.items.length = 0;
  }
}
