/**
 * effects.js — Pooled visual effects: tracers, impact sparks, blood,
 * decals, explosions, damage popups (screen space) and floating text.
 *
 * Everything is pooled to avoid per-shot allocations / GC hitches.
 */

import * as THREE from '../vendor/three.module.js';
import { rand, clamp, pulse } from './utils.js';
import { glowSprite, sparkSprite, splatSprite, holeSprite } from './textures.js';

export class Effects {
  constructor(scene, camera, lightPool) {
    this.scene = scene;
    this.camera = camera;
    // Transient lights come from a fixed pool. Adding/removing real
    // PointLights changes the scene's light count, which forces three.js to
    // recompile every lit shader (~200ms hitch). See lightpool.js.
    this.lightPool = lightPool;

    this.tracers = [];
    this.sparks = [];
    this.bloods = [];
    this.decals = [];
    this.explosions = [];
    this.blobs = [];       // gibs / debris
    this.popups = [];      // screen-space damage numbers
    this.flashes = [];     // billboarded glow sprites

    this._popupLayer = document.getElementById('popups');
    this._v = new THREE.Vector3();
    /** Blood colour, set per enemy so each species leaves its own ichor. */
    this._ichor = 0x8bff5a;
  }

  /** Called before a kill so the blood matches the species. */
  setIchor(color) { this._ichor = color; }

  // ==================================================================
  // Tracer beams (hitscan feedback)
  // ==================================================================
  _tracerGeo() {
    if (!this._tg) {
      // Unit-length quad along +X, pivoted at start
      const g = new THREE.PlaneGeometry(1, 1);
      g.translate(0.5, 0, 0);
      this._tg = g;
    }
    return this._tg;
  }

  /**
   * Draw a beam from `from` to `to`.
   * @param {THREE.Vector3|Object} from
   * @param {THREE.Vector3|Object} to
   */
  tracer(from, to, color = 0x7ff4ff, width = 0.035, life = 0.07) {
    const a = this._v.set(from.x, from.y, from.z);
    const dx = to.x - a.x, dy = to.y - a.y, dz = to.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return;

    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(this._tracerGeo(), mat);
    m.position.copy(a);
    m.scale.set(len, width, 1);
    // Orient the quad so its +X axis points at the target and faces the camera.
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const up = Math.abs(dir.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const fwd = new THREE.Vector3().crossVectors(side, dir).normalize();
    m.matrixAutoUpdate = false;
    m.matrix.makeBasis(dir, side, fwd);
    m.matrix.setPosition(a);

    this.scene.add(m);
    this.tracers.push({ mesh: m, mat, life, maxLife: life });
  }

  // ==================================================================
  // Impact sparks (world surface hit)
  // ==================================================================
  impact(point, normal, color = 0x9ff8ff) {
    // Billboarded flash sprite at the contact point
    this.flash(point, color, 0.5, 0.09);

    const count = 9;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = [];
    for (let i = 0; i < count; i++) {
      pos[i * 3] = point.x;
      pos[i * 3 + 1] = point.y;
      pos[i * 3 + 2] = point.z;
      const spread = 3.0;
      vel.push(new THREE.Vector3(
        rand(-spread, spread),
        rand(-spread, spread) * 0.6 + 1.6,
        rand(-spread, spread)
      ).add(normal.clone().multiplyScalar(3.0)));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    const mat = new THREE.PointsMaterial({
      color, size: 0.14, map: sparkSprite(),
      transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    this.scene.add(pts);
    this.sparks.push({ pts, mat, vel, life: 0.4, maxLife: 0.4 });

    this._addLight(point, color, 3.0, 5, 0.12, this.sparks);
  }

  /**
   * Spawn portal: a ring + rising glow that plays just before an enemy
   * materialises. Without this, enemies simply pop into existence at the
   * screen edge, which reads as unfair rather than threatening.
   */
  spawnPortal(x, z, color = 0x00e5ff, life = 0.75) {
    const pos = new THREE.Vector3(x, 0.05, z);

    // Ground ring, expanding
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.62, 28), ringMat);
    ring.position.copy(pos);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    this.explosions.push({
      mesh: ring, mat: ringMat, kind: 'ring', life, maxLife: life, scale: 1.6,
    });

    // Vertical column
    const colMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.75, 3.2, 18, 1, true), colMat
    );
    col.position.set(x, 1.6, z);
    this.scene.add(col);
    this.explosions.push({
      mesh: col, mat: colMat, kind: 'column', life, maxLife: life, scale: 1,
    });

    this._addLight({ x, y: 1.4, z }, color, 3.2, 12, life, this.explosions, 0.5);
  }

