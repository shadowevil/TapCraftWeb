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

// --- Map helpers ------------------------------------------------------
export function makeLayer(cols, rows, fill) {
  const m = new Array(rows);
  for (let r = 0; r < rows; r++) m[r] = new Array(cols).fill(fill);
  return m;
}
export function inBounds(col, row) {
  return col >= 0 && row >= 0 && col < G.world.cols && row < G.world.rows;
}
