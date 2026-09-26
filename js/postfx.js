/**
 * postfx.js — Post-processing stack.
 *
 * Chain:  scene → Render → Bloom → Grade/Vignette/Grain/CA → Output
 *
 * The grade pass is a single custom fragment shader doing chromatic
 * aberration, film grain, vignette, scanlines and a health-aware colour
 * push, so it costs one full-screen pass rather than four.
 *
 * Quality tiers scale the bloom resolution and can disable passes entirely
 * on low-end hardware (see `setQuality`).
 */

import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from '../vendor/postfx/EffectComposer.js';
import { RenderPass } from '../vendor/postfx/RenderPass.js';
import { ShaderPass } from '../vendor/postfx/ShaderPass.js';
import { UnrealBloomPass } from '../vendor/postfx/UnrealBloomPass.js';
import { OutputPass } from '../vendor/postfx/OutputPass.js';
import { clamp } from './utils.js';
import { Pass } from '../vendor/postfx/Pass.js';

/* ------------------------------------------------------------------
 * Combined grade pass
 * ------------------------------------------------------------------ */
const GradeShader = {
  uniforms: {
    tDiffuse:     { value: null },
    uTime:        { value: 0 },
    uVignette:    { value: 1.0 },   // strength
    uGrain:       { value: 0.055 }, // film grain amount
    uAberration:  { value: 0.0018 },// chromatic aberration (r/g/b split)
    uScanline:    { value: 0.035 }, // CRT scanline depth
    uDamage:      { value: 0.0 },   // 0..1 red pulse when hurt
    uHeal:        { value: 0.0 },   // 0..1 green pulse when healed
    uHealLow:     { value: 0.0 },   // 0..1 constant tint at low health
    uSaturation:  { value: 1.14 },
    uContrast:    { value: 1.07 },
    uResolution:  { value: new THREE.Vector2(1, 1) },
    uRadial:      { value: 0.0 },   // radial blur strength (dash / sprint)
    uSpeed:       { value: 0.0 },   // 0..1 velocity-driven radial blur
    uSharpen:     { value: 0.22 },  // unsharp mask amount
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uScanline;
    uniform float uDamage;
    uniform float uHeal;
    uniform float uHealLow;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec2  uResolution;
    uniform float uRadial;
    uniform float uSpeed;
    uniform float uSharpen;

    varying vec2 vUv;

    // Cheap hash-based noise
    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // ---- radial blur (motion cue) ----
      // Samples march toward the screen centre, so the world appears to
      // streak outward. Driven by sprint speed and spikes on dash.
      float radial = max(uRadial, uSpeed * 0.5);
      vec3 colRadial = vec3(0.0);
      if (radial > 0.002) {
        vec2 dir = centered * radial;
        vec3 acc = vec3(0.0);
        // 6 taps is enough for a smooth streak at this strength
        for (int i = 0; i < 6; i++) {
          float t = float(i) / 5.0;
          acc += texture2D(tDiffuse, uv - dir * t).rgb;
        }
        colRadial = acc / 6.0;
      }

      // ---- chromatic aberration: stronger toward the edges ----
      float ab = uAberration * (0.35 + r2 * 3.0);
      vec2 dir2 = normalize(centered + 1e-6);
      float rC = texture2D(tDiffuse, uv - dir2 * ab).r;
      float gC = texture2D(tDiffuse, uv).g;
      float bC = texture2D(tDiffuse, uv + dir2 * ab).b;
      vec3 col = vec3(rC, gC, bC);

      if (radial > 0.002) {
        col = mix(col, colRadial, clamp(radial * 1.6, 0.0, 0.85));
      }

      // ---- unsharp mask: cheap local contrast boost ----
      if (uSharpen > 0.001) {
        vec2 px = 1.0 / uResolution;
        vec3 blur =
          texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb +
          texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb +
          texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb +
          texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb;
        blur *= 0.25;
        col += (col - blur) * uSharpen;
      }

      // ---- damage: red edge bloom + slight desaturation ----
      if (uDamage > 0.001) {
        float edge = smoothstep(0.10, 0.55, r2);
        col = mix(col, vec3(0.85, 0.06, 0.16), edge * uDamage * 0.85);
        col.r += uDamage * 0.10;
      }

      // ---- heal: green wash ----
      if (uHeal > 0.001) {
        float edge = smoothstep(0.12, 0.60, r2);
        col += vec3(0.05, 0.30, 0.12) * uHeal * edge;
      }

      // ---- low health: constant pulsing red vignette ----
      if (uHealLow > 0.001) {
        float pulse = 0.6 + 0.4 * sin(uTime * 5.5);
        float edge = smoothstep(0.06, 0.42, r2);
        col = mix(col, vec3(0.55, 0.02, 0.07), edge * uHealLow * pulse * 0.7);
      }

      // ---- saturation & contrast ----
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;

      // ---- cool shadow / warm highlight split-tone ----
      float shadowMask = 1.0 - smoothstep(0.0, 0.45, luma);
      col += vec3(-0.01, 0.015, 0.05) * shadowMask;
      float highMask = smoothstep(0.55, 1.0, luma);
      col += vec3(0.03, 0.012, -0.02) * highMask;

      // ---- vignette ----
      float vig = 1.0 - uVignette * smoothstep(0.18, 0.78, r2);
      col *= vig;

      // ---- scanlines (subtle, screen-space) ----
      if (uScanline > 0.0001) {
        float sl = sin(uv.y * uResolution.y * 1.15);
        col *= 1.0 - uScanline * (0.5 + 0.5 * sl);
      }

      // ---- film grain ----
      if (uGrain > 0.0001) {
        float n = hash(uv * uResolution + fract(uTime) * 137.0);
        col += (n - 0.5) * uGrain;
      }

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

/* ------------------------------------------------------------------
 * Viewmodel pass
 *
 * The weapon viewmodel lives in its own scene so it can never clip through
 * world geometry. It is drawn as a pass *after* the main render and *before*
 * bloom, so the weapon picks up the same glow and colour grade as the world
 * instead of looking like a pasted-on overlay.
 * ------------------------------------------------------------------ */
class ViewmodelPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    // Rendered into the composer's HDR buffer so bloom sees the muzzle flash.
    this.needsSwap = false;
    this.clear = false;
  }

  setScene(scene) { this.scene = scene; }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.scene) return;
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    if (this.camera.aspect !== w / h) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    // Draw on top of the world: keep the colour buffer, discard the depth so
    // the gun is never occluded by geometry it visually sits in front of.
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
  }
}