  /**
   * Short-lived billboard. This is the single biggest contributor
   * to impacts reading as "hot" — a bare point light does not read on its own.
   */
  flash(point, color = 0x9ff8ff, size = 0.6, life = 0.1) {
    const mat = new THREE.SpriteMaterial({
      map: glowSprite('#ffffff'),
      color,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(point);
    s.scale.setScalar(size);
    this.scene.add(s);
    this.flashes.push({ mesh: s, mat, life, maxLife: life, size });
  }

  // ==================================================================
  // Blood spray (enemy hit)
  // ==================================================================
  blood(point, dir, amount = 1) {
    const count = Math.round(12 * amount);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = [];
    for (let i = 0; i < count; i++) {
      pos[i * 3] = point.x;
      pos[i * 3 + 1] = point.y;
      pos[i * 3 + 2] = point.z;
      vel.push(new THREE.Vector3(
        rand(-2, 2), rand(-1, 2.5), rand(-2, 2)
      ).add(dir.clone().multiplyScalar(rand(1.5, 4.5))).add(
        new THREE.Vector3(0, 1.2, 0)
      ));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: this._ichor, size: 0.19, map: splatSprite(),
      transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    this.scene.add(pts);
    this.bloods.push({ pts, mat, vel, life: 0.55, maxLife: 0.55 });
  }

  // ==================================================================
  // Bullet decal
  // ==================================================================
  decal(point, normal) {
    if (this.decals.length > 70) {
      const d = this.decals.shift();
      this.scene.remove(d.mesh);
      d.mesh.geometry.dispose();
    }
    const size = rand(0.11, 0.2);
    const mat = new THREE.MeshBasicMaterial({
      map: holeSprite(), color: 0x0a0a0a,
      transparent: true, opacity: 0.85, depthWrite: false,
    });
    const geo = new THREE.PlaneGeometry(size, size);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(point).addScaledVector(normal, 0.014);
    m.lookAt(point.clone().add(normal));
    m.renderOrder = 1;
    this.scene.add(m);
    this.decals.push({ mesh: m, life: 26, maxLife: 26 });
  }

  // ==================================================================
  // Explosion (enemy death)
  // ==================================================================
  explosion(pos, scale = 1, color = 0x00e5ff) {
    // Core flash sprite (the dominant bloom source)
    this.flash(pos, 0xffffff, 4.5 * scale, 0.18);
    this.flash(pos, color, 6.5 * scale, 0.3);

    // Shockwave ring
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.34, 32), ringMat);
    ring.position.copy(pos);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    this.explosions.push({ mesh: ring, mat: ringMat, kind: 'ring', life: 0.45, maxLife: 0.45, scale });

    // Expanding shock sphere
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5 * scale, 2), sphereMat);
    sphere.position.copy(pos);
    this.scene.add(sphere);
    this.explosions.push({ mesh: sphere, mat: sphereMat, kind: 'flash', life: 0.24, maxLife: 0.24, scale });

    // Light
    this._addLight(pos, color, 9 * scale, 16 * scale, 0.35, this.explosions, 1);

    // Debris
    const n = Math.round(12 * scale);
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(n * 3);
    const vel = [];
    for (let i = 0; i < n; i++) {
      p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
      vel.push(new THREE.Vector3(rand(-6, 6), rand(1.5, 8), rand(-6, 6)));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const mat = new THREE.PointsMaterial({
      color, size: 0.2 * scale, map: sparkSprite(),
      transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    this.scene.add(pts);
    this.explosions.push({ mesh: pts, mat, vel, kind: 'debris', life: 0.9, maxLife: 0.9, scale });
  }

  // ==================================================================
  // Muzzle flash point light (short-lived)
  // ==================================================================
  muzzleFlash(pos, color = 0x9ff8ff, intensity = 3) {
    this.flash(pos, color, 0.95, 0.06);
    this.flash(pos, 0xffffff, 0.5, 0.04);
    this._addLight(pos, color, intensity, 11, 0.08, this.sparks);
  }

  /**
   * Add a short-lived light from the shared pool. If the pool is exhausted the
   * effect still plays (sprite/mesh/ring) — only the illumination is dropped,
   * which is far better than a shader recompile stall.
   * @param {{x:number,y:number,z:number}} at
   * @param {Array} bucket Pool list to push the effect record onto.
   */
  _addLight(at, color, intensity, distance, life, bucket, scale = 1) {
    const light = this.lightPool?.acquire(
      at.x, at.y, at.z, color, intensity, distance
    );
    if (!light) return;
    bucket.push({
      mesh: light, mat: light, kind: 'light', isLight: true,
      life, maxLife: life, scale, pooled: true,
    });
  }

  // ==================================================================
  // Screen-space damage popup
  // ==================================================================
  /** @param {THREE.Vector3} worldPos */
  popup(worldPos, text, cls = '') {
    if (!this._popupLayer) return;
    this._v.copy(worldPos).project(this.camera);
    // Behind camera → skip
    if (this._v.z > 1) return;
    const x = (this._v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this._v.y * 0.5 + 0.5) * window.innerHeight;
    if (x < -50 || x > window.innerWidth + 50 || y < -50 || y > window.innerHeight + 50) return;

    const el = document.createElement('div');
    el.className = 'popup' + (cls ? ' ' + cls : '');
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this._popupLayer.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  // ==================================================================
  // Update
  // ==================================================================
  update(dt) {
    // ---- billboard flashes ----
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      const k = clamp(f.life / f.maxLife, 0, 1);
      // Fast pop then quick fade
      f.mat.opacity = k * k;
      f.mesh.scale.setScalar(f.size * (1.25 - k * 0.25));
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        f.mat.dispose();
        this.flashes.splice(i, 1);
      }
    }

    // ---- tracers ----
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      const k = clamp(t.life / t.maxLife, 0, 1);
      t.mat.opacity = k * 0.95;
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        t.mat.dispose();
        this.tracers.splice(i, 1);
      }
    }

