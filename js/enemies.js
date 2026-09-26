/**
 * enemies.js — Enemy models, AI and the spawn manager.
 *
 * Three archetypes share one AI core but differ in stats, geometry and
 * behaviour tuning:
 *   HUSK      — baseline chaser
 *   JUGGERNAUT — slow tank, big damage, ranged projectile
 *   PHANTOM   — fast, erratic, hard to hit
 */

import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { ProjectileManager } from './projectiles.js';
import { rand, randInt, clamp, damp, lerp, angleDelta, weightedPick } from './utils.js';

const E = CONFIG.enemies;

/* ------------------------------------------------------------------
 * Hitboxes: a simple body capsule + head sphere, both mesh targets
 * carrying `userData.enemyRef` and `userData.headshot`.
 * ------------------------------------------------------------------ */

let hitGeoCache = null;
function hitGeos() {
  if (!hitGeoCache) {
    hitGeoCache = {
      body: new THREE.CapsuleGeometry(0.5, 1, 4, 8),
      head: new THREE.SphereGeometry(0.32, 8, 6),
    };
  }
  return hitGeoCache;
}

/* ------------------------------------------------------------------
 * Procedural enemy models
 * ------------------------------------------------------------------ */
function buildModel(kind) {
  const def = E[kind];
  const g = new THREE.Group();

  // Enemies are lit by their own emissive accents plus the scene env map.
  // A too-dark base colour makes them read as black cut-outs, so the skin is
  // kept mid-tone and carries a modest self-lit floor.
  const skin = new THREE.MeshStandardMaterial({
    color: def.color,
    roughness: 0.72,
    metalness: 0.05,
    emissive: new THREE.Color(def.emissive).multiplyScalar(0.18),
    emissiveIntensity: 1.0,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x39424d, roughness: 0.55, metalness: 0.35,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: 0x101010,
    emissive: def.emissive,
    emissiveIntensity: 3.0,
  });
  const bone = new THREE.MeshStandardMaterial({
    color: 0xe8e0c8, roughness: 0.85, metalness: 0.0,
    emissive: 0x2a2620, emissiveIntensity: 1.0,
  });

  const scale = def.height / 1.85;   // models authored around 1.85 units
  g.scale.setScalar(scale);
  g.userData.baseScale = scale;

  // Remember each material's resting emissive strength so the hurt flash can
  // restore it exactly instead of guessing a global constant.
  g.traverse((o) => {
    if (o.isMesh && o.material?.emissive) {
      o.material.userData.baseEmissive = o.material.emissiveIntensity;
    }
  });

  if (kind === 'grunt') {
    // Hunched humanoid, built around a hip pivot so the legs can genuinely
    // swing. Previously the legs were static capsules parented straight to the
    // root, which is why the walk cycle had to fake the whole body with a bob.
    const hips = new THREE.Group();
    hips.position.y = 0.68;
    g.add(hips);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.78, 0.4), skin);
    torso.position.y = 0.44;
    torso.rotation.x = 0.22;
    hips.add(torso);

    // Rib plating — breaks up the flat box silhouette from the side.
    for (let i = 0; i < 3; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.05, 0.44), dark);
      rib.position.set(0, 0.22 + i * 0.2, 0.02);
      hips.add(rib);
    }

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.36, 0.34), skin);
    head.position.set(0, 1.0, 0.1);
    head.rotation.x = 0.2;
    hips.add(head);

    // Glowing eyes, set into a darker brow so they read at distance
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.09, 0.05), dark);
    brow.position.set(0, 1.1, 0.26);
    hips.add(brow);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.04), glow);
      eye.position.set(sx * 0.09, 1.04, 0.28);
      hips.add(eye);
    }

    // Arms hang from a shoulder pivot at the top of the torso, so the swing
    // happens at the shoulder rather than shearing the whole limb.
    const armGeo = new THREE.CapsuleGeometry(0.1, 0.6, 3, 6);
    const armL = new THREE.Group();
    const armR = new THREE.Group();
    for (const [pivot, sx] of [[armL, -1], [armR, 1]]) {
      pivot.position.set(sx * 0.4, 0.74, 0.05);
      const arm = new THREE.Mesh(armGeo, skin);
      arm.position.y = -0.34;
      arm.rotation.z = -sx * 0.12;
      pivot.add(arm);
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3, 5), bone);
      claw.position.set(0, -0.72, 0.02);
      claw.rotation.x = Math.PI;
      pivot.add(claw);
      hips.add(pivot);
    }

    // Legs pivot at the hip. Rest rotation is stored so the walk cycle can
    // oscillate around it rather than snapping to zero.
    const legGeo = new THREE.CapsuleGeometry(0.13, 0.55, 3, 6);
    const legs = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.16, 0, 0);
      const leg = new THREE.Mesh(legGeo, skin);
      leg.position.y = -0.33;
      pivot.add(leg);
      // Foot
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.26), dark);
      foot.position.set(0, -0.66, 0.06);
      pivot.add(foot);
      hips.add(pivot);
      legs.push(pivot);
    }

    g.userData.limbs = { armL, armR, legs, hips };
  }

  if (kind === 'stalker') {
    // Slim, tall, with a trailing cloak and glowing core
    const torso = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.2, 6), skin);
    torso.position.y = 1.05;
    g.add(torso);

    const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.5, 6, 1, true), dark);
    cloak.position.y = 0.9;
    cloak.rotation.x = Math.PI;
    g.add(cloak);

    const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), skin);
    head.position.y = 1.72;
    g.add(head);

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), glow);
    core.position.set(0, 1.15, 0.3);
    g.add(core);

    // Long blade arms
    const armGeo = new THREE.ConeGeometry(0.07, 0.95, 5);
    const armL = new THREE.Group();
    const armR = new THREE.Group();
    for (const [pivot, sx] of [[armL, -1], [armR, 1]]) {
      pivot.position.set(sx * 0.36, 1.15, 0);
      const arm = new THREE.Mesh(armGeo, bone);
      arm.position.y = -0.5;
      arm.rotation.x = Math.PI;
      arm.rotation.z = sx * 0.22;
      pivot.add(arm);
      g.add(pivot);
    }

    // Thin spike legs, pivoting at the hip
    const legs = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.14, 0.72, 0);
      const leg = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.7, 5), dark);
      leg.position.y = -0.35;
      leg.rotation.x = Math.PI;
      pivot.add(leg);
      g.add(pivot);
      legs.push(pivot);
    }

    // Trailing shoulder shards — reads as a silhouette even in silhouette
    for (const sx of [-1, 1]) {
      const shard = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.5, 4), dark);
      shard.position.set(sx * 0.2, 1.5, -0.12);
      shard.rotation.set(-0.3, 0, sx * 0.4);
      g.add(shard);
    }

    g.userData.limbs = { armL, armR, legs };
  }

  if (kind === 'spitter') {
    // Squat, bulbous sac-body with a glowing maw
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 10), skin);
    body.position.y = 1.05;
    body.scale.set(1, 0.85, 1.05);
    g.add(body);

    // Dorsal spines
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spine = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.4, 5), bone);
      spine.position.set(Math.cos(a) * 0.5, 1.45, Math.sin(a) * 0.5);
      spine.rotation.set(Math.PI * 0.32 * Math.sin(a), 0, -Math.PI * 0.32 * Math.cos(a));
      g.add(spine);
    }

    // Maw / sac glow
    const maw = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), glow);
    maw.position.set(0, 1.05, 0.52);
    g.add(maw);
    g.userData.maw = maw;

    // Stubby legs
    const legs = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const pivot = new THREE.Group();
      pivot.position.set(Math.cos(a) * 0.36, 0.5, Math.sin(a) * 0.36);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.5, 6), dark);
      leg.position.y = -0.25;
      pivot.add(leg);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 5), dark);
      foot.position.y = -0.5;
      pivot.add(foot);
      g.add(pivot);
      legs.push(pivot);
    }

    // Under-sac glow: a second emissive band low on the body, so the creature
    // reads as lit from within even when the maw is not charging.
    const sacGlow = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), glow);
    sacGlow.position.set(0, 0.86, -0.12);
    sacGlow.scale.set(1, 0.55, 1);
    g.add(sacGlow);

    g.userData.limbs = { legs };
  }

  if (kind === 'brute') {
    // Heavy, planted stance. Same hip-pivot approach as the grunt so the
    // Juggernaut's weight shift actually shows in the legs.
    const hips = new THREE.Group();
    hips.position.y = 1.0;
    g.add(hips);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.05, 0.78), skin);
    torso.position.y = 0.62;
    hips.add(torso);

    // Armor plates, angled so the silhouette has a keel rather than a box
    for (let i = 0; i < 3; i++) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(1.24 - i * 0.06, 0.14, 0.84 - i * 0.04), dark);
      plate.position.set(0, 0.28 + i * 0.36, 0);
      plate.rotation.x = -0.08 + i * 0.05;
      hips.add(plate);
    }

    // Back exhaust stacks
    for (const sx of [-1, 1]) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.5, 8), dark);
      stack.position.set(sx * 0.34, 1.24, -0.34);
      stack.rotation.x = 0.2;
      hips.add(stack);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 8), glow);
      tip.position.set(sx * 0.34, 1.5, -0.4);
      hips.add(tip);
    }

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.5), skin);
    head.position.set(0, 1.5, 0.12);
    hips.add(head);

    // Glowing visor
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.09, 0.06), glow);
    visor.position.set(0, 1.55, 0.38);
    hips.add(visor);

    // Arms hang from shoulder pivots, fists below
    const armGeo = new THREE.CapsuleGeometry(0.22, 0.85, 4, 8);
    const armL = new THREE.Group();
    const armR = new THREE.Group();
    for (const [pivot, sx] of [[armL, -1], [armR, 1]]) {
      pivot.position.set(sx * 0.72, 1.0, 0.05);
      const arm = new THREE.Mesh(armGeo, skin);
      arm.position.y = -0.5;
      pivot.add(arm);
      const fist = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 0), dark);
      fist.position.set(0, -1.05, 0.05);
      pivot.add(fist);
      hips.add(pivot);
    }

    // Short, wide legs
    const legs = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.3, 0, 0);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.86, 8), skin);
      leg.position.y = -0.43;
      pivot.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.42), dark);
      foot.position.set(0, -0.88, 0.08);
      pivot.add(foot);
      hips.add(pivot);
      legs.push(pivot);
    }

    g.userData.limbs = { armL, armR, legs, hips };
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  return g;
}

