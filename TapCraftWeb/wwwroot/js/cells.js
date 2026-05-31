// TapCraft - the world model: procedural per-cell terrain generated ON DEMAND
// from the seed, plus a sparse "delta" overlay of cells that have been modified
// from their procedural baseline. This replaces the old five full 2D arrays
// (tiles/stage/progress/chop/rock), so worlds can be arbitrarily large (e.g.
// 10000x10000) - nothing is stored unless it changes, and only the visible
// viewport (plus building radii) is ever evaluated.
//
//   base*At(c,r)  - pure function of (seed, settings): the baseline terrain.
//   <field>At(c,r) - the delta value if the cell was modified, else the baseline.
//   set<Field>(c,r,v) - record a modification into G.world.mods.
//
// The baseline samplers reproduce the math that worldgen.js used to run as full
// passes (generateTerrain / seedRocks / seedMinerals / seedForest), but per cell.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { hash01, makeFbm, inBounds } from "./rng.js";
import { encodeMineable, mineableTypeIndex } from "./mineable.js";

// --- Terrain tuning (engine constants, ported from worldgen.generateTerrain) --
const BASE_SCALE = 0.045, WARP_SCALE = 0.08, WARP_AMT = 22;
const CONTRAST = 1.5, FALLOFF_EXP = 2.4, FALLOFF_MUL = 1.0;
const FOREST_SCALE = 0.14;
const THRESHOLD_SAMPLES = 4096;   // cells sampled to estimate the land/water cutoff
const INF_SAMPLE_SPAN = 2048;     // half-span around origin sampled for infinite worlds

// Per-world generator state, built once by initWorldGen. null before a world exists.
let gen = null;

// Baseline samplers are pure (immutable for a given seed) but expensive - each
// call can recurse into neighbor/precedence sampling. A frame re-reads the same
// cells many times (hit-test, tile pass, entity pass, neighbor checks), and the
// viewport repeats across frames, so we memoize results. Cleared on world change;
// bounded so an infinite world's cache can't grow without limit.
let baseCache = new Map();
const BASE_CACHE_CAP = 300000;
function memo(tag, c, r, fn) {
  const k = tag + c + "," + r;
  let v = baseCache.get(k);
  if (v === undefined) {
    v = fn(c, r);
    if (baseCache.size > BASE_CACHE_CAP) baseCache.clear();
    baseCache.set(k, v);
  }
  return v;
}

// Build the noise closures + derived per-world parameters, then estimate the
// land threshold and pick a spawn cell. Call after G.world.cols/rows are set.
export function initWorldGen(seed, settings) {
  const s = seed >>> 0;
  const cols = G.world.cols, rows = G.world.rows;
  const st = settings || {};
  const rk = GD.worldgen.rock, mn = GD.worldgen.mineral;
  const mineralDensity = (st.mineral != null) ? st.mineral : 0.4;
  const infinite = !!G.world.infinite;
  gen = {
    s, cols, rows, infinite,
    // Infinite + large worlds drop the centered radial island falloff -> continents/
    // oceans throughout. Only small FINITE worlds keep the single-island look.
    falloff: !infinite && cols <= (GD.worldgen.islandMaxSize || 128),
    base: makeFbm(s, 6),
    warpX: makeFbm((s ^ 0x9e3779b9) >>> 0, 4),
    warpY: makeFbm((s ^ 0x85ebca6b) >>> 0, 4),
    clumpRock: makeFbm((s ^ 0x51ed2701) >>> 0, 3),
    clumpMineral: makeFbm((s ^ 0x2c1b3a9f) >>> 0, 3),
    fForest: makeFbm((s ^ 0x1b56c4e9) >>> 0, 4),
    // rocks
    rockDensity: st.rockDensity || 0,
    scaleR: rk.scaleTight + (rk.scaleSpread - rk.scaleTight) * (st.rockCluster || 0),
    thresholdR: rk.thresholdBase - rk.thresholdDensityFactor * (st.rockDensity || 0),
    fillR: rk.fillMax * (st.rockDensity || 0),
    rSeed: (s ^ 0x1f83d9ab) >>> 0,
    vSeed: (s ^ 0x7f4a7c15) >>> 0,
    // minerals
    mineralDensity,
    scaleM: mn.scaleTight + (mn.scaleSpread - mn.scaleTight) * mineralDensity,
    thresholdM: mn.thresholdBase - mn.thresholdDensityFactor * mineralDensity,
    fillM: mn.fillMax * mineralDensity,
    mFillSeed: (s ^ 0x10a4f2bd) >>> 0,
    tSeed: (s ^ 0x6b43a9c7) >>> 0,
    // forest
    forestDensity: st.forestDensity || 0,
    cluster: st.cluster || 0,
    fSeed: (s ^ 0x632be59b) >>> 0,
    // misc hashes
    sandSeed: (s ^ 0x27d4eb2f) >>> 0,
    stageSeed: (s ^ 0x3c6ef35f) >>> 0,
    progSeed: (s ^ 0x2545f491) >>> 0,
  };
  baseCache.clear();
  G.world.landThreshold = sampleThreshold(st.landFraction != null ? st.landFraction : 0.55);
  G.world.spawn = findSpawn();
}

