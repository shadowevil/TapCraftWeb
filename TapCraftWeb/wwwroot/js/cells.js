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
const BASE_CACHE_CAP = 400000; // headroom: terrain enrichment adds memo tags (e/m/d/h)
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
  // Biomes are driven by SMOOTH low-octave "heatmap" fields (not fractal noise), so
  // each biome forms a coherent region with gradual transitions: an `upland` field
  // (elevation-biased) carves highland; a `moist` field splits the rest into
  // dry/plains/meadow. Integer weights partition by land fraction; biomeSize scales
  // both fields. Per-biome properties are data-driven in GD.worldgen.biomes.list.
  const bw = st.biomeWeights || { meadow: 3, plains: 4, dry: 2, highland: 2 };
  const biomeSize = (st.biomeSize != null) ? st.biomeSize : 0.5;
  // Lower factor -> lower frequency -> LARGER biomes. Default (biomeSize 0.5) = 1.0;
  // the slider spans ~1.8x smaller .. 5x larger.
  const biomeSizeFactor = 1.8 - 1.6 * Math.max(0, Math.min(1, biomeSize));
  const biomeById = {};
  let highlandDef = null;
  const moistOrder = []; // moisture biome ids in dry->wet (list) order, excluding highland
  for (const bdef of (GD.worldgen.biomes && GD.worldgen.biomes.list) || []) {
    biomeById[bdef.id] = bdef;
    if (bdef.elevation) highlandDef = bdef; else moistOrder.push(bdef.id);
  }
  const ter = GD.worldgen.terrain || {}, cont = GD.worldgen.continent || {};
  const bio = GD.worldgen.biomes || {}, dec = GD.worldgen.decor || {};
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
    // --- generation version + biome/decoration enrichment ---
    // genVersion: NEW worlds stamp 2 (richer terrain); missing (old saves) -> 1 legacy.
    genVersion: (st.genVersion != null) ? (st.genVersion | 0) : 1,
    heightSpan: GD.worldgen.heightSpan || 0.35,
    // Smooth (low-octave) biome heatmap fields. moist -> dry/plains/meadow; upland ->
    // highland (decoupled from the fractal terrain so it forms coherent regions).
    moist: makeFbm((s ^ 0xa1b2c3d4) >>> 0, (bio.octaves != null) ? bio.octaves : 2),
    upland: makeFbm((s ^ 0x3f5a8c17) >>> 0, (bio.octaves != null) ? bio.octaves : 2),
    continent: makeFbm((s ^ 0xc0ffee01) >>> 0, 2),
    decorField: makeFbm((s ^ 0xdec0de11) >>> 0, 3),
    moistScale: (bio.moistureScale || 0.006) * biomeSizeFactor,
    uplandScale: (bio.uplandScale || 0.008) * biomeSizeFactor,
    moistWarp: (bio.warp != null) ? bio.warp : 8,
    // highland score = blend of the smooth upland field and real height (elevWeight =
    // the real-height share): mostly coherent regions, but pulled toward higher ground.
    highlandElevWeight: (bio.highlandElevWeight != null) ? bio.highlandElevWeight : 0.3,
    forestMax: (bio.forestMax != null) ? bio.forestMax : 0.8, // cap on biome-scaled forest density (perf + walkability)
    contScale: cont.scale || 0.011,
    contAmp: cont.amp || 0.16,
    decorScale: dec.fieldScale || 0.16,
    decorDensity: (st.decorDensity != null) ? st.decorDensity : 0.4,
    decorCluster: (st.decorCluster != null) ? st.decorCluster : 0.6,
    rockHeightBias: ter.rockHeightBias || 0,
    beachHeight: ter.beachHeight || 0,
    beachTiles: ter.beachTiles || 0,
    biomeById, highlandDef, biomeWeights: bw, moistOrder,
    // biome cut points, filled by sampleBiomeThresholds() below (moistCuts has one
    // entry per boundary between adjacent moisture biomes, in dry->wet order).
    highlandThresh: Infinity, moistCuts: [], highlandFrac: 0,
    grassSeed: (s ^ 0x3a9d1c7b) >>> 0,
    decorSeed: (s ^ 0x5e8f21a3) >>> 0,
    decorPickSeed: (s ^ 0x91b7e4d5) >>> 0,
  };
  baseCache.clear();
  G.world.landThreshold = sampleThreshold(st.landFraction != null ? st.landFraction : 0.55);
  sampleBiomeThresholds(); // highland elevation cutoff + dry/plains/meadow moisture cuts
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