/* ------------------------------------------------------------------
 * Enemy instance
 * ------------------------------------------------------------------ */
export class Enemy {
  constructor(kind, scene, world, player, audio, effects, lightPool) {
    this.kind = kind;
    this.def = E[kind];
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.audio = audio;
    this.fx = effects;
    this.lightPool = lightPool;

    this.maxHealth = this.def.health;
    this.health = this.maxHealth;
    this.dead = false;
    this.deathT = 0;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.vy = 0;
    this.onGround = false;
    this.yaw = 0;
    this.targetYaw = 0;

    this.state = 'idle';     // idle | chase | windup | recover | strafe | dead
    this.stateT = 0;
    this.attackCd = rand(0, 1);
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = 0;

    // ---- Flanking / AI memory ----
    // Enemies commit to a flank direction for a while instead of beelining,
    // which stops the whole pack from converging on one point.
    this.flankTimer = 0;
    this.flankSide = Math.random() < 0.5 ? -1 : 1;
    this.repathT = 0;
    this.stuckT = 0;
    this._lastPos = new THREE.Vector3();
    this.strafeBias = rand(0.4, 0.9);

    // Combat stats scale with the wave they spawned on
    this.speedScale = 1;
    this.damageScale = 1;

    this.walkPhase = rand(0, 6);
    this.growlCd = rand(2, 7);
    this.hurtFlash = 0;
    this.lastDamageFrom = null;

    // ---- visuals ----
    this.model = buildModel(kind);
    scene.add(this.model);

    // ---- hitboxes (invisible, added to the scene for raycasting) ----
    const geos = hitGeos();
    this.hitMesh = new THREE.Mesh(geos.body, new THREE.MeshBasicMaterial({ visible: false }));
    this.headMesh = new THREE.Mesh(geos.head, new THREE.MeshBasicMaterial({ visible: false }));

    const bodyH = this.def.height * 0.52;
    this.hitMesh.scale.set(def_radius(this.def) * 1.35, bodyH / 1.0, def_radius(this.def) * 1.35);
    this.hitMesh.position.y = bodyH;
    this.headMesh.scale.setScalar(this.kind === 'brute' ? 0.9 : 0.62);
    this.headMesh.position.y = this.def.height * 0.88;

    this.hitMesh.userData.enemyRef = this;
    this.headMesh.userData.enemyRef = this;
    this.hitMesh.userData.headshot = false;
    this.headMesh.userData.headshot = true;

    this.hitGroup = new THREE.Group();
    this.hitGroup.add(this.hitMesh, this.headMesh);
    scene.add(this.hitGroup);

    // Health bar sprite (shown when damaged)
    this._makeHealthBar();

    // Light for emissive enemies (keeps them visible in the dark). Comes from
    // the shared pool so the scene's light count never changes — see
    // lightpool.js. The pool is sized for waves.maxAlive, so a live enemy
    // always gets a slot; null is tolerated by the intensity guards below.
    this.light = this.lightPool?.acquire(
      0, this.def.height * 0.6, 0,
      this.def.emissive,
      kind === 'brute' ? 0.9 : 0.5,
      8
    ) ?? null;
  }