// Estimate the elevation cutoff that yields the requested land fraction, by
// sampling a fixed set of cells (a full sort over a 100M-cell world is not an
// option). Deterministic from the seed.
function sampleThreshold(landFraction) {
  const cols = gen.cols, rows = gen.rows;
  const n = gen.infinite ? THRESHOLD_SAMPLES : Math.min(THRESHOLD_SAMPLES, cols * rows);
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = hash01(i, 1, (gen.s ^ 0xabcd1234) >>> 0);
    const v = hash01(2, i, (gen.s ^ 0x1234abcd) >>> 0);
    let c, r;
    if (gen.infinite) {
      c = Math.floor((u * 2 - 1) * INF_SAMPLE_SPAN);   // sample a wide region around origin
      r = Math.floor((v * 2 - 1) * INF_SAMPLE_SPAN);
    } else {
      c = Math.min(cols - 1, Math.floor(u * cols));
      r = Math.min(rows - 1, Math.floor(v * rows));
    }
    vals[i] = elevationAt(c, r);
  }
  vals.sort();
  const idx = Math.min(n - 1, Math.max(0, Math.floor((1 - landFraction) * n)));
  return vals[idx];
}

// First non-water cell scanning outward (Chebyshev rings) from the world center
// (origin for infinite worlds).
function findSpawn() {
  const cc = gen.infinite ? 0 : Math.floor(gen.cols / 2);
  const cr = gen.infinite ? 0 : Math.floor(gen.rows / 2);
  const maxRad = gen.infinite ? 4096 : Math.max(gen.cols, gen.rows);
  for (let rad = 0; rad < maxRad; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue; // ring only
        const c = cc + dc, r = cr + dr;
        if (inBounds(c, r) && baseTileAt(c, r) !== "water") return { c, r };
      }
    }
  }
  return { c: cc, r: cr };
}