// Derive the biome cut points from settings.biomeWeights by sampling land cells (same
// deterministic scheme as sampleThreshold). Highland takes the highest `highland/total`
// fraction of land by the smooth HIGHLAND SCORE (upland heatmap + height blend,
// genVersion>=2 only); the remaining land is split by the smooth MOISTURE field into
// dry/plains/meadow by their relative weights. Storing quantile thresholds (not fixed
// cutoffs) makes the weights behave as land fractions regardless of the field's
// distribution shape. Deterministic from the seed.
function sampleBiomeThresholds() {
  const w = gen.biomeWeights || {};
  const order = gen.moistOrder;                       // moisture biomes, dry -> wet
  const moistW = order.map((id) => Math.max(0, w[id] || 0));
  const lowTot = moistW.reduce((a, b) => a + b, 0);
  const wHigh = Math.max(0, w.highland || 0);
  const total = lowTot + wHigh;
  gen.highlandFrac = (gen.genVersion >= 2 && total > 0) ? (wHigh / total) : 0;
  const cols = gen.cols, rows = gen.rows;
  const n = gen.infinite ? THRESHOLD_SAMPLES : Math.min(THRESHOLD_SAMPLES, cols * rows);
  const scores = [], moists = [];
  for (let i = 0; i < n; i++) {
    const u = hash01(i, 7, (gen.s ^ 0x51a2b3c4) >>> 0);
    const v = hash01(9, i, (gen.s ^ 0x6d7e8f90) >>> 0);
    let c, r;
    if (gen.infinite) {
      c = Math.floor((u * 2 - 1) * INF_SAMPLE_SPAN);
      r = Math.floor((v * 2 - 1) * INF_SAMPLE_SPAN);
    } else {
      c = Math.min(cols - 1, Math.floor(u * cols));
      r = Math.min(rows - 1, Math.floor(v * rows));
    }
    if (isWaterAt(c, r)) continue; // land only
    scores.push(highlandScoreAt(c, r));
    moists.push(moistureAt(c, r));
  }
  // Even fallback cuts so every moisture biome is still reachable without samples.
  const evenCuts = () => order.slice(1).map((_, i) => (i + 1) / order.length);
  if (!scores.length) { gen.highlandThresh = Infinity; gen.moistCuts = evenCuts(); return; }
  if (gen.highlandFrac > 0) {
    const ss = scores.slice().sort((a, b) => a - b);
    const idx = Math.min(ss.length - 1, Math.max(0, Math.floor((1 - gen.highlandFrac) * ss.length)));
    gen.highlandThresh = ss[idx];
  } else {
    gen.highlandThresh = Infinity; // no highland (legacy v1, or highland weight 0)
  }
  // Moisture cut points among the NON-highland land samples: one per boundary between
  // adjacent moisture biomes, each placed at the cumulative weight fraction (so a biome's
  // weight is its share of the lowland).
  const low = [];
  for (let i = 0; i < moists.length; i++) if (scores[i] < gen.highlandThresh) low.push(moists[i]);
  low.sort((a, b) => a - b);
  if (!low.length || lowTot <= 0) { gen.moistCuts = evenCuts(); return; }
  const cuts = [];
  let cum = 0;
  for (let i = 0; i < moistW.length - 1; i++) {
    cum += moistW[i];
    const frac = cum / lowTot;
    cuts.push(low[Math.min(low.length - 1, Math.max(0, Math.floor(frac * low.length)))]);
  }
  gen.moistCuts = cuts;
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
// Elevation is memoized ("e"): a single cell's elevation is now read by isWaterAt,
// coastDist neighbors, landHeightAt, the highland/beach tests and biome sampling, so
// caching the fBm result removes a lot of repeat work.
function elevationAt(c, r) { return memo("e", c, r, computeElevation); }
function computeElevation(c, r) {
  const wx = c + (gen.warpX(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * WARP_AMT;
  const wy = r + (gen.warpY(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * WARP_AMT;
  let e = gen.base(wx * BASE_SCALE, wy * BASE_SCALE);
  e = (e - 0.5) * CONTRAST + 0.5;
  // genVersion>=2, large/infinite worlds: a very-low-frequency continent term breaks
  // the uniform land into archipelagos/peninsulas. Folded into elevation (not a local
  // threshold) so sampleThreshold's land-fraction estimate stays accurate. Small
  // finite (falloff) worlds keep the single radial island untouched.
  if (gen.genVersion >= 2 && !gen.falloff) {
    e += (gen.continent(wx * gen.contScale, wy * gen.contScale) * 2 - 1) * gen.contAmp;
  }
  if (gen.falloff) {
    const nx = (wx / (gen.cols - 1) - 0.5) * 2;
    const ny = (wy / (gen.rows - 1) - 0.5) * 2;
    const d = Math.min(1, Math.hypot(nx, ny));
    e = e - Math.pow(d, FALLOFF_EXP) * FALLOFF_MUL;
  }
  return e;
}
// Normalized height above sea level (0 at the coast .. 1 at the high end), clamped.
export function landHeightAt(c, r) {
  return Math.max(0, Math.min(1, (elevationAt(c, r) - G.world.landThreshold) / gen.heightSpan));
}
// Moisture field (0..1), lightly domain-warped for organic biome edges. Memoized ("m").
export function moistureAt(c, r) { return memo("m", c, r, computeMoisture); }
function computeMoisture(c, r) {
  const wa = gen.moistWarp;
  const wx = c + (gen.warpX(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * wa;
  const wy = r + (gen.warpY(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * wa;
  return gen.moist(wx * gen.moistScale, wy * gen.moistScale);
}
// Upland heatmap field (0..1), the smooth driver for highland regions. Memoized ("u").
export function uplandAt(c, r) { return memo("u", c, r, computeUpland); }
function computeUpland(c, r) {
  const wa = gen.moistWarp;
  const wx = c + (gen.warpX(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * wa;
  const wy = r + (gen.warpY(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * wa;
  return gen.upland(wx * gen.uplandScale, wy * gen.uplandScale);
}
// Highland score: mostly the smooth upland field, pulled toward real high ground by
// highlandElevWeight. sampleBiomeThresholds thresholds it to pick highland regions.
function highlandScoreAt(c, r) {
  const ew = gen.highlandElevWeight;
  return uplandAt(c, r) * (1 - ew) + landHeightAt(c, r) * ew;
}
function isHighland(c, r) {
  return gen.genVersion >= 2 && gen.highlandThresh !== Infinity && !!gen.highlandDef &&
    highlandScoreAt(c, r) >= gen.highlandThresh;
}
// The lowland (moisture) biome id for a cell, and its data def. Highland is handled
// separately (upland-gated, see isHighland). Walks the moisture cut points: dry biomes
// first, wet (forest/jungle) last, per the data-driven moistOrder.
function moistBiomeId(c, r) {
  const m = moistureAt(c, r);
  const cuts = gen.moistCuts, order = gen.moistOrder;
  for (let i = 0; i < cuts.length; i++) if (m < cuts[i]) return order[i];
  return order[order.length - 1];
}
function moistBiomeDef(c, r) { return gen.biomeById[moistBiomeId(c, r)] || null; }
// Full biome id for a cell (debug + diagnostics): "highland" when the upland gate
// applies (matching computeTileAt), else the moisture biome. null before a world exists.
export function biomeAt(c, r) {
  if (!gen) return null;
  if (isHighland(c, r)) return gen.highlandDef.id;
  return moistBiomeId(c, r);
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
  // genVersion>=2: smooth, coherent highland regions (the upland heatmap, see
  // isHighland) become rocky ground - stone in the region cores (highest score), dirt
  // on the rim. Highland is buildable; trees/rocks require grass, so they avoid it.
  if (isHighland(c, r)) {
    const hd = gen.highlandDef;
    const stoneCore = (hd.stoneCore != null) ? hd.stoneCore : 0.4;
    const stoneAt = gen.highlandThresh + (1 - gen.highlandThresh) * (1 - stoneCore);
    return (highlandScoreAt(c, r) >= stoneAt) ? (hd.tileHigh || "stone") : (hd.tileLow || "dirt");
  }
  const d = coastDist(c, r);
  // genVersion>=2: wider, solid beaches on gentle coasts - cells within beachTiles of
  // water whose ground sits barely above sea level (low landHeight). A steep coast
  // (elevation climbs fast -> high landHeight right at the shore) fails the height
  // test and keeps only the thin probabilistic sand band below.
  if (gen.genVersion >= 2 && gen.beachTiles > 0 && d <= gen.beachTiles &&
      landHeightAt(c, r) < gen.beachHeight) {
    return "sand";
  }
  const sand = GD.worldgen.sandChance;
  const maxCoast = sand.length - 1;
  const p = (d >= 1 && d <= maxCoast) ? sand[d] : 0;
  if (p > 0 && hash01(c, r, gen.sandSeed) < p) return "sand";
  return "grass";
}
// Baseline mineable encoding for a cell: a rock (typeIndex 0) takes precedence,
// then an ore vein, else -1. Mirrors the seedRocks -> seedMinerals order (ore
// ignored trees because the forest pass ran last, so trees are not consulted).
function computeRockRawAt(c, r) {
  const tile = baseTileAt(c, r);
  // genVersion>=2: bias stone/ore toward higher ground (rocky hills) while keeping
  // some in the lowlands. Neutral (1.0) at mid height; >1 up high, <1 down low.
  const hMul = (gen.genVersion >= 2)
    ? Math.max(0, 1 + gen.rockHeightBias * (2 * landHeightAt(c, r) - 1)) : 1;
  const placeR = GD.objects.rock.placeableOn;
  if (gen.rockDensity > 0 && tile === placeR.tile &&
      (!placeR.requireInterior || grassSurrounded(c, r))) {
    const field = gen.clumpRock(c * gen.scaleR, r * gen.scaleR);
    if (field > gen.thresholdR) {
      const local = (field - gen.thresholdR) / (1 - gen.thresholdR);
      if (hash01(c, r, gen.rSeed) < gen.fillR * local * hMul) {
        return hash01(c, r, gen.vSeed) < 0.5 ? 0 : 1; // rock variant (typeIndex 0)
      }
    }
  }
  if (gen.mineralDensity > 0 && tile === "grass" &&
      (gen.infinite || (c >= 2 && r >= 2 && c < gen.cols - 2 && r < gen.rows - 2))) {
    const field = gen.clumpMineral(c * gen.scaleM, r * gen.scaleM);
    if (field > gen.thresholdM) {
      const local = (field - gen.thresholdM) / (1 - gen.thresholdM);
      if (hash01(c, r, gen.mFillSeed) < gen.fillM * local * hMul) {
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
  if (baseTileAt(c, r) !== placeF.tile) return -1; // grass only (highland dirt/stone excluded)
  if (placeF.requireInterior && !grassSurrounded(c, r)) return -1;
  // genVersion>=2: scale forest density by the cell's moisture biome (meadow thick,
  // dry scrub sparse). Legacy v1 worlds keep the single global density.
  let dens = gen.forestDensity;
  if (gen.genVersion >= 2) {
    const b = moistBiomeDef(c, r);
    // Cap the biome-scaled density (forestMax): keeps even jungle from becoming a 100%
    // wall of trees, which both reads better (some gaps) and bounds the entity count.
    if (b && b.forestMul != null) dens = Math.max(0, Math.min(gen.forestMax, dens * b.forestMul));
  }
  const rnd = hash01(c, r, gen.fSeed);
  const noise = gen.fForest(c * FOREST_SCALE, r * FOREST_SCALE);
  const score = rnd * (1 - gen.cluster) + noise * gen.cluster;
  if (score > 1 - dens) return pickInitialStage(c, r);
  return -1;
}
function computeProgressAt(c, r) {
  const st = baseStageAt(c, r);
  if (st < 0 || st >= GD.matureStage) return 0;
  return hash01(c, r, gen.progSeed) * GD.worldgen.stageFull;
}

// --- Biome cosmetics: grass variants, decoration scatter, coastal shallows ----
// All COSMETIC (never change tile class / placement), so they apply to every world
// (including legacy v1). They are pure functions of (seed, settings, c, r).

// Which grass sprite variant a grass cell uses, biased by its moisture biome (index
// into GD.worldgen.grass.variants; 0 = base grass.png). Called by assets.tileSprite.
export function grassVariantAt(c, r) {
  if (!gen) return 0;
  const b = moistBiomeDef(c, r);
  if (!b || !b.grass || !b.grass.length) return 0;
  const variants = b.grass, weights = b.grassWeights;
  const u = hash01(c, r, gen.grassSeed);
  if (weights && weights.length === variants.length) {
    let acc = 0;
    for (let i = 0; i < variants.length; i++) { acc += weights[i]; if (u < acc) return variants[i]; }
  }
  return variants[Math.floor(u * variants.length) % variants.length];
}

// Cosmetic ground-cover decoration on a bare grass cell: an index into
// GD.worldgen.decor.sprites, or -1 for none. Gated on the BASE terrain (immutable per
// seed) so it stays pure/cacheable; the render pass additionally suppresses it on any
// cell that currently holds an object. Clustered (decorCluster) + biome-weighted.
export function decorAt(c, r) { return memo("d", c, r, computeDecorAt); }
function computeDecorAt(c, r) {
  if (baseTileAt(c, r) !== "grass") return -1;   // grass only (excludes highland/sand/water)
  if (baseStageAt(c, r) >= 0) return -1;          // a tree belongs here
  if (baseRockRawAt(c, r) >= 0) return -1;        // a rock/ore vein belongs here
  const b = moistBiomeDef(c, r);
  const dens = gen.decorDensity * ((b && b.decorMul != null) ? b.decorMul : 1);
  if (dens <= 0) return -1;
  const rnd = hash01(c, r, gen.decorSeed);
  const field = gen.decorField(c * gen.decorScale, r * gen.decorScale);
  const score = rnd * (1 - gen.decorCluster) + field * gen.decorCluster;
  if (score <= 1 - dens) return -1;
  const list = (b && b.decorSprites && b.decorSprites.length) ? b.decorSprites : null;
  if (!list) return -1;
  return list[Math.floor(hash01(c, r, gen.decorPickSeed) * list.length) % list.length];
}

// Distance from a WATER cell to the nearest land, capped at terrain.shallowTiles
// (1..max = shallow band strength; 0 = open water; -1 = a land cell). Memoized ("h").
export function shoreDist(c, r) { return memo("h", c, r, computeShoreDist); }
function isWaterBase(c, r) { return baseTileAt(c, r) === "water"; }
function computeShoreDist(c, r) {
  if (!isWaterBase(c, r)) return -1;
  const max = (GD.worldgen.terrain && GD.worldgen.terrain.shallowTiles) || 0;
  for (let d = 1; d <= max; d++) {
    for (let dc = -d; dc <= d; dc++) {
      const rem = d - Math.abs(dc);
      if (!isWaterBase(c + dc, r + rem)) return d;
      if (rem !== 0 && !isWaterBase(c + dc, r - rem)) return d;
    }
  }
  return 0;
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