  _makeHealthBar() {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 6;
    this._hbCanvas = cv;
    this._hbTex = new THREE.CanvasTexture(cv);
    this._hbTex.colorSpace = THREE.SRGBColorSpace;
    this.hb = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this._hbTex, transparent: true, depthTest: false })
    );
    this.hb.scale.set(1.2, 0.11, 1);
    this.hb.position.y = this.def.height + 0.45;
    this.hb.visible = false;
    this.hb.renderOrder = 999;
    this.model.add(this.hb);
    this._hbShown = false;
  }

  _drawHealthBar() {
    const c = this._hbCanvas;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 64, 6);
    const k = clamp(this.health / this.maxHealth, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, 64, 6);
    ctx.fillStyle = k > 0.5 ? '#39ff88' : k > 0.25 ? '#ffcc33' : '#ff2d55';
    ctx.fillRect(1, 1, 62 * k, 4);
    this._hbTex.needsUpdate = true;
  }

  spawn(x, z, wave = 1) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.vy = 0;

    // Scale health and speed with the wave number.
    const hpMul = 1 + CONFIG.waves.healthScale * (wave - 1);
    this.maxHealth = this.def.health * hpMul;
    this.health = this.maxHealth;
    this.speedScale = 1 + CONFIG.waves.speedScale * (wave - 1);
    this.damageScale = 1 + CONFIG.waves.healthScale * 0.4 * (wave - 1);

    this.dead = false;
    this.deathT = 0;
    this.state = 'chase';
    this.attackCd = rand(0, 1.2);
    this.hurtFlash = 0;
    this.flankTimer = 0;
    this.stuckT = 0;
    this._lastPos.copy(this.position);

    this.model.visible = true;
    this.hitGroup.visible = true;
    this.model.scale.setScalar(this.model.userData.baseScale ?? (this.def.height / 1.85));
    this.model.rotation.set(0, 0, 0);
    this.model.position.copy(this.position);
    this.hitGroup.position.copy(this.position);
    this.audio.growl(x, 1.5, z, this.kind);
  }

  /** External push (melee knockback, explosions). */
  knockback(dirX, dirZ, force) {
    this.velocity.x += dirX * force;
    this.velocity.z += dirZ * force;
    // A solid knockback interrupts an attack
    if (this.state === 'windup') {
      this.state = 'recover';
      this.stateT = 0;
      this.attackCd = Math.max(this.attackCd, 0.4);
    }
  }

  // ==================================================================
  // Damage
  // ==================================================================
  /**
   * @returns {boolean} true if this hit killed the enemy
   */
  takeDamage(amount, dir, isHead, point, fx) {
    if (this.dead) return false;
    this.health -= amount;
    this.hurtFlash = 0.16;

    // Reveal health bar briefly
    if (!this._hbShown) {
      this._hbShown = true;
      this.hb.visible = true;
    }
    this._drawHealthBar();
    this._hbTimer = 3.5;

    if (this.health <= 0) {
      this.die(dir);
      return true;
    }
    return false;
  }

  die(dir) {
    if (this.dead) return;
    this.dead = true;
    this.state = 'dead';
    this.deathT = 0;
    this.hitGroup.visible = false;
    this.hb.visible = false;
    this._hbShown = false;

    const scale = this.kind === 'brute' ? 1.8 : this.kind === 'stalker' ? 0.8 : 1;
    this.fx.explosion(
      new THREE.Vector3(this.position.x, this.position.y + this.def.height * 0.5, this.position.z),
      scale, this.def.emissive
    );
    this.audio.enemyDeath(this.position.x, this.position.y + 1, this.position.z);
    this.onDeath?.(this);
  }

  dispose() {
    this.scene.remove(this.model);
    this.scene.remove(this.hitGroup);
    if (this.light) this.lightPool?.release(this.light);
    this.hitMesh.geometry === undefined; // shared geo, don't dispose
    this._hbTex.dispose();
    this.hb.material.dispose();
  }

  // ==================================================================
  // AI + physics update
  // ==================================================================
  update(dt, enemies) {
    // ---- materialising from a spawn portal ----
    // While pending, the enemy is invisible and cannot be hit, so a player
    // cannot shoot something they have not seen yet.
    if (this.pendingSpawn) {
      this.pendingSpawn.t -= dt;
      if (this.pendingSpawn.t <= 0) {
        const p = this.pendingSpawn;
        this.pendingSpawn = null;
        this.spawn(p.x, p.z, p.wave);
        // A small flare as it finishes materialising
        this.fx.flash(
          new THREE.Vector3(p.x, this.def.height * 0.5, p.z),
          this.def.emissive, 1.4, 0.16
        );
      }
      return false;
    }

    if (this.dead) {
      this.deathT += dt;
      // Sink and fade
      const k = clamp(this.deathT / 0.55, 0, 1);
      this.model.position.y = this.position.y - k * 0.9;
      this.model.scale.setScalar((this.def.height / 1.85) * (1 - k * 0.35));
      this.model.rotation.z = k * 0.9;
      if (this.light) this.light.intensity = (1 - k) * 0.5;
      return this.deathT > 0.55;
    }

    this.stateT += dt;
    if (this.attackCd > 0) this.attackCd -= dt;
    if (this.growlCd > 0) this.growlCd -= dt;
    if (this.hurtFlash > 0) this.hurtFlash -= dt;
    if (this._hbTimer > 0) {
      this._hbTimer -= dt;
      if (this._hbTimer <= 0) { this.hb.visible = false; this._hbShown = false; }
    }

    const p = this.player;
    const dx = p.position.x - this.position.x;
    const dz = p.position.z - this.position.z;
    const distToPlayer = Math.hypot(dx, dz);

    // ---- orientation ----
    this.targetYaw = Math.atan2(dx, dz);
    this.yaw += angleDelta(this.yaw, this.targetYaw) * clamp(dt * 7, 0, 1);

    // ---- vertical (gravity + terrain) ----
    this.vy += CONFIG.world.gravity * dt;
    this.vy = Math.max(this.vy, -60);
    this.position.y += this.vy * dt;
    this.onGround = false;

    // Standing surface: arena floor or the top of a cover box/platform.
    const gy = this.world.groundHeight(this.position.x, this.position.z, this.position.y + 0.05);
    if (this.position.y <= gy) {
      this.position.y = gy;
      this.vy = 0;
      this.onGround = true;
    }

    // ---- combat behaviour ----
    let desiredX = 0, desiredZ = 0;
    const speed = this.def.speed * this.speedScale;

    // Flank commitment timer — pick a side and stick to it for a while so
    // the pack surrounds the player instead of forming a single conga line.
    if (this.flankTimer > 0) {
      this.flankTimer -= dt;
    } else {
      this.flankTimer = rand(1.4, 3.4);
      this.flankSide = Math.random() < 0.5 ? -1 : 1;
    }

    if (!p.dead) {
      const canSee = distToPlayer < 55 &&
        !this.world.rayBlocked(
          this.position.x, this.position.y + this.def.height * 0.6, this.position.z,
          p.position.x, p.position.y + 1.2, p.position.z
        );

      const inv = 1 / (distToPlayer || 1);
      const ux = dx * inv;   // unit vector toward the player
      const uz = dz * inv;
      // Perpendicular for flanking
      const px_ = -uz * this.flankSide;
      const pz_ = ux * this.flankSide;

      if (this.def.ranged) {
        // ---------- Kiting behaviour ----------
        const want = this.def.attackRange;
        const tooClose = distToPlayer < this.def.minRange;
        const tooFar = distToPlayer > want;

        if (tooClose) {
          // Back away while strafing
          desiredX = -ux + px_ * 0.5;
          desiredZ = -uz + pz_ * 0.5;
        } else if (tooFar) {
          desiredX = ux;
          desiredZ = uz;
        } else {
          // In the pocket: orbit
          desiredX = px_ * 0.8;
          desiredZ = pz_ * 0.8;
        }

        if (distToPlayer <= want && distToPlayer >= this.def.minRange &&
            this.attackCd <= 0 && canSee) {
          this.state = 'windup';
          this.stateT = 0;
        }
      } else {
        // ---------- Melee behaviour ----------
        const idealRange = this.kind === 'brute' ? 2.0 : this.def.attackRange * 0.72;

        switch (this.state) {
          case 'chase': {
            if (distToPlayer > idealRange) {
              // Head toward the player, biased sideways to spread out
              const bias = this.strafeBias * (this.kind === 'stalker' ? 1.0 : 0.55);
              desiredX = ux * (1 - bias * 0.5) + px_ * bias;
              desiredZ = uz * (1 - bias * 0.5) + pz_ * bias;

              // Phantom orbits harder at mid range
              if (this.kind === 'stalker' && distToPlayer < 18) {
                desiredX = ux * 0.3 + px_ * 1.1;
                desiredZ = uz * 0.3 + pz_ * 1.1;
              }
            } else if (distToPlayer < idealRange * 0.65) {
              // Slight back-off so they do not clip into the player
              desiredX = -ux * 0.6;
              desiredZ = -uz * 0.6;
            }

            if (distToPlayer <= this.def.attackRange && this.attackCd <= 0 && canSee) {
              this.state = 'windup';
              this.stateT = 0;
              this.audio.growl(this.position.x, 1.5, this.position.z, this.kind);
            }
            break;
          }

          case 'windup': {
            // Telegraph before the strike
            if (this.stateT > (this.kind === 'stalker' ? 0.18 : 0.3)) {
              this.state = 'recover';
              this.stateT = 0;
              this._attack(p, distToPlayer);
            }
            break;
          }

          case 'recover': {
            if (this.stateT > this.def.attackCooldown) {
              this.state = 'chase';
              this.stateT = 0;
              this.attackCd = this.def.attackCooldown;
              this.strafeDir = this.flankSide;
            }
            break;
          }
        }
      }
    } else {
      // Player dead: idle wander
      this.state = 'chase';
      if (Math.random() < dt * 0.4) this.strafeDir *= -1;
      desiredX = Math.cos(this.yaw + Math.PI / 2) * this.strafeDir * 0.4;
      desiredZ = Math.sin(this.yaw + Math.PI / 2) * this.strafeDir * 0.4;
    }

    // ---- separation from other enemies (avoid stacking) ----
    let sepX = 0, sepZ = 0;
    for (const o of enemies) {
      if (o === this || o.dead || o.pendingSpawn) continue;
      const ox = this.position.x - o.position.x;
      const oz = this.position.z - o.position.z;
      const d2 = ox * ox + oz * oz;
      const minD = this.def.radius + o.def.radius + 0.3;
      if (d2 < minD * minD && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        sepX += (ox / d) * (1 - d / minD);
        sepZ += (oz / d) * (1 - d / minD);
      }
    }
    desiredX += sepX * 1.6;
    desiredZ += sepZ * 1.6;

    // ---- unstick: if an enemy is pinned but still wants to move, sidestep.
    // Without this, packs jam against cover and stop threatening.
    const moved = Math.hypot(
      this.position.x - this._lastPos.x,
      this.position.z - this._lastPos.z
    );
    const wantsToMove = Math.hypot(desiredX, desiredZ) > 0.1;
    if (wantsToMove && moved < 0.02) {
      this.stuckT += dt;
    } else {
      this.stuckT = 0;
    }
    if (this.stuckT > 0.45) {
      this.flankSide *= -1;          // commit to the other side
      this.flankTimer = rand(1.0, 2.0);
      this.stuckT = 0;
      this.state = 'chase';
      this.stateT = 0;
    }
    this._lastPos.copy(this.position);

    // ---- integrate movement ----
    const dl = Math.hypot(desiredX, desiredZ);
    if (dl > 0.001) {
      desiredX /= dl; desiredZ /= dl;
      const accel = this.onGround ? 42 : 9;
      this.velocity.x += desiredX * accel * dt;
      this.velocity.z += desiredZ * accel * dt;
    } else {
      this.velocity.x *= Math.max(0, 1 - 8 * dt);
      this.velocity.z *= Math.max(0, 1 - 8 * dt);
    }
    if (this.onGround) {
      const sp2 = Math.hypot(this.velocity.x, this.velocity.z);
      if (sp2 > 0) {
        const k = Math.max(0, sp2 - 26 * dt) / sp2;
        this.velocity.x *= k; this.velocity.z *= k;
      }
    }
    // Clamp speed
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    if (sp > speed) {
      const k = speed / sp;
      this.velocity.x *= k; this.velocity.z *= k;
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // ---- world collision ----
    this.world.resolve(this.position, this.def.radius, this.def.height);

    // ---- keep inside arena ----
    const lim = CONFIG.world.halfSize - this.def.radius;
    this.position.x = clamp(this.position.x, -lim, lim);
    this.position.z = clamp(this.position.z, -lim, lim);

    // ---- periodic growl ----
    if (this.growlCd <= 0 && distToPlayer < 30) {
      this.audio.growl(this.position.x, 1.5, this.position.z, this.kind);
      this.growlCd = rand(3, 9);
    }

    // ---- visuals ----
    this._animate(dt, sp);
    return false;
  }

  _attack(player, dist) {
    // Ranged archetypes fire a projectile instead of striking.
    if (this.def.ranged) {
      this.onShoot?.(this);
      return;
    }

    // Brute shockwave when it cannot reach melee
    if (this.kind === 'brute' && dist > 4) {
      this.onShoot?.(this);
      this.audio.enemyShoot(this.position.x, 1.6, this.position.z);
    }

    if (dist <= this.def.attackRange + 0.4) {
      player.damage(this.def.damage * this.damageScale, this.position.x, this.position.z);
    }
  }

  _animate(dt, speed) {
    this.model.position.set(this.position.x, this.position.y, this.position.z);
    this.hitGroup.position.copy(this.position);
    this.model.rotation.y = this.yaw;

    // Walk cycle. The phase rate scales with actual speed so a slow shuffle
    // and a sprint are visibly different gaits, not the same cycle slowed.
    const stride = this.kind === 'stalker' ? 1.7 : 1.2;
    this.walkPhase += dt * (2.4 + speed * 1.5) * stride;
    const w = Math.sin(this.walkPhase);
    const w2 = Math.sin(this.walkPhase * 2);
    // 0 when standing still, 1 at full speed — everything below is scaled by
    // this so an idle enemy is genuinely still instead of twitching.
    const gait = clamp(speed / 3, 0, 1);
    const limbs = this.model.userData.limbs;

    // Vertical bob, at twice the step rate (a footfall every half cycle)
    this.model.position.y += Math.abs(w2) * 0.05 * gait;

    // ---- arms: swing opposite to the legs on the same side ----
    if (limbs?.armL) {
      // The pivot carries the rest pose, so add to it rather than overwrite.
      const swing = this.state === 'windup' ? -1.5 : 0;
      limbs.armL.rotation.x = -0.3 + w * 0.7 * gait + swing;
      limbs.armR.rotation.x = -0.3 - w * 0.7 * gait + swing;
    }

    // ---- legs: real hip swing ----
    // Left and right are half a cycle apart, so a planted foot stays put while
    // the other passes under the body.
    if (limbs?.legs) {
      const amp = this.kind === 'brute' ? 0.42 : this.kind === 'spitter' ? 0.22 : 0.55;
      const dir = this.kind === 'spitter' ? 0.66 : 1;   // 3 legs => 120 deg apart
      for (let i = 0; i < limbs.legs.length; i++) {
        const ph = this.walkPhase + (i * Math.PI * 2) * dir / limbs.legs.length;
        limbs.legs[i].rotation.x = Math.sin(ph) * amp * gait;
      }
    }

    // ---- hip counter-rotation: sells the weight shift ----
    if (limbs?.hips) {
      const hipAmt = this.kind === 'brute' ? 0.05 : 0.03;
      limbs.hips.rotation.y = w * hipAmt * gait;
      // Grunt keeps a forward hunch; it should not flatten out when walking.
      if (this.kind === 'grunt') limbs.hips.rotation.x = 0.06;
    }

    if (this.kind === 'brute') {
      this.model.rotation.z = w * 0.04;
    }
    if (this.kind === 'stalker') {
      this.model.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.14;
      this.model.position.y += 0.08 + Math.sin(this.walkPhase * 2) * 0.05;
    }

    // Windup tell: scale punch; hurt flash: emissive flare.
    const baseScale = this.model.userData.baseScale ?? (this.def.height / 1.85);
    if (this.state === 'windup') {
      const k = clamp(this.stateT / 0.32, 0, 1);
      this.model.scale.setScalar(baseScale * (1 + k * 0.14));
    } else {
      this.model.scale.setScalar(damp(this.model.scale.x, baseScale, 8, dt));
    }

    // Hurt flash: boost emissive, then ease back to each material's own
    // resting value (stored at build time).
    const flashing = this.hurtFlash > 0;
    this.model.traverse((o) => {
      if (!o.isMesh || !o.material?.emissive) return;
      const rest = o.material.userData.baseEmissive ?? 1.0;
      o.material.emissiveIntensity = flashing
        ? rest + 4.0
        : damp(o.material.emissiveIntensity, rest, 6, dt);
    });

    // Emissive light
    if (this.light) {
      this.light.position.set(
        this.position.x,
        this.position.y + this.def.height * 0.6,
        this.position.z
      );
      const base = this.kind === 'brute' ? 0.9 : 0.5;
      this.light.intensity = damp(
        this.light.intensity,
        base + (this.state === 'windup' ? 1.4 : 0),
        5, dt
      );
    }

    // Spitter maw brightens while winding up a shot
    const maw = this.model.userData.maw;
    if (maw) {
      const k = this.state === 'windup' ? clamp(this.stateT / 0.8, 0, 1) : 0;
      maw.material.emissiveIntensity = damp(
        maw.material.emissiveIntensity,
        1.5 + k * 7,
        8, dt
      );
      maw.scale.setScalar(1 + k * 0.5);
    }
  }
}

