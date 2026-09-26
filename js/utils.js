/**
 * utils.js — Small math / helper library shared across systems.
 */

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const sign = Math.sign;

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Angle difference wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Smooth 0→1→0 pulse. */
export const pulse = (t, dur) => {
  const x = (t % dur) / dur;
  return Math.sin(x * Math.PI);
};

/** Random point on a ring of radius r in the XZ plane. */
export function ringPoint(r, innerJitter = 0.35) {
  const a = rand(0, Math.PI * 2);
  const rad = r * rand(1 - innerJitter, 1);
  return { x: Math.cos(a) * rad, z: Math.sin(a) * rad };
}

/** Weighted pick from a { key: weight } map. */
export function weightedPick(weights) {
  let total = 0;
  for (const k in weights) total += weights[k];
  let r = Math.random() * total;
  for (const k in weights) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return Object.keys(weights)[0];
}

/** Format 12345 → "12,345" */
export const fmt = (n) => Math.floor(n).toLocaleString('en-US');

/** Create a canvas 2D context helper. */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
