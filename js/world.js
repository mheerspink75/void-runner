/**
 * world.js — Arena construction: floor, walls, cover, lighting, colliders.
 *
 * The world exposes:
 *   - .group       THREE.Group with all static geometry
 *   - .colliders   array of AABB boxes {minX,minY,minZ,maxX,maxY,maxZ} used for
 *                  player and enemy collision resolution
 *   - .spawnPoints array of {x,z} safe spawn locations
 *   - .raycastables array of meshes added to the raycaster target list
 *   - .update(t)   animated bits (flickering lights, energy core pulse)
 */

import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './config.js';
import { rand, pick, randInt, clamp } from './utils.js';
import { floorMaps, wallMaps, crateMaps, pillarMaps, glowSprite } from './textures.js';

const HALF = CONFIG.world.halfSize;
const WALL_H = CONFIG.world.wallHeight;

/* ---------- dynamic light budget ---------- */
/**
 * Upper bound on pickups alive at once. Pickups expire on a timer, so live
 * count is normally small, but a big wave killing at once can stack drops.
 * Slightly above the observed worst case.
 */
const MAX_PICKUPS = 12;

/**
 * Spare slots for short-lived combat lights (muzzle flashes, impact pops,
 * spawn portals, explosion flashes). These overlap briefly, so a handful is
 * enough. Requests beyond the pool are dropped rather than allowed to grow the
 * scene's light count.
 */
const EFFECT_LIGHT_HEADROOM = 8;