    // ---- sparks / lights / blood ----
    this._updateParticles(this.sparks, dt);
    this._updateParticles(this.bloods, dt);

    // ---- decals fade ----
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.life -= dt;
      if (d.life < 3) d.mesh.material.opacity = clamp(d.life / 3, 0, 0.75);
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        d.mesh.material.dispose();
        this.decals.splice(i, 1);
      }
    }

    // ---- explosions ----
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.life -= dt;
      const k = clamp(e.life / e.maxLife, 0, 1);

      if (e.kind === 'ring') {
        const s = (1 - k) * 5 * e.scale;
        e.mesh.scale.setScalar(s);
        e.mat.opacity = k * 0.85;
      } else if (e.kind === 'flash') {
        e.mesh.scale.setScalar((1 - k) * 1.6 * e.scale + 0.2);
        e.mat.opacity = k * 0.9;
      } else if (e.isLight) {
        e.mesh.intensity = k * 6 * e.scale;
      } else if (e.kind === 'debris') {
        this._stepPoints(e, dt, (1 - k) * 4);
        e.mat.opacity = k;
      } else if (e.kind === 'column') {
        // Spawn column: narrows and fades, scaling with remaining life
        e.mesh.scale.set(1 - k * 0.35, 1, 1 - k * 0.35);
        e.mat.opacity = k * 0.32;
      }

      if (e.life <= 0) {
        if (e.isLight && e.pooled) {
          this.lightPool?.release(e.mesh);
        } else {
          this.scene.remove(e.mesh);
          if (e.mesh.geometry) e.mesh.geometry.dispose();
          if (!e.isLight) e.mat.dispose();
        }
        this.explosions.splice(i, 1);
      }
    }
  }

  _updateParticles(arr, dt) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const s = arr[i];
      s.life -= dt;
      if (s.isLight) {
        s.mat.intensity = clamp(s.life / s.maxLife, 0, 1) * 2.6;
      } else {
        this._stepPoints(s, dt, 11);
        s.mat.opacity = clamp(s.life / s.maxLife, 0, 1);
      }
      if (s.life <= 0) {
        const sys = s.pts || s.mesh;
        if (s.isLight && s.pooled) {
          this.lightPool?.release(sys);
        } else {
          this.scene.remove(sys);
          if (!s.isLight && sys?.geometry) {
            sys.geometry.dispose();
            s.mat.dispose();
          }
        }
        arr.splice(i, 1);
      }
    }
  }

  _stepPoints(p, dt, gravity) {
    // Particle systems are stored under either `pts` (sparks/blood) or
    // `mesh` (explosion debris). Accept both so the callers can stay simple.
    const sys = p.pts || p.mesh;
    const attr = sys.geometry.getAttribute('position');
    const arr = attr.array;
    for (let i = 0; i < p.vel.length; i++) {
      const v = p.vel[i];
      v.y -= gravity * dt;
      arr[i * 3] += v.x * dt;
      arr[i * 3 + 1] += v.y * dt;
      arr[i * 3 + 2] += v.z * dt;
      // Bounce off the floor plane
      if (arr[i * 3 + 1] < 0.04) {
        arr[i * 3 + 1] = 0.04;
        v.y = Math.abs(v.y) * 0.28;
        v.x *= 0.6;
        v.z *= 0.6;
      }
    }
    attr.needsUpdate = true;
  }

  /** Remove all live effects (used on game restart). */
  clear() {
    const all = [...this.tracers, ...this.sparks, ...this.bloods,
                 ...this.decals, ...this.explosions, ...this.flashes];
    for (const e of all) {
      const obj = e.mesh || e.pts;
      if (e.isLight && e.pooled) {
        this.lightPool?.release(obj);
        continue;
      }
      this.scene.remove(obj);
      if (obj?.geometry) obj.geometry.dispose();
      if (!e.isLight) e.mat?.dispose?.();
    }
    this.tracers.length = 0;
    this.sparks.length = 0;
    this.bloods.length = 0;
    this.decals.length = 0;
    this.explosions.length = 0;
    this.flashes.length = 0;
  }
}