// --- Baseline samplers (pure functions of seed + settings) -------------------
function elevationAt(c, r) {
  const wx = c + (gen.warpX(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * WARP_AMT;
  const wy = r + (gen.warpY(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * WARP_AMT;
  let e = gen.base(wx * BASE_SCALE, wy * BASE_SCALE);
  e = (e - 0.5) * CONTRAST + 0.5;
  if (gen.falloff) {
    const nx = (wx / (gen.cols - 1) - 0.5) * 2;
    const ny = (wy / (gen.rows - 1) - 0.5) * 2;
    const d = Math.min(1, Math.hypot(nx, ny));
    e = e - Math.pow(d, FALLOFF_EXP) * FALLOFF_MUL;
  }
  return e;
}
function isWaterAt(c, r) {
  // Finite worlds get a 2-tile water border (matches the old edge pass). Infinite
  // worlds have no edge - terrain just continues.
  if (!gen.infinite && (r < 2 || c < 2 || r >= gen.rows - 2 || c >= gen.cols - 2)) return true;
  return elevationAt(c, r) < G.world.landThreshold;
}
// Manhattan distance to the nearest water (capped at the sand range). With no
// obstacles this equals the old global BFS distance-to-water.
function coastDist(c, r) {
  const maxCoast = GD.worldgen.sandChance.length - 1;
  for (let d = 1; d <= maxCoast; d++) {
    for (let dc = -d; dc <= d; dc++) {
      const rem = d - Math.abs(dc);
      if (isWaterAt(c + dc, r + rem)) return d;
      if (rem !== 0 && isWaterAt(c + dc, r - rem)) return d;
    }
  }
  return maxCoast + 1;
}
function grassSurrounded(c, r) {
  if (baseTileAt(c, r) !== "grass") return false;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nc = c + dc, nr = r + dr;
      if (!inBounds(nc, nr) || baseTileAt(nc, nr) !== "grass") return false;
    }
  }
  return true;
}
function pickInitialStage(c, r) {
  const w = GD.worldgen.initialStageWeights;
  const u = hash01(c, r, gen.stageSeed);
  let acc = 0;
  for (let st = 0; st < w.length; st++) { acc += w[st]; if (u < acc) return st; }
  return GD.matureStage;
}

export function baseTileAt(c, r) { return memo("t", c, r, computeTileAt); }
export function baseRockRawAt(c, r) { return memo("k", c, r, computeRockRawAt); }
export function baseStageAt(c, r) { return memo("s", c, r, computeStageAt); }
export function baseProgressAt(c, r) { return memo("p", c, r, computeProgressAt); }

function computeTileAt(c, r) {
  if (isWaterAt(c, r)) return "water";
  const sand = GD.worldgen.sandChance;
  const maxCoast = sand.length - 1;
  const d = coastDist(c, r);
  const p = (d >= 1 && d <= maxCoast) ? sand[d] : 0;
  if (p > 0 && hash01(c, r, gen.sandSeed) < p) return "sand";
  return "grass";
}
// Baseline mineable encoding for a cell: a rock (typeIndex 0) takes precedence,
// then an ore vein, else -1. Mirrors the seedRocks -> seedMinerals order (ore
// ignored trees because the forest pass ran last, so trees are not consulted).
function computeRockRawAt(c, r) {
  const tile = baseTileAt(c, r);
  const placeR = GD.objects.rock.placeableOn;
  if (gen.rockDensity > 0 && tile === placeR.tile &&
      (!placeR.requireInterior || grassSurrounded(c, r))) {
    const field = gen.clumpRock(c * gen.scaleR, r * gen.scaleR);
    if (field > gen.thresholdR) {
      const local = (field - gen.thresholdR) / (1 - gen.thresholdR);
      if (hash01(c, r, gen.rSeed) < gen.fillR * local) {
        return hash01(c, r, gen.vSeed) < 0.5 ? 0 : 1; // rock variant (typeIndex 0)
      }
    }
  }
  if (gen.mineralDensity > 0 && tile === "grass" &&
      (gen.infinite || (c >= 2 && r >= 2 && c < gen.cols - 2 && r < gen.rows - 2))) {
    const field = gen.clumpMineral(c * gen.scaleM, r * gen.scaleM);
    if (field > gen.thresholdM) {
      const local = (field - gen.thresholdM) / (1 - gen.thresholdM);
      if (hash01(c, r, gen.mFillSeed) < gen.fillM * local) {
        const types = GD.worldgen.mineral.types;
        const ti = Math.floor(hash01(c, r, gen.tSeed) * types.length) % types.length;
        return encodeMineable(mineableTypeIndex(types[ti]), 0);
      }
    }
  }
  return -1;
}
function computeStageAt(c, r) {
  if (gen.forestDensity <= 0) return -1;
  if (baseRockRawAt(c, r) >= 0) return -1;       // no tree where a rock/ore sits
  const placeF = GD.objects.tree.placeableOn;
  if (baseTileAt(c, r) !== placeF.tile) return -1;
  if (placeF.requireInterior && !grassSurrounded(c, r)) return -1;
  const rnd = hash01(c, r, gen.fSeed);
  const noise = gen.fForest(c * FOREST_SCALE, r * FOREST_SCALE);
  const score = rnd * (1 - gen.cluster) + noise * gen.cluster;
  if (score > 1 - gen.forestDensity) return pickInitialStage(c, r);
  return -1;
}
function computeProgressAt(c, r) {
  const st = baseStageAt(c, r);
  if (st < 0 || st >= GD.matureStage) return 0;
  return hash01(c, r, gen.progSeed) * GD.worldgen.stageFull;
}

// --- Delta overlay -----------------------------------------------------------
// G.world.mods : Map<"c,r", { t?, st?, pr?, ch?, rk? }> (only changed fields).
// Keys are coordinate STRINGS so they work unbounded / with negative coords
// (infinite worlds), not just within a fixed cols*rows grid.
function entryAt(c, r) { return G.world.mods.get(c + "," + r); }
function ensureEntry(c, r) {
  const k = c + "," + r;
  let e = G.world.mods.get(k);
  if (!e) { e = {}; G.world.mods.set(k, e); }
  return e;
}

// Clamp a cell-range box to the world. Finite worlds clamp to [0,cols/rows-1];
// infinite worlds pass through unchanged (any coordinate is valid).
export function clampBox(c0, c1, r0, r1) {
  if (G.world.infinite) return { c0, c1, r0, r1 };
  return {
    c0: Math.max(0, c0), c1: Math.min(G.world.cols - 1, c1),
    r0: Math.max(0, r0), r1: Math.min(G.world.rows - 1, r1),
  };
}

export function tileAt(c, r) { const e = entryAt(c, r); return (e && e.t !== undefined) ? e.t : baseTileAt(c, r); }
export function stageAt(c, r) { const e = entryAt(c, r); return (e && e.st !== undefined) ? e.st : baseStageAt(c, r); }
export function progressAt(c, r) { const e = entryAt(c, r); return (e && e.pr !== undefined) ? e.pr : baseProgressAt(c, r); }
export function chopAt(c, r) { const e = entryAt(c, r); return (e && e.ch !== undefined) ? e.ch : 0; }
export function rockRawAt(c, r) { const e = entryAt(c, r); return (e && e.rk !== undefined) ? e.rk : baseRockRawAt(c, r); }

// Diagnostics for the debug overlay.
export function baseCacheSize() { return baseCache.size; }

export function setTile(c, r, v) { ensureEntry(c, r).t = v; }
export function setStage(c, r, v) { ensureEntry(c, r).st = v; }
export function setProgress(c, r, v) { ensureEntry(c, r).pr = v; }
export function setChop(c, r, v) { ensureEntry(c, r).ch = v; }
export function setRockRaw(c, r, v) { ensureEntry(c, r).rk = v; }
