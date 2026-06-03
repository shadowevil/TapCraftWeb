// TapCraft - deterministic hash, noise and small map helpers.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";

// --- Deterministic hash + noise --------------------------------------
export function hash01(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
// 50/50 coin, and on heads a random GAIN_MIN..GAIN_MAX. 0 on tails.
export function growthStep(c, r, tick, seed) {
  const ts = (seed ^ Math.imul(tick, 0x9e3779b1)) >>> 0;
  if (hash01(c, r, ts) >= 0.5) return 0;
  const u = hash01(c, r, (ts ^ 0x68e31da4) >>> 0);
  return GD.worldgen.gainMin + u * (GD.worldgen.gainMax - GD.worldgen.gainMin);
}
export function makeFbm(seed, octaves = 5) {
  const smooth = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const value = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    return lerp(
      lerp(hash01(xi, yi, seed), hash01(xi + 1, yi, seed), u),
      lerp(hash01(xi, yi + 1, seed), hash01(xi + 1, yi + 1, seed), u),
      v
    );
  };
  return (x, y) => {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * value(x * freq, y * freq);
      norm += amp;
      amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
}

// 3D value-noise. Sampling it on a CIRCLE (x -> angle, y -> latitude) gives a
// field that WRAPS seamlessly east-west - the basis for globe worlds (cells.js).
export function hash3(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) +
    Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
export function makeFbm3(seed, octaves = 5) {
  const smooth = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const value = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = smooth(xf), v = smooth(yf), w = smooth(zf);
    const c = (a, b, d) => hash3(xi + a, yi + b, zi + d, seed);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  };
  return (x, y, z) => {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) { sum += amp * value(x * freq, y * freq, z * freq); norm += amp; amp *= 0.5; freq *= 2; }
    return sum / norm;
  };
}

// 4D value-noise. Sampling it on TWO circles (one per axis) gives a field that wraps
// seamlessly in BOTH directions - the basis for the torus globe (every direction loops).
export function hash4(x, y, z, w, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) +
    Math.imul(z | 0, 2147483647) + Math.imul(w | 0, 1640531527) + Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
export function makeFbm4(seed, octaves = 5) {
  const smooth = (a) => a * a * (3 - 2 * a);
  const lerp = (a, b, t) => a + (b - a) * t;
  const value = (x, y, z, w) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
    const u = smooth(x - xi), v = smooth(y - yi), s = smooth(z - zi), t = smooth(w - wi);
    const h = (a, b, d, e) => hash4(xi + a, yi + b, zi + d, wi + e, seed);
    const ix = (b, d, e) => lerp(h(0, b, d, e), h(1, b, d, e), u); // interp along x
    const iy = (d, e) => lerp(ix(0, d, e), ix(1, d, e), v);        // along y
    const iz = (e) => lerp(iy(0, e), iy(1, e), s);                 // along z
    return lerp(iz(0), iz(1), t);                                  // along w
  };
  return (x, y, z, w) => {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) { sum += amp * value(x * freq, y * freq, z * freq, w * freq); norm += amp; amp *= 0.5; freq *= 2; }
    return sum / norm;
  };
}

// --- Map helpers ------------------------------------------------------
export function makeLayer(cols, rows, fill) {
  const m = new Array(rows);
  for (let r = 0; r < rows; r++) m[r] = new Array(cols).fill(fill);
  return m;
}
export function inBounds(col, row) {
  if (G.world.infinite) return true; // unbounded: every coordinate is a valid cell
  // A WRAPPING axis (globe/torus) makes every coordinate on that axis valid; a
  // non-wrapping axis is bounded by its edge. The torus globe wraps both.
  const okC = G.world.wrapX || (col >= 0 && col < G.world.cols);
  const okR = G.world.wrapY || (row >= 0 && row < G.world.rows);
  return okC && okR;
}
