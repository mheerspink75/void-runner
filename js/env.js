/**
 * env.js — Procedural environment map.
 *
 * Three.js metals are lit almost entirely by reflections. With no env map a
 * `metalness: 0.8` surface renders near-black, which is why a physically
 * sensible material can still look like a silhouette. This builds a cheap
 * equirectangular gradient (sky → horizon → ground) and pre-filters it with
 * PMREM so metals pick up plausible reflections.
 *
 * No external HDR asset required.
 */

import * as THREE from '../vendor/three.module.js';

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} [opts]
 * @returns {THREE.Texture} PMREM-filtered environment texture
 */
export function makeEnvironment(renderer, opts = {}) {
  const {
    sky = '#2b6f92',
    horizon = '#0e2334',
    ground = '#050a10',
    glowColor = '#7fe8ff',
    glowStrength = 0.55,
  } = opts;

  const w = 256;
  const h = 128;

  // --- draw the gradient into a canvas ---
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.00, sky);
  grad.addColorStop(0.42, horizon);
  grad.addColorStop(0.52, horizon);
  grad.addColorStop(1.00, ground);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // A couple of soft "light banks" so reflections have some structure
  const bank = (cx, cy, r, color, alpha) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  };

  bank(w * 0.28, h * 0.22, 46, glowColor, glowStrength);
  bank(w * 0.74, h * 0.34, 34, '#ff6a8a', glowStrength * 0.5);
  bank(w * 0.52, h * 0.86, 52, glowColor, 0.18);

  // --- upload as an equirect texture ---
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  // --- pre-filter for roughness-aware reflections ---
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromEquirectangular(tex);

  // Clean up the intermediate resources; the render target is the result.
  tex.dispose();
  pmrem.dispose();

  return envRT.texture;
}