/* ---------- shared materials (created once, reused) ---------- */
function mats() {
  const fl = floorMaps();
  const wl = wallMaps();
  const cr = crateMaps();
  const pi = pillarMaps();

  return {
    floor: new THREE.MeshStandardMaterial({
      color: 0x6d8ea6,
      map: fl.map,
      roughnessMap: fl.roughnessMap,
      normalMap: fl.normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.72, metalness: 0.55,
      // A wet-looking clearcoat. The arena is a sealed facility with
      // constantly venting atmosphere, so a polished floor that catches the
      // env map is both plausible and what stops the large floor plane from
      // reading as flat matte paper from standing height.
      envMapIntensity: 1.35,
    }),
    floorTrim: new THREE.MeshStandardMaterial({
      color: 0x1d5566, emissive: 0x00b8cc, emissiveIntensity: 0.5,
      roughness: 0.3, metalness: 0.4,
    }),
    wall: new THREE.MeshStandardMaterial({
      color: 0x5f7d95,
      map: wl.map,
      normalMap: wl.normalMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.6, metalness: 0.5,
      envMapIntensity: 0.9,
    }),
    wallTrim: new THREE.MeshStandardMaterial({
      color: 0x1d5566, emissive: 0x00b8cc, emissiveIntensity: 0.6,
      roughness: 0.25, metalness: 0.5,
    }),
    pillar: new THREE.MeshStandardMaterial({
      color: 0x7794ab,
      map: pi.map,
      normalMap: pi.normalMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.45, metalness: 0.75,
      // Metal reads almost entirely from the environment; without a strong
      // env map intensity the pillars go near-black in this scene.
      envMapIntensity: 1.5,
    }),
    crate: new THREE.MeshStandardMaterial({
      color: 0xbfab86,
      map: cr.map,
      normalMap: cr.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.8, metalness: 0.1,
      envMapIntensity: 0.8,
    }),
    crateTrim: new THREE.MeshStandardMaterial({
      color: 0x0a3a44, emissive: 0x00e5ff, emissiveIntensity: 0.8,
    }),
    core: new THREE.MeshStandardMaterial({
      color: 0x0a2a33, emissive: 0x00c8e0, emissiveIntensity: 0.8,
      roughness: 0.15, metalness: 0.3,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x7fd8ff, transparent: true, opacity: 0.18,
      roughness: 0.05, metalness: 0.0, transmission: 0.0,
      side: THREE.DoubleSide,
      // Real transmission is far too expensive to run per-frame here, but a
      // clearcoat + high env intensity fakes the wet-glass specular that makes
      // the core read as a containment field rather than tinted plastic.
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      envMapIntensity: 2.0,
    }),
  };
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'world';
    scene.add(this.group);

    /** @type {Array<{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number,tag:string}>} */
    this.colliders = [];
    // Tag-partitioned views of `colliders`, filled in by `_indexColliders()`.
    // Declared up front (empty) so any query that runs mid-build sees a valid
    // empty list instead of `undefined` and throws.
    /** @type {typeof this.colliders} */
    this.losColliders = [];
    /** @type {typeof this.colliders} */
    this.solidColliders = [];
    /** @type {typeof this.colliders} */
    this.walkableColliders = [];
    /** @type {THREE.Mesh[]} */
    this.raycastables = [];
    /** @type {Array<{x:number,z:number}>} */
    this.spawnPoints = [];
    this.flickers = [];
    this.animated = [];
    this.time = 0;
    /** Position the skybox follows (the camera). */
    this.followTarget = null;

    this.mats = mats();
    // Enough blobs for a full wave of enemies plus every live pickup; unused
    // slots are simply hidden, so over-allocating is free.
    this._buildContactShadows(34);
    this._build();
    // Concurrent transient lights the shared pool must cover. Sized from the
    // config so it stays correct if the wave/pickup limits change: one light
    // per live enemy, one per live pickup, plus headroom for simultaneous
    // combat effects (muzzle flash, impacts, portals, explosions).
    this.dynamicLightBudget =
      CONFIG.waves.maxAlive + MAX_PICKUPS + EFFECT_LIGHT_HEADROOM;
  }

  /**
   * Build tag-partitioned views of `colliders`. The arena is completely
   * static after `_build()`, so this only needs to run once.
   */
  _indexColliders() {
    /** Boxes that can block a sight line: everything except platforms. */
    this.losColliders = this.colliders.filter((c) => c.tag !== 'platform');
    /** Boxes that can block movement: everything you cannot walk under. */
    this.solidColliders = this.colliders.filter((c) => c.minY <= 1.2);
    /** Boxes you can stand on: excludes walls and towers. */
    this.walkableColliders = this.colliders.filter(
      (c) => c.tag !== 'wall' && c.tag !== 'tower'
    );
  }

  // ==================================================================
  // Construction
  // ==================================================================
  _build() {
    this._buildSky();
    this._buildFloor();
    this._buildWalls();
    this._buildCover();
    this._buildStructures();
    this._buildLights();
    // Partition the collider list by tag once the geometry exists. The hot
    // paths (line of sight, player collision, ground height) all care about a
    // different subset, and each is called many times per frame, so scanning
    // only the relevant subset instead of every box in the arena is a
    // straightforward win with no behavioural change.
    //
    // This MUST run before `_buildSpawnPoints()`, which calls `isBlocked()`
    // and therefore reads `solidColliders` — indexing after `_build()`
    // returned meant that list was still `undefined`.
    this._indexColliders();
    this._buildSpawnPoints();
  }

  /**
   * Inverted sphere with a vertical gradient. Gives the arena a real sense of
   * enclosure and a horizon instead of flat fog colour.
   */
  _buildSky() {
    const geo = new THREE.SphereGeometry(400, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop:     { value: new THREE.Color(0x050a14) },
        uMid:     { value: new THREE.Color(0x123049) },
        uHorizon: { value: new THREE.Color(0x1d5f7a) },
        uBottom:  { value: new THREE.Color(0x060c14) },
        uTime:    { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec3 uTop, uMid, uHorizon, uBottom;
        uniform float uTime;
        varying vec3 vPos;

        // Cheap hash for subtle star/speckle field
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        void main() {
          vec3 dir = normalize(vPos);
          float h = dir.y * 0.5 + 0.5;

          vec3 col = mix(uBottom, uHorizon, smoothstep(0.28, 0.5, h));
          col = mix(col, uMid, smoothstep(0.5, 0.66, h));
          col = mix(col, uTop, smoothstep(0.66, 1.0, h));

          // Faint speckle so the upper sky is not a dead gradient
          float sp = hash(floor(dir * 260.0));
          col += step(0.9975, sp) * 0.9 * smoothstep(0.5, 0.9, h);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  _buildFloor() {
    // Main slab
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF * 2, HALF * 2),
      this.mats.floor
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.group.add(floor);
    this.raycastables.push(floor);

    // Glowing grid lines — built as thin boxes, merged for perf.
    const lineGeo = new THREE.BoxGeometry(HALF * 2, 0.02, 0.06);
    const lines = [];
    for (let i = -HALF + 8; i < HALF; i += 8) {
      const a = new THREE.Matrix4().makeTranslation(0, 0.02, i);
      lines.push(new THREE.Mesh(lineGeo, this.mats.floorTrim));
      lines[lines.length - 1].matrixAutoUpdate = false;
      lines[lines.length - 1].matrix.copy(a);
      const b = new THREE.Matrix4().makeTranslation(i, 0.02, 0).multiply(
        new THREE.Matrix4().makeRotationY(Math.PI / 2)
      );
      lines.push(new THREE.Mesh(lineGeo, this.mats.floorTrim));
      lines[lines.length - 1].matrixAutoUpdate = false;
      lines[lines.length - 1].matrix.copy(b);
    }
    lines.forEach((l) => { l.matrixWorldNeedsUpdate = true; this.group.add(l); });

    // Central raised platform with a glowing core
    const plat = new THREE.Mesh(
      new THREE.CylinderGeometry(7, 7.6, 0.8, 8),
      this.mats.pillar
    );
    plat.position.y = 0.4;
    plat.receiveShadow = true;
    this.group.add(plat);
    this.raycastables.push(plat);
    this.colliders.push({
      minX: -7, maxX: 7, minY: 0, maxY: 0.8, minZ: -7, maxZ: 7, tag: 'platform',
    });

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.5, 1),
      this.mats.core
    );
    core.position.y = 3.2;
    this.group.add(core);
    this.animated.push({ obj: core, kind: 'core', base: 3.2 });

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(2.4, 0.09, 8, 40),
      this.mats.crateTrim
    );
    halo.position.y = 3.2;
    halo.rotation.x = Math.PI / 2.6;
    this.group.add(halo);
    this.animated.push({ obj: halo, kind: 'halo', base: 3.2 });

    const beacon = new THREE.PointLight(0x00e5ff, 3.2, 40, 2);
    beacon.position.set(0, 4, 0);
    this.group.add(beacon);
    this.animated.push({ obj: beacon, kind: 'beacon', base: 4 });
  }

  _buildWalls() {
    const t = 2.5;
    const seg = 24;
    const geo = new THREE.BoxGeometry(seg, WALL_H, t);
    const wallMat = this.mats.wall;

    const addWall = (x, z, ry, len) => {
      const count = Math.ceil(len / seg);
      for (let i = 0; i < count; i++) {
        const off = (i - (count - 1) / 2) * seg;
        const m = new THREE.Mesh(geo, wallMat);
        m.position.set(x + Math.cos(ry) * off, WALL_H / 2, z - Math.sin(ry) * off);
        m.rotation.y = ry;
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        this.raycastables.push(m);
      }
      // One collider per wall
      const hx = Math.abs(Math.cos(ry)) * len / 2 + t / 2;
      const hz = Math.abs(Math.sin(ry)) * len / 2 + t / 2;
      this.colliders.push({
        minX: x - hx, maxX: x + hx, minY: 0, maxY: WALL_H,
        minZ: z - hz, maxZ: z + hz, tag: 'wall',
      });
    };

    addWall(0, -HALF - t / 2, 0, HALF * 2 + t * 2);
    addWall(0, HALF + t / 2, 0, HALF * 2 + t * 2);
    addWall(-HALF - t / 2, 0, Math.PI / 2, HALF * 2 + t * 2);
    addWall(HALF + t / 2, 0, Math.PI / 2, HALF * 2 + t * 2);

    // Emissive trim band around the top of the walls
    const trimMat = this.mats.wallTrim;
    const band = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.28, d), trimMat);
      m.position.set(x, WALL_H - 0.5, z);
      this.group.add(m);
    };
    band(HALF * 2 + t * 2, t + 0.3, 0, -HALF - t / 2);
    band(HALF * 2 + t * 2, t + 0.3, 0, HALF + t / 2);
    band(t + 0.3, HALF * 2 + t * 2, -HALF - t / 2, 0);
    band(t + 0.3, HALF * 2 + t * 2, HALF + t / 2, 0);
  }

  _buildCover() {
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);

    /** Place an axis-aligned box obstacle with a matching collider. */
    const obstacle = (x, y, z, sx, sy, sz, mat, ry = 0) => {
      const m = new THREE.Mesh(boxGeo, mat);
      m.scale.set(sx, sy, sz);
      m.position.set(x, y + sy / 2, z);
      m.rotation.y = ry;
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      this.raycastables.push(m);

      if (Math.abs(ry) < 0.01) {
        this.colliders.push({
          minX: x - sx / 2, maxX: x + sx / 2,
          minY: y, maxY: y + sy,
          minZ: z - sz / 2, maxZ: z + sz / 2,
          tag: 'cover',
        });
      } else {
        // Rotated boxes: use the bounding radius as a conservative AABB.
        const r = Math.hypot(sx, sz) / 2;
        this.colliders.push({
          minX: x - r, maxX: x + r,
          minY: y, maxY: y + sy,
          minZ: z - r, maxZ: z + r,
          tag: 'cover',
        });
      }
      return m;
    };

    // --- Crates (stacked clusters) ---
    const crateSpots = [
      [-22, -14], [-18, -20], [16, -24], [24, -10],
      [28, 18], [12, 26], [-10, 28], [-26, 20],
      [-34, 2], [34, -2], [0, -34], [-2, 34],
    ];
    for (const [cx, cz] of crateSpots) {
      const n = randInt(1, 3);
      for (let i = 0; i < n; i++) {
        const s = rand(1.6, 2.6);
        const ox = cx + rand(-1.8, 1.8);
        const oz = cz + rand(-1.8, 1.8);
        const stack = i === 0 ? 0 : randInt(0, 1);
        const m = obstacle(ox, stack * s, oz, s, s, s, this.mats.crate, rand(0, Math.PI));
        // Glowing edge on one crate per cluster
        if (i === 0) {
          const edge = new THREE.Mesh(
            new THREE.BoxGeometry(s * 1.02, 0.1, s * 1.02),
            this.mats.crateTrim
          );
          edge.position.set(ox, stack * s + s * 0.78, oz);
          edge.rotation.y = m.rotation.y;
          this.group.add(edge);
        }
      }
    }

    // --- Low walls / barriers for line-of-sight breaks ---
    const barrierMat = this.mats.pillar;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + rand(-0.2, 0.2);
      const r = rand(18, 40);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const ry = rand(0, Math.PI);
      const w = rand(5, 11);
      obstacle(x, 0, z, w, rand(1.1, 1.7), 0.8, barrierMat, ry);
    }

    // --- Tall pillars in a ring ---
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const r = 32;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = rand(4, 7);
      obstacle(x, 0, z, 2.2, h, 2.2, this.mats.pillar);
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, 0.22, 2.5),
        this.mats.wallTrim
      );
      cap.position.set(x, h + 0.1, z);
      this.group.add(cap);
    }
  }

  _buildStructures() {
    // Ceiling-less, but add tall corner "beacons" with point lights
    const corners = [[-HALF + 6, -HALF + 6], [HALF - 6, -HALF + 6],
                     [-HALF + 6, HALF - 6], [HALF - 6, HALF - 6]];
    for (const [x, z] of corners) {
      const tower = new THREE.Mesh(
        new THREE.CylinderGeometry(1.1, 1.6, 11, 6),
        this.mats.pillar
      );
      tower.position.set(x, 5.5, z);
      tower.castShadow = true;
      this.group.add(tower);
      this.raycastables.push(tower);
      this.colliders.push({
        minX: x - 1.3, maxX: x + 1.3, minY: 0, maxY: 11,
        minZ: z - 1.3, maxZ: z + 1.3, tag: 'tower',
      });

      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 12, 10),
        this.mats.core
      );
      lamp.position.set(x, 11.2, z);
      this.group.add(lamp);
      this.flickers.push({ obj: lamp, phase: rand(0, 10), rate: rand(0.4, 1.1), base: 2.4 });

      // Light shaft: a soft cone under each beacon. Cheap fake volumetrics —
      // additive, depth-write off, no raymarching.
      const shaftMat = new THREE.MeshBasicMaterial({
        color: 0x7fe8ff,
        transparent: true,
        opacity: 0.055,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 3.4, 11, 14, 1, true),
        shaftMat
      );
      shaft.position.set(x, 5.6, z);
      shaft.renderOrder = 2;
      this.group.add(shaft);
      this.shafts = this.shafts || [];
      this.shafts.push({ mesh: shaft, mat: shaftMat, base: 0.055, phase: rand(0, 10) });
    }

    // Distant skyline for depth (visual only, outside the arena).
    // Emissive window strips give the horizon life and feed the bloom.
    const skyMat = new THREE.MeshStandardMaterial({
      color: 0x0e1a26, roughness: 0.95, metalness: 0.1,
    });
    const winMat = new THREE.MeshBasicMaterial({ color: 0x4fd8ff, fog: true });
    const winMatWarm = new THREE.MeshBasicMaterial({ color: 0xffb46a, fog: true });

    const winGeo = new THREE.PlaneGeometry(0.9, 0.55);
    for (let i = 0; i < 64; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(HALF + 20, HALF + 95);
      const h = rand(14, 70);
      const w = rand(7, 20);
      const d = rand(7, 20);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;

      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), skyMat);
      b.position.set(x, h / 2, z);
      b.rotation.y = rand(0, Math.PI);
      this.group.add(b);

      // Window strips facing the arena
      const face = Math.atan2(-x, -z);
      const rows = Math.max(2, Math.floor(h / 9));
      for (let rI = 1; rI < rows; rI++) {
        if (Math.random() > 0.72) continue;
        const strip = new THREE.Mesh(
          winGeo,
          Math.random() < 0.25 ? winMatWarm : winMat
        );
        strip.position.set(
          x + Math.sin(face) * (d / 2 + 0.1),
          rI * (h / rows),
          z + Math.cos(face) * (d / 2 + 0.1)
        );
        strip.rotation.y = face;
        strip.scale.x = (w / 0.9) * rand(0.5, 0.95);
        this.group.add(strip);
      }
    }

    // Fog tuned to match the skybox horizon so geometry fades seamlessly.
    // Density matters more than colour here: at 0.0092 a silhouette at the far
    // wall is still readable, while the 120u skyline is fully dissolved.
    this.scene.fog = new THREE.FogExp2(0x14384d, 0.0092);
  }

  _buildLights() {
    // Ambient + hemisphere give the base readable level everywhere.
    this.scene.add(new THREE.HemisphereLight(0x7fc8e8, 0x1e2c3a, 1.15));
    this.scene.add(new THREE.AmbientLight(0x4a6c86, 0.4));

    // Key light: cool, casts the only shadow map.
    const key = new THREE.DirectionalLight(0xcfe8ff, 2.4);
    key.position.set(45, 70, -35);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 72;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 220;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    // Warm rim from the opposite side to separate silhouettes.
    const rim = new THREE.DirectionalLight(0xff9a6a, 0.55);
    rim.position.set(-50, 25, 45);
    this.scene.add(rim);

    // Coloured accent pools — these are what bloom will pick up.
    const fills = [
      [0x00e5ff, 22, -32, 1.7, 9],
      [0xff2d55, -32, 22, 1.3, 9],
      [0x7a5cff, 32, 32, 1.2, 9],
      [0x39ff88, -22, -36, 1.1, 9],
    ];
    for (const [col, x, z, inten, y] of fills) {
      const l = new THREE.PointLight(col, inten, 62, 2);
      l.position.set(x, y, z);
      this.scene.add(l);
      this.flickers.push({
        obj: l, phase: rand(0, 10), rate: rand(0.12, 0.4),
        base: inten, isLight: true,
      });
    }

    // Even coverage ring so no corner goes pitch black.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const l = new THREE.PointLight(0x9fd4f0, 0.75, 50, 2);
      l.position.set(Math.cos(a) * 40, 12, Math.sin(a) * 40);
      this.scene.add(l);
    }
  }

  _buildSpawnPoints() {
    // Points around the arena, away from the very center (player spawn).
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 16 + (i % 4) * 9;
      const x = clamp(Math.cos(a) * r, -HALF + 4, HALF - 4);
      const z = clamp(Math.sin(a) * r, -HALF + 4, HALF - 4);
      if (this.isBlocked(x, z, 2.0)) continue;
      this.spawnPoints.push({ x, z });
    }
  }

  // ==================================================================
  // Collision queries
  // ==================================================================

  /**
   * True if a vertical cylinder at (x,z) with `radius` overlaps any collider
   * between yMin and yMax.
   */
  isBlocked(x, z, radius, yMin = 0, yMax = 3) {
    for (const c of this.solidColliders) {
      if (c.maxY < yMin || c.minY > yMax) continue;
      const cx = clamp(x, c.minX, c.maxX);
      const cz = clamp(z, c.minZ, c.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  /**
   * Highest walkable surface at (x,z) at or below `fromY`.
   * Returns 0 for the open arena floor, or the top of a cover box/platform.
   */
  groundHeight(x, z, fromY = 40) {
    let best = 0;   // the arena floor is always solid at y = 0
    for (const c of this.walkableColliders) {
      if (c.maxY > fromY + 0.001) continue;
      const cx = clamp(x, c.minX, c.maxX);
      const cz = clamp(z, c.minZ, c.maxZ);
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz > 1e-6) continue;
      if (c.maxY > best) best = c.maxY;
    }
    return best;
  }

  /**
   * Resolve a circle-vs-world collision. Mutates `pos` (Vector3-like) and
   * returns true if a wall was hit.
   *
   * Ground contact is handled explicitly (the arena floor is a plane, not a
   * box, so it is not in `colliders`).
   */
  resolve(pos, radius, height) {
    let hitWall = false;

    const footY = pos.y;
    const headY = pos.y + height;

    // ---- arena floor ----
    if (pos.y <= 0) {
      pos.y = 0;
      pos.onGround = true;
    } else {
      // Cover/platform tops. Only snaps when the feet are at or just below the
      // surface, so jumping upward through a box never teleports the body.
      const gy = this.groundHeight(pos.x, pos.z, pos.y + 0.05);
      if (pos.y <= gy + 0.02) {
        pos.y = gy;
        pos.onGround = true;
        pos.groundTag = 'cover';
      }
    }

    for (const c of this.colliders) {
      // Skip anything entirely below the feet (steppable) or above the head.
      if (c.maxY <= footY + 0.001) continue;
      if (c.minY >= headY) continue;

      const cx = clamp(pos.x, c.minX, c.maxX);
      const cz = clamp(pos.z, c.minZ, c.maxZ);
      let dx = pos.x - cx;
      let dz = pos.z - cz;
      let d2 = dx * dx + dz * dz;

      if (d2 >= radius * radius) continue;

      // Standing on top of this box?
      const top = c.maxY;
      if (footY >= top - 0.02 && pos.vy <= 0) {
        pos.y = top;
        pos.onGround = true;
        pos.groundTag = c.tag;
        continue;
      }

      // Head bonk -- only for a genuine overhead obstruction.
      // `c.minY > footY` is load-bearing. Without it this also fires for any
      // box resting on the floor: `c.minY - footY` is then 0, which is
      // trivially < height, so brushing against a crate while jumping set
      // pos.y = c.minY - height - 0.001 (i.e. below the floor) and zeroed vy,
      // killing the jump outright. It also made an unfittable gap between two
      // colliders a soft-lock, because hopping the low obstacle was the only
      // way out. The remaining terms bound the underside to head height.
      if (c.minY > footY + 0.02 && pos.vy > 0 && c.minY - footY < height) {
        pos.y = c.minY - height - 0.001;
        pos.vy = 0;
      }

      if (d2 < 1e-8) {
        // Center is inside the box: push out along the shallowest axis.
        const toL = pos.x - c.minX, toR = c.maxX - pos.x;
        const toB = pos.z - c.minZ, toT = c.maxZ - pos.z;
        const m = Math.min(toL, toR, toB, toT);
        if (m === toL) pos.x = c.minX - radius;
        else if (m === toR) pos.x = c.maxX + radius;
        else if (m === toB) pos.z = c.minZ - radius;
        else pos.z = c.maxZ + radius;
        hitWall = true;
        continue;
      }

      const d = Math.sqrt(d2);
      const push = radius - d;
      dx /= d; dz /= d;
      pos.x += dx * push;
      pos.z += dz * push;
      hitWall = true;
    }

    // Arena bounds
    const lim = HALF - radius;
    if (pos.x < -lim) { pos.x = -lim; hitWall = true; }
    if (pos.x > lim) { pos.x = lim; hitWall = true; }
    if (pos.z < -lim) { pos.z = -lim; hitWall = true; }
    if (pos.z > lim) { pos.z = lim; hitWall = true; }

    return hitWall;
  }

  /**
   * Ray/AABB test used for cover-aware AI line of sight.
   *
   * Hot path: called once per enemy per frame, so up to `maxAlive` (18) times
   * at 60fps. The obvious implementation builds a nested array of
   * `[o, d, min, max]` tuples for every collider on every call, which is
   * several thousand short-lived arrays per second and shows up as GC
   * stutter. The slab test is unrolled across x/y/z into scalars instead,
   * which removes the allocation entirely and is measurably faster.
   */
  rayBlocked(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const colliders = this.losColliders;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];

      let t0 = 0, t1 = 1;

      // ---- X slab ----
      let ok = true;
      if (Math.abs(dx) < 1e-8) {
        if (ax < c.minX || ax > c.maxX) ok = false;
      } else {
        let n = (c.minX - ax) / dx;
        let f = (c.maxX - ax) / dx;
        if (n > f) { const t = n; n = f; f = t; }
        if (n > t0) t0 = n;
        if (f < t1) t1 = f;
        if (t0 > t1) ok = false;
      }

      // ---- Y slab ----
      if (ok) {
        if (Math.abs(dy) < 1e-8) {
          if (ay < c.minY || ay > c.maxY) ok = false;
        } else {
          let n = (c.minY - ay) / dy;
          let f = (c.maxY - ay) / dy;
          if (n > f) { const t = n; n = f; f = t; }
          if (n > t0) t0 = n;
          if (f < t1) t1 = f;
          if (t0 > t1) ok = false;
        }
      }

      // ---- Z slab ----
      if (ok) {
        if (Math.abs(dz) < 1e-8) {
          if (az < c.minZ || az > c.maxZ) ok = false;
        } else {
          let n = (c.minZ - az) / dz;
          let f = (c.maxZ - az) / dz;
          if (n > f) { const t = n; n = f; f = t; }
          if (n > t0) t0 = n;
          if (f < t1) t1 = f;
          if (t0 > t1) ok = false;
        }
      }

      if (ok && t0 < 0.97) return true;
    }
    return false;
  }

  /** Pick a spawn point that is far from the player and not blocked. */
  pickSpawn(playerX, playerZ, minDist = 22) {
    const candidates = this.spawnPoints.filter(
      (p) => Math.hypot(p.x - playerX, p.z - playerZ) > minDist
    );
    const pool = candidates.length ? candidates : this.spawnPoints;
    if (!pool.length) return { x: 0, z: 30 };
    return pick(pool);
  }

  // ==================================================================
  // Animation
  // ==================================================================
  // ==================================================================
  // Contact shadows
  // ==================================================================
  /**
   * Soft blob shadows under characters and pickups.
   *
   * The arena has exactly one shadow-casting light (the key directional), and
   * a 72-unit shadow camera fitted to the whole arena gives ~1.4 units per
   * texel — far too coarse to ground a character, so enemies otherwise look
   * like they are hovering. These are camera-facing dark discs that fade and
   * shrink with height above the surface, which is the standard cheap fix and
   * costs one draw call per caster.
   *
   * They are additive-negative (multiply-ish) quads on the floor, so they
   * must render after the floor and never write depth.
   */
  _buildContactShadows(count) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    // Radial falloff: opaque at the centre, transparent at the rim. A hard
    // edged disc looks like a sticker; this is what sells it as a shadow.
    const tex = (() => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const ctx = cv.getContext('2d');
      const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(0,0,0,0.85)');
      grad.addColorStop(0.45, 'rgba(0,0,0,0.5)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();

    this._shadowGeo = geo;
    this._shadowTex = tex;
    /** @type {THREE.Mesh[]} */
    this.contactShadows = [];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // Multiply blending darkens the floor instead of painting grey over
        // it, so the shadow takes on the floor's own colour and grid lines
        // show through it.
        blending: THREE.CustomBlending,
        blendSrc: THREE.DstColorFactor,
        blendDst: THREE.ZeroFactor,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 1;
      m.frustumCulled = false;
      this.group.add(m);
      this.contactShadows.push(m);
    }
  }

  /**
   * Place `n` contact shadows. `get(i)` must return
   * `{x, y, z, radius, strength}` or null for an unused slot.
   */
  updateContactShadows(get) {
    const pool = this.contactShadows;
    for (let i = 0; i < pool.length; i++) {
      const m = pool[i];
      const c = get(i);
      if (!c) { m.visible = false; continue; }
      // Fade out and shrink with height: a shadow directly beneath a body is
      // tight and dark, one cast from a jump is wide and faint.
      const lift = clamp(c.y, 0, 3.2);
      const fade = clamp(1 - lift / 3.2, 0, 1);
      m.visible = fade > 0.02;
      if (!m.visible) continue;
      const ground = this.groundHeight(c.x, c.z, c.y + 0.4);
      m.position.set(c.x, ground + 0.02, c.z);
      const s = c.radius * (1 + lift * 0.32);
      m.scale.set(s, 1, s);
      m.material.opacity = fade * c.strength;
    }
  }

  update(dt, elapsed) {
    this.time = elapsed;

    if (this.sky) this.sky.material.uniforms.uTime.value = elapsed;
    // Keep the sky centred on the camera so it never clips.
    if (this.sky && this.followTarget) this.sky.position.copy(this.followTarget);

    for (const a of this.animated) {
      if (a.kind === 'core') {
        a.obj.rotation.y += dt * 0.5;
        a.obj.rotation.x += dt * 0.22;
        const s = 1 + Math.sin(elapsed * 2.1) * 0.07;
        a.obj.scale.setScalar(s);
        a.obj.position.y = a.base + Math.sin(elapsed * 1.3) * 0.22;
        a.obj.material.emissiveIntensity = 0.8 + Math.sin(elapsed * 3) * 0.22;
      } else if (a.kind === 'halo') {
        a.obj.rotation.z += dt * 0.9;
        a.obj.position.y = a.base + Math.sin(elapsed * 1.3 + 1) * 0.22;
      } else if (a.kind === 'beacon') {
        a.obj.intensity = 1.6 + Math.sin(elapsed * 2.4) * 0.5;
      }
    }

    for (const f of this.flickers) {
      const n = Math.sin(elapsed * f.rate * 6.283 + f.phase) * 0.5 + 0.5;
      // Mostly steady with occasional dips
      const dip = n > 0.86 ? rand(0.35, 0.75) : 1;
      const v = f.base * (0.85 + n * 0.2) * dip;
      if (f.isLight) f.obj.intensity = v;
      else f.obj.material.emissiveIntensity = f.base * dip;
    }

    // Light shafts breathe gently and stay in sync with the beacon flicker
    if (this.shafts) {
      for (const s of this.shafts) {
        const n = Math.sin(elapsed * 1.3 + s.phase) * 0.5 + 0.5;
        s.mat.opacity = s.base * (0.6 + n * 0.8);
      }
    }
  }
}
