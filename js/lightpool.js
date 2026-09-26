/**
 * lightpool.js — Fixed-size pool of THREE.PointLight objects.
 *
 * WHY THIS EXISTS
 * ---------------
 * three.js includes the *number of lights in the scene* in the key it uses to
 * cache compiled shader programs. Every point light that is added or removed
 * changes that key, so the next frame has to recompile every lit material in
 * the scene. In this project that recompile measured ~200-260ms — a hard
 * hitch — and it fired repeatedly during normal play, because enemies, pickups
 * and impact effects each add and remove their own transient light:
 *
 *   - EnemyManager: one PointLight per enemy (up to waves.maxAlive = 18)
 *   - PickupManager: one PointLight baked into each pickup template
 *   - Effects:     transient lights for muzzle flash, impacts, spawn portals
 *
 * So the light count drifted up and down constantly and the shader cache never
 * settled. Observed spikes were perfectly correlated with the frame on which
 * the point-light count changed.
 *
 * THE FIX
 * -------
 * Allocate a fixed number of PointLights up front, add them to the scene
 * permanently, and hand them out to callers as slots. A slot is either active
 * (position + intensity set) or idle (intensity 0). Because the *count in the
 * scene never changes*, every material compiles exactly once and the program
 * cache stays warm.
 *
 * IDLE SLOTS MUST STAY `visible = true`
 * -------------------------------------
 * The obvious optimisation — hiding unused slots with `light.visible = false` —
 * does NOT work. three.js skips invisible lights when it builds the render
 * state, so hiding them just moves the count around again: it drifted 17-25
 * here, which is what kept triggering the recompile. An idle slot is instead
 * left visible with `intensity = 0`, which contributes no light but does hold
 * the count steady.
 */

import * as THREE from '../vendor/three.module.js';

/** How long (seconds) a released light takes to fade out. */
const RELEASE_FADE = 0.05;

export class LightPool {
  /**
   * @param {THREE.Scene} scene
   * @param {number} capacity Maximum number of simultaneous dynamic lights.
   *   Must be large enough for the busiest moment in a wave; requests beyond
   *   this are dropped (the visual degrades gracefully, the frame rate does not).
   */
  constructor(scene, capacity) {
    this.scene = scene;
    this.capacity = capacity;

    /** @type {Array<{light:THREE.PointLight, busy:boolean, fade:number}>} */
    this._slots = [];
    for (let i = 0; i < capacity; i++) {
      // Left `visible = true` on purpose — see the note at the top of the file.
      // An intensity-0 light is inert but keeps the scene's light count, and
      // therefore the shader program cache key, constant.
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      scene.add(light);
      this._slots.push({ light, busy: false, fade: RELEASE_FADE });
    }

    // Reusable scratch objects so acquire() does not allocate.
    this._col = new THREE.Color();
  }

  /** Number of slots currently handed out. */
  get activeCount() {
    let n = 0;
    for (const s of this._slots) if (s.busy) n++;
    return n;
  }

  /**
   * Take a light and place it at (x, y, z).
   * @returns {THREE.PointLight|null} null if the pool is exhausted.
   */
  acquire(x, y, z, color, intensity, distance, decay = 2) {
    // Prefer a free slot; otherwise steal the one closest to finishing its
    // release fade, which is already visually dying.
    let slot = null;
    for (const s of this._slots) {
      if (s.busy) continue;
      slot = s;
      break;
    }
    if (!slot) {
      let best = -1;
      for (let i = 0; i < this._slots.length; i++) {
        const s = this._slots[i];
        if (s.fade < best) continue;   // keep the most-finished fade
        best = s.fade;
        slot = s;
      }
      if (slot.fade <= 0) return null;   // all slots hard-active
    }

    const { light } = slot;
    light.position.set(x, y, z);
    light.color.set(color);
    light.intensity = intensity;
    light.distance = distance;
    light.decay = decay;
    slot.busy = true;
    slot.fade = 0;
    return light;
  }

  /**
   * Start fading a light out. The slot is not free for `RELEASE_FADE`
   * seconds, so back-to-back effects do not flicker.
   */
  release(light) {
    if (!light) return;
    for (const s of this._slots) {
      if (s.light !== light) continue;
      s.fade = RELEASE_FADE;
      return;
    }
  }

  /**
   * Advance release fades. Call once per frame, after all systems have had a
   * chance to acquire/release.
   */
  update(dt) {
    for (const s of this._slots) {
      if (s.fade <= 0) continue;
      s.fade -= dt;
      if (s.fade > 0) continue;
      s.busy = false;
      // Fade the intensity out rather than hiding the light: the light must
      // stay visible for the scene's light count to remain constant.
      s.light.intensity = 0;
    }
  }

  /**
   * Free every slot immediately. Used on run restart so a new run does not
   * inherit lights from the previous one.
   */
  clear() {
    for (const s of this._slots) {
      s.busy = false;
      s.fade = 0;
      s.light.intensity = 0;
    }
  }
}