/* ------------------------------------------------------------------
 * PostFX manager
 * ------------------------------------------------------------------ */
export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    this.quality = 'high';

    const size = renderer.getSize(new THREE.Vector2());

    // ---- composer ----
    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // ---- viewmodel (drawn into the same HDR buffer, before bloom) ----
    this.vmPass = new ViewmodelPass(null, null);
    this.composer.addPass(this.vmPass);

    // ---- bloom ----
    // Kept deliberately restrained: the arena has a lot of emissive trim, and
    // a low threshold plus high strength turns every neon line into a smear
    // and blows out the core sphere and the weapon.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      0.34,   // strength
      0.42,   // radius
      0.92    // threshold — only genuinely bright pixels bloom
    );
    this.composer.addPass(this.bloom);

    // ---- grade ----
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uResolution.value.set(size.x, size.y);
    this.composer.addPass(this.grade);

    // ---- output (tone mapping + color space) ----
    this.output = new OutputPass();
    this.composer.addPass(this.output);

    // Transient state driven by gameplay
    this._damage = 0;
    this._heal = 0;
    this._healLow = 0;
    this._shakeAmp = 0;
    this._shakeT = 0;
    this._hitstop = 0;
    this._radial = 0;
    this._speedBlur = 0;
  }

  setSize(w, h) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.grade.uniforms.uResolution.value.set(w * pr, h * pr);
  }

  /** Attach the weapon viewmodel so it renders inside the post chain. */
  setViewmodel(scene, camera) {
    this.vmPass.setScene(scene);
    this.vmPass.camera = camera;
  }

  /** Temporarily skip the viewmodel (death screen, menus). */
  setViewmodelVisible(v) {
    this.vmPass.enabled = v;
  }

  setCamera(cam) {
    this.camera = cam;
    this.renderPass.camera = cam;
  }

  /** High | medium | low — adjusts cost, not gameplay. */
  setQuality(q) {
    this.quality = q;
    const u = this.grade.uniforms;
    switch (q) {
      case 'high':
        this.bloom.enabled = true;
        this.bloom.strength = 0.34;
        u.uGrain.value = 0.045;
        u.uScanline.value = 0.03;
        u.uAberration.value = 0.0015;
        u.uSharpen.value = 0.22;
        break;
      case 'medium':
        this.bloom.enabled = true;
        this.bloom.strength = 0.55;
        u.uGrain.value = 0.04;
        u.uScanline.value = 0.02;
        u.uAberration.value = 0.0012;
        u.uSharpen.value = 0.0;
        break;
      case 'low':
        this.bloom.enabled = false;
        u.uGrain.value = 0.0;
        u.uScanline.value = 0.0;
        u.uAberration.value = 0.0;
        u.uSharpen.value = 0.0;
        break;
    }
  }

  setBloom(strength) {
    if (this.bloom.enabled) this.bloom.strength = strength;
  }

  /** Called when the player takes damage. */
  pulseDamage(strength = 1) {
    this._damage = clamp(this._damage + strength, 0, 1.4);
  }

  /** Called when the player heals. */
  pulseHeal(strength = 1) {
    this._heal = clamp(this._heal + strength, 0, 1.2);
  }

  /** Continuous low-health tint, 0..1. */
  setLowHealth(k) {
    this._healLow = clamp(k, 0, 1);
  }

  /**
   * Camera shake handled in post so it does not desync from the player
   * transform. Returns the applied offset for the viewmodel to match.
   */
  addShake(amount) {
    this._shakeAmp = Math.min(this._shakeAmp + amount, 1.6);
  }

  /** Radial-blur spike, used for dashes and hard landings. */
  addRadialBlur(amount) {
    this._radial = Math.min(this._radial + amount, 1.2);
  }

  /**
   * Continuous radial blur from movement speed, 0..1.
   * @param {number} k normalized speed
   */
  setSpeedBlur(k) {
    this._speedBlur = clamp(k, 0, 1);
  }

  /**
   * Brief full-freeze on impact. Returns the number of seconds the caller
   * should skip simulation for.
   */
  addHitstop(seconds) {
    this._hitstop = Math.max(this._hitstop, seconds);
  }

  get hitstop() { return this._hitstop; }

  /**
   * Advance the post chain.
   * @returns {{x:number,y:number,rot:number}} camera shake offset applied
   */
  update(dt) {
    // Decay transients
    this._damage = Math.max(0, this._damage - dt * 2.6);
    this._heal = Math.max(0, this._heal - dt * 1.9);
    this._shakeAmp = Math.max(0, this._shakeAmp - dt * 3.4);
    this._hitstop = Math.max(0, this._hitstop - dt);
    this._radial = Math.max(0, this._radial - dt * 3.2);

    const u = this.grade.uniforms;
    u.uTime.value += dt;
    u.uDamage.value = this._damage;
    u.uHeal.value = this._heal;
    u.uHealLow.value = this._healLow;
    u.uRadial.value = this._radial;
    // Speed blur only shows past ~55% of top speed so walking stays crisp.
    const s = clamp((this._speedBlur - 0.55) / 0.45, 0, 1);
    u.uSpeed.value = s * s * 0.5;

    // Shake offset
    this._shakeT += dt * 42;
    const a = this._shakeAmp;
    const shake = {
      x: a * Math.sin(this._shakeT * 1.7) * 0.016,
      y: a * Math.cos(this._shakeT * 2.3) * 0.014,
      rot: a * Math.sin(this._shakeT * 1.1) * 0.010,
    };

    if (this.camera && (a > 0.001)) {
      this.camera.position.x += shake.x;
      this.camera.position.y += shake.y;
      this.camera.rotation.z += shake.rot;
    }
    return shake;
  }

  render() {
    this.composer.render();
  }

  dispose() {
    this.composer.dispose?.();
    this.bloom.dispose?.();
  }
}
