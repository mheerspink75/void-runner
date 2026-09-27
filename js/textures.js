/**
 * textures.js — Procedurally generated textures (no image assets).
 *
 * Generates canvas-based maps for metal panels, floor plating, concrete
 * and normal maps derived from height. Everything is cached by key so
 * repeated material creation is free.
 */

import * as THREE from '../vendor/three.module.js';

// Process-lifetime cache, deliberately never invalidated.
//
// The arena (World) is constructed once at boot and reused across every run —
// _resetRun() in main.js clears the dynamic systems but never rebuilds the
// world or its materials. So this cache's lifetime is the World's lifetime,
// not a run's, and nothing here may be disposed while the World is alive.
//
// Disposing would not corrupt the arena: three.js drops the GPU handle in
// deallocateTexture() and re-uploads from texture.source on next use, so the
// maps would come back looking correct. The cost is a full re-upload of every
// texture on every subsequent run, which is exactly the kind of hitch the
// static arena exists to avoid.
//
// So there is deliberately no dispose path. If a future change rebuilds the
// World, that change should own disposal for the whole graph it builds, rather
// than reaching in here and invalidating textures the live World still uses.
const cache = new Map();

function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Deterministic value noise so textures are stable between reloads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable fBm noise sampled on a torus so edges wrap seamlessly. */
function fbmField(size, octaves, seed) {
  const rnd = mulberry32(seed);
  const grids = [];
  for (let o = 0; o < octaves; o++) {
    const n = 4 << o;                 // 4, 8, 16, 32 ...
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    grids.push({ n, g });
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (grid, x, y) => {
    const { n, g } = grid;
    const fx = x * n, fy = y * n;
    const x0 = Math.floor(fx) % n, y0 = Math.floor(fy) % n;
    const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const tx = smooth(fx - Math.floor(fx));
    const ty = smooth(fy - Math.floor(fy));
    const a = g[y0 * n + x0], b = g[y0 * n + x1];
    const c = g[y1 * n + x0], d = g[y1 * n + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, tot = 0;
      for (let o = 0; o < octaves; o++) {
        v += sample(grids[o], x / size, y / size) * amp;
        tot += amp;
        amp *= 0.5;
      }
      out[y * size + x] = v / tot;
    }
  }
  return out;
}

/** Convert a height field into a tangent-space normal map texture. */
function normalFromHeight(height, size, strength = 2.2) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normalize (-dx, -dy, 1)
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function texFromCanvas(canvas, repeat = 1, srgb = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------
 * Floor: large metal plates with seams, bolts and grime
 * ------------------------------------------------------------------ */
export function floorMaps() {
  return cached('floor', () => {
    const S = 512;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    const rnd = mulberry32(1337);

    ctx.fillStyle = '#2a3d4e';
    ctx.fillRect(0, 0, S, S);

    // Grime noise
    const noise = fbmField(S, 4, 99);
    const img = ctx.getImageData(0, 0, S, S);
    for (let i = 0; i < S * S; i++) {
      const n = noise[i];
      const d = (n - 0.5) * 46;
      img.data[i * 4] = Math.max(0, Math.min(255, img.data[i * 4] + d));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, img.data[i * 4 + 1] + d));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, img.data[i * 4 + 2] + d * 1.1));
    }
    ctx.putImageData(img, 0, 0);

    // Plate seams (2x2 grid per tile)
    ctx.strokeStyle = 'rgba(10,18,26,0.85)';
    ctx.lineWidth = 4;
    for (const p of [0, S / 2]) {
      ctx.beginPath();
      ctx.moveTo(p, 0); ctx.lineTo(p, S);
      ctx.moveTo(0, p); ctx.lineTo(S, p);
      ctx.stroke();
    }
    // Seam highlight
    ctx.strokeStyle = 'rgba(150,190,220,0.14)';
    ctx.lineWidth = 1;
    for (const p of [0, S / 2]) {
      ctx.beginPath();
      ctx.moveTo(p + 2, 0); ctx.lineTo(p + 2, S);
      ctx.moveTo(0, p + 2); ctx.lineTo(S, p + 2);
      ctx.stroke();
    }

    // Bolts at plate corners
    for (const gx of [0, S / 2]) {
      for (const gy of [0, S / 2]) {
        for (const [ox, oy] of [[16, 16], [S / 2 - 16, 16], [16, S / 2 - 16], [S / 2 - 16, S / 2 - 16]]) {
          const x = gx + ox, y = gy + oy;
          const g = ctx.createRadialGradient(x - 1, y - 1, 0, x, y, 5);
          g.addColorStop(0, 'rgba(190,215,235,0.75)');
          g.addColorStop(0.6, 'rgba(70,95,115,0.6)');
          g.addColorStop(1, 'rgba(20,32,44,0.5)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // Scratches
    ctx.lineWidth = 1;
    for (let i = 0; i < 70; i++) {
      const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2, l = 8 + rnd() * 46;
      ctx.strokeStyle = `rgba(190,220,240,${0.03 + rnd() * 0.07})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      ctx.stroke();
    }

    // Roughness map: bolts/seams darker (smoother), grime rougher
    const rC = makeCanvas(S);
    const rCtx = rC.getContext('2d');
    const rImg = rCtx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = 150 + noise[i] * 90;
      rImg.data[i * 4] = rImg.data[i * 4 + 1] = rImg.data[i * 4 + 2] = v;
      rImg.data[i * 4 + 3] = 255;
    }
    rCtx.putImageData(rImg, 0, 0);

    // Height -> normal
    const h = fbmField(S, 5, 7);
    const nrm = normalFromHeight(h, S, 1.4);

    return {
      map: texFromCanvas(c, 9, true),
      roughnessMap: texFromCanvas(rC, 9),
      normalMap: texFromCanvas(nrm, 9),
    };
  });
}

/* ------------------------------------------------------------------
 * Wall: tall ribbed panels
 * ------------------------------------------------------------------ */
export function wallMaps() {
  return cached('wall', () => {
    const S = 512;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    const rnd = mulberry32(4242);

    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#2c4459');
    g.addColorStop(0.55, '#24384a');
    g.addColorStop(1, '#1b2c3c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    // Vertical ribs
    const ribs = 8;
    const rw = S / ribs;
    for (let i = 0; i < ribs; i++) {
      const x = i * rw;
      const rg = ctx.createLinearGradient(x, 0, x + rw, 0);
      rg.addColorStop(0, 'rgba(255,255,255,0.10)');
      rg.addColorStop(0.35, 'rgba(255,255,255,0.02)');
      rg.addColorStop(0.75, 'rgba(0,0,0,0.16)');
      rg.addColorStop(1, 'rgba(0,0,0,0.30)');
      ctx.fillStyle = rg;
      ctx.fillRect(x, 0, rw, S);
    }

    // Horizontal band
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(0, S * 0.46, S, 6);
    ctx.fillStyle = 'rgba(160,200,230,0.10)';
    ctx.fillRect(0, S * 0.46 + 6, S, 2);

    // Grime + scratches
    const noise = fbmField(S, 4, 21);
    const img = ctx.getImageData(0, 0, S, S);
    for (let i = 0; i < S * S; i++) {
      const d = (noise[i] - 0.5) * 38;
      img.data[i * 4] = Math.max(0, Math.min(255, img.data[i * 4] + d));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, img.data[i * 4 + 1] + d));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, img.data[i * 4 + 2] + d));
    }
    ctx.putImageData(img, 0, 0);
    ctx.lineWidth = 1;
    for (let i = 0; i < 50; i++) {
      const x = rnd() * S, y = rnd() * S, l = 10 + rnd() * 60;
      ctx.strokeStyle = `rgba(200,225,245,${0.02 + rnd() * 0.05})`;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + l); ctx.stroke();
    }

    // Height field with ribs
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const rib = Math.cos((x / rw) * Math.PI * 2) * 0.5 + 0.5;
        h[y * S + x] = rib * 0.7 + noise[y * S + x] * 0.3;
      }
    }

    return {
      map: texFromCanvas(c, 3, true),
      normalMap: texFromCanvas(normalFromHeight(h, S, 2.6), 3),
    };
  });
}

/* ------------------------------------------------------------------
 * Crate: industrial container panels
 * ------------------------------------------------------------------ */
export function crateMaps() {
  return cached('crate', () => {
    const S = 256;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    const rnd = mulberry32(808);

    ctx.fillStyle = '#6d5f48';
    ctx.fillRect(0, 0, S, S);

    // Inner panel
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(S * 0.14, S * 0.14, S * 0.72, S * 0.72);

    // Frame border
    ctx.strokeStyle = 'rgba(255,240,210,0.16)';
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, S - 20, S - 20);

    // Corner brackets
    ctx.fillStyle = 'rgba(40,32,22,0.55)';
    const b = 26;
    for (const [x, y] of [[0, 0], [S - b, 0], [0, S - b], [S - b, S - b]]) {
      ctx.fillRect(x, y, b, b);
    }

    // Hazard stripes
    ctx.save();
    ctx.beginPath();
    ctx.rect(S * 0.18, S * 0.62, S * 0.64, 22);
    ctx.clip();
    for (let i = -S; i < S * 2; i += 18) {
      ctx.fillStyle = i % 36 === 0 ? 'rgba(240,200,60,0.55)' : 'rgba(30,24,16,0.55)';
      ctx.beginPath();
      ctx.moveTo(i, 0); ctx.lineTo(i + 9, 0);
      ctx.lineTo(i + 9 + 30, S); ctx.lineTo(i + 30, S);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    // Scratches / wear
    ctx.lineWidth = 1;
    for (let i = 0; i < 40; i++) {
      const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2, l = 4 + rnd() * 22;
      ctx.strokeStyle = `rgba(0,0,0,${0.05 + rnd() * 0.14})`;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      ctx.stroke();
    }

    return {
      map: texFromCanvas(c, 1, true),
      normalMap: texFromCanvas(normalFromHeight(fbmField(S, 4, 3), S, 1.1), 1),
    };
  });
}

/* ------------------------------------------------------------------
 * Pillar / structure metal
 * ------------------------------------------------------------------ */
export function pillarMaps() {
  return cached('pillar', () => {
    const S = 256;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3d5266';
    ctx.fillRect(0, 0, S, S);

    // Brushed streaks
    const rnd = mulberry32(555);
    for (let i = 0; i < 240; i++) {
      const y = rnd() * S;
      ctx.strokeStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${0.02 + rnd() * 0.05})`;
      ctx.lineWidth = 1 + rnd() * 2;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(S, y + (rnd() - 0.5) * 6);
      ctx.stroke();
    }

    // Rivet bands
    for (const y of [S * 0.12, S * 0.88]) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(0, y - 7, S, 14);
      for (let x = 10; x < S; x += 22) {
        const g = ctx.createRadialGradient(x - 1, y - 1, 0, x, y, 4);
        g.addColorStop(0, 'rgba(200,225,245,0.6)');
        g.addColorStop(1, 'rgba(25,38,50,0.5)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      }
    }

    return {
      map: texFromCanvas(c, 2, true),
      normalMap: texFromCanvas(normalFromHeight(fbmField(S, 4, 11), S, 1.0), 2),
    };
  });
}

/**
 * Radial glow sprite, used for muzzle flashes, impact flares and the sky.
 * Additive blending reads best on a black canvas.
 */
export function glowSprite(color = '#7ff4ff', power = 2.2) {
  return cached(`glow:${color}:${power}`, () => {
    const S = 128;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    const col = new THREE.Color(color);
    const half = S / 2;

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - half, y - half) / half;
        const a = Math.max(0, 1 - d);
        const v = Math.pow(a, power);
        const i = (y * S + x) * 4;
        img.data[i] = col.r * 255;
        img.data[i + 1] = col.g * 255;
        img.data[i + 2] = col.b * 255;
        img.data[i + 3] = v * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** Soft round particle used for sparks / embers. */
export function sparkSprite() {
  return cached('spark', () => {
    const S = 64;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.16)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** Blood / ichor splatter sprite for enemy hits. */
export function splatSprite() {
  return cached('splat', () => {
    const S = 64;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.42)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** Bullet hole decal with a dark centre and a bright rim. */
export function holeSprite() {
  return cached('hole', () => {
    const S = 64;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.0, 'rgba(0,0,0,0.95)');
    g.addColorStop(0.30, 'rgba(0,0,0,0.72)');
    g.addColorStop(0.42, 'rgba(190,215,235,0.35)');
    g.addColorStop(0.62, 'rgba(120,150,175,0.14)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}