function def_radius(def) { return def.radius; }

/* ------------------------------------------------------------------
 * Manager
 * ------------------------------------------------------------------ */
export class EnemyManager {
  constructor(scene, world, player, audio, effects, projectiles, lightPool) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.audio = audio;
    this.fx = effects;
    this.projectiles = projectiles || null;
    this.lightPool = lightPool;
    /** @type {Enemy[]} */
    this.enemies = [];
    this.killCount = 0;
    this.wave = 1;
  }

  spawn(kind) {
    const p = this.player.position;
    const spot = this.world.pickSpawn(p.x, p.z, 24);
    // Jitter so multiple spawns don't stack
    const jx = spot.x + rand(-1.5, 1.5);
    const jz = spot.z + rand(-1.5, 1.5);

    const e = new Enemy(
      kind, this.scene, this.world, this.player, this.audio, this.fx,
      this.lightPool
    );
    e.onDeath = (en) => this._handleDeath(en);
    e.onShoot = (en) => this._handleShoot(en);

    // Play a portal effect first so the player sees where it is coming from.
    // The enemy is hidden and invulnerable until the portal finishes.
    const cfg = E[kind];
    this.fx.spawnPortal(jx, jz, cfg.emissive, 0.7);
    e.pendingSpawn = { x: jx, z: jz, wave: this.wave, t: 0.7 };
    e.model.visible = false;
    e.hitGroup.visible = false;
    e.position.set(jx, 0, jz);

    this.enemies.push(e);
    return e;
  }

  /** Ranged enemies call this when they fire. */
  _handleShoot(e) {
    if (!this.projectiles) return;
    const def = e.def;
    const pdef = def.ranged
      ? def.projectile
      : {
          // Brute shockwave: slow, heavy, larger
          speed: 22, damage: def.damage * e.damageScale, radius: 0.55,
          color: def.emissive, gravity: -4, life: 3.5,
        };

    const origin = new THREE.Vector3(
      e.position.x,
      e.position.y + e.def.height * 0.7,
      e.position.z
    );

    // Lead the target so shots are not trivially dodged by standing still
    const dir = def.ranged
      ? ProjectileManager.leadShot(origin, this.player, pdef.speed)
      : new THREE.Vector3(
          this.player.position.x - origin.x, 0,
          this.player.position.z - origin.z
        ).normalize();

    // Ranged units get a little aim jitter; brutes fire straight
    if (def.ranged) {
      dir.x += rand(-0.03, 0.03);
      dir.y += rand(-0.02, 0.02);
      dir.z += rand(-0.03, 0.03);
      dir.normalize();
    }

    this.projectiles.spawn(origin, dir, pdef, {
      scale: def.ranged ? 1 : 1.6,
      color: pdef.color,
    });
  }

  _handleDeath(e) {
    this.killCount++;
    this.onKill?.(e);
  }

  update(dt) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const done = e.update(dt, this.enemies);
      if (done) {
        e.dispose();
        this.enemies.splice(i, 1);
      }
    }
  }

  get aliveCount() {
    let n = 0;
    // Enemies still materialising count as alive: otherwise a wave would
    // look "cleared" during the spawn animation and advance early.
    for (const e of this.enemies) if (!e.dead) n++;
    return n;
  }

  /** Set the current wave so newly spawned enemies scale correctly. */
  setWave(w) { this.wave = w; }

  clear() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.killCount = 0;
    this.projectiles?.clear();
  }
}

export { buildModel, E as ENEMY_TYPES };
