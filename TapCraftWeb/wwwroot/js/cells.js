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
import { hash01, makeFbm, makeFbm4, inBounds, growthStep } from "./rng.js";
import { encodeMineable, mineableTypeIndex } from "./mineable.js";

// --- Terrain tuning (engine constants, ported from worldgen.generateTerrain) --
const BASE_SCALE = 0.045, WARP_SCALE = 0.08, WARP_AMT = 22;
const CONTRAST = 1.5, FALLOFF_EXP = 2.4, FALLOFF_MUL = 1.0;
const FOREST_SCALE = 0.14;
const THRESHOLD_SAMPLES = 4096;   // cells sampled to estimate the land/water cutoff
const INF_SAMPLE_SPAN = 2048;     // half-span around origin sampled for infinite worlds

// Per-world generator state, built once by initWorldGen. null before a world exists.
let gen = null;

// --- Globe (torus world) helpers ---------------------------------------------
// The globe is a TORUS: BOTH axes wrap, so it loops in every direction (no edges,
// no poles). wrapCol/wrapRow canonicalize a coordinate into [0,cols)/[0,rows) so a
// cell and all its wrapped copies share ONE identity (memo cache, delta overlay,
// neighbor reads); the screen still draws the RAW coordinate, so panning loops
// seamlessly. gWrap2 samples a 4D-noise field on TWO circles (col -> angle,
// row -> angle) so the field is periodic in both directions -> no seam anywhere.
// sCurve redistributes elevation (flatter lowlands, sharper highs) for a
// continental look. All no-ops / unused on non-globe worlds.
export function wrapCol(c) {
  if (gen && gen.wrapX) { const n = gen.cols; c %= n; if (c < 0) c += n; }
  return c;
}
export function wrapRow(r) {
  if (gen && gen.wrapY) { const n = gen.rows; r %= n; if (r < 0) r += n; }
  return r;
}
function gWrap2(fbm4, c, r, freq) {
  const thc = (2 * Math.PI * c) / gen.cols, thr = (2 * Math.PI * r) / gen.rows;
  const rc = gen.Rc * freq, rr = gen.Rr * freq;
  return fbm4(Math.cos(thc) * rc, Math.sin(thc) * rc, Math.cos(thr) * rr, Math.sin(thr) * rr);
}
function sCurve(e, p) {
  return e <= 0.5 ? 0.5 * Math.pow(e * 2, p) : 1 - 0.5 * Math.pow((1 - e) * 2, p);
}

// Baseline samplers are pure (immutable for a given seed) but expensive - each
// call can recurse into neighbor/precedence sampling. A frame re-reads the same
// cells many times (hit-test, tile pass, entity pass, neighbor checks), and the
// viewport repeats across frames, so we memoize results. Cleared on world change;
// bounded so an infinite world's cache can't grow without limit.
// Cache layout: per-tag NESTED maps (tag -> Map<col, Map<row, value>>). The old
// design built a fresh "tag c,r" STRING key on every probe - the single largest
// source of garbage + string-hashing in the engine, since the base samplers are
// re-read many times per visible cell per frame. Nested integer-keyed maps remove
// the string entirely (and handle unbounded / negative coords on infinite worlds,
// which a packed numeric key could not). baseCacheCount tracks total entries for
// the bounded-size eviction (a tag is a short interned literal, so baseCache[tag]
// property access is fast).
let baseCache = Object.create(null);
let baseCacheCount = 0;
const BASE_CACHE_CAP = 400000; // headroom: terrain enrichment adds memo tags (e/m/d/h)
function memo(tag, c, r, fn) {
  // Torus: a cell and its wrapped copies share one entry (canonicalize both axes).
  if (gen.wrapX) { c %= gen.cols; if (c < 0) c += gen.cols; }
  if (gen.wrapY) { r %= gen.rows; if (r < 0) r += gen.rows; }
  // Fast path: cache hit (samplers never return undefined, so undefined == miss).
  const cm = baseCache[tag];
  if (cm !== undefined) {
    const rm = cm.get(c);
    if (rm !== undefined) {
      const hit = rm.get(r);
      if (hit !== undefined) return hit;
    }
  }
  // Miss: compute, then re-fetch the maps before storing (fn can recurse into memo
  // and an eviction may have wiped the cache mid-call) so we never write a stale ref.
  const v = fn(c, r);
  if (baseCacheCount > BASE_CACHE_CAP) { for (const k in baseCache) baseCache[k].clear(); baseCacheCount = 0; }
  let cm2 = baseCache[tag];
  if (cm2 === undefined) cm2 = baseCache[tag] = new Map();
  let rm2 = cm2.get(c);
  if (rm2 === undefined) { rm2 = new Map(); cm2.set(c, rm2); }
  rm2.set(r, v);
  baseCacheCount++;
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
  // World TYPE drives the coordinate model: globe = cylindrical (wraps east-west,
  // real poles). Derived from settings, falling back to the legacy infinite flag so
  // old saves keep their exact shape. Set on G.world so loadWorld picks it up too.
  const worldType = st.worldType || (infinite ? "infinite" : "flat");
  // Globe is a TORUS: both axes wrap (loops every direction, no poles/edges).
  const wrapX = (worldType === "globe");
  const wrapY = (worldType === "globe");
  G.world.wrapX = wrapX;
  G.world.wrapY = wrapY;
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
  // genVersion>=3 rock/ore zoning + flat-mountain tier (defaults if the pack lacks the block).
  const rzc = GD.worldgen.rockZones || {};
  const rockZones = {
    mountainShare: (rzc.mountainShare != null) ? rzc.mountainShare : 0.4,
    mountainRockMul: (rzc.mountainRockMul != null) ? rzc.mountainRockMul : 2.2,
    highlandRockMul: (rzc.highlandRockMul != null) ? rzc.highlandRockMul : 1.3,
    fieldstoneMul: (rzc.fieldstoneMul != null) ? rzc.fieldstoneMul : 0.1,
    oasisRockMul: (rzc.oasisRockMul != null) ? rzc.oasisRockMul : 0.6,
    mountainOreMul: (rzc.mountainOreMul != null) ? rzc.mountainOreMul : 1.7,
    highlandOreMul: (rzc.highlandOreMul != null) ? rzc.highlandOreMul : 0.7,
  };
  gen = {
    s, cols, rows, infinite, wrapX, wrapY,
    Rc: wrapX ? cols / (2 * Math.PI) : 0, // col-circle radius (arc-length per cell = 1)
    Rr: wrapY ? rows / (2 * Math.PI) : 0, // row-circle radius
    // Globe 4D-noise closures + tuning (filled by setupGlobeGen when globe). The
    // elevation/moisture/upland samplers branch to these for a seamless torus wrap.
    gBase: null, gWarpX: null, gWarpY: null, gCont: null, gMoist: null, gUpland: null, gTemp: null, globe: null, climate: null,
    // Infinite + large worlds drop the centered radial island falloff -> continents/
    // oceans throughout. Only small FINITE worlds keep the single-island look. Globe
    // has its own continental elevation, so the radial falloff never applies there.
    falloff: !infinite && !wrapX && cols <= (GD.worldgen.islandMaxSize || 128),
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
    highlandThresh: Infinity, mountainThresh: Infinity, moistCuts: [], highlandFrac: 0, rockZones,
    grassSeed: (s ^ 0x3a9d1c7b) >>> 0,
    decorSeed: (s ^ 0x5e8f21a3) >>> 0,
    decorPickSeed: (s ^ 0x91b7e4d5) >>> 0,
  };
  if (wrapX) setupGlobeGen(s);
  baseCache = Object.create(null); baseCacheCount = 0; // reset the per-tag memo cache for the new world
  G.world.hydro = null; // cleared for non-globe; rebuilt below for globe worlds
  G.world.landThreshold = sampleThreshold(st.landFraction != null ? st.landFraction : 0.55);
  sampleBiomeThresholds(); // highland elevation cutoff + dry/plains/meadow moisture cuts
  if (gen.globe) buildHydrology(); // coarse rivers/lakes (needs landThreshold); before findSpawn so spawn avoids water
  G.world.spawn = findSpawn();
}

// Build the globe's wrapping 4D-noise closures + tuning. Sampled on TWO circles by
// gWrap2 so elevation/moisture/upland are periodic in both axes (seamless torus).
// Tuning comes from GD.worldgen.globe (the values the standalone preview was tuned to).
function setupGlobeGen(s) {
  const g = GD.worldgen.globe || {};
  gen.gBase = makeFbm4(s, 6);
  gen.gCont = makeFbm4((s ^ 0xc0ffee01) >>> 0, 2);
  gen.gWarpX = makeFbm4((s ^ 0x9e3779b9) >>> 0, 4);
  gen.gWarpY = makeFbm4((s ^ 0x85ebca6b) >>> 0, 4);
  gen.gMoist = makeFbm4((s ^ 0x2c1b3a9f) >>> 0, 3);
  gen.gUpland = makeFbm4((s ^ 0x3f5a8c17) >>> 0, 3);
  gen.gTemp = makeFbm4((s ^ 0x7e3b1d29) >>> 0, 3);
  const contScale = (g.contScale != null) ? g.contScale : 0.007;
  gen.globe = {
    warpScale: (g.warpScale != null) ? g.warpScale : 0.08,
    baseScale: (g.baseScale != null) ? g.baseScale : 0.045,
    contScale,
    detailMix: (g.detailMix != null) ? g.detailMix : 0.28,
    sharpen: (g.sharpen != null) ? g.sharpen : 2.6,
    warp: (g.warp != null) ? g.warp : 18,
    moistScale: contScale * ((g.moistScaleMul != null) ? g.moistScaleMul : 1.3),
    uplandScale: contScale * ((g.uplandScaleMul != null) ? g.uplandScaleMul : 1.6),
  };
  const cm = GD.worldgen.climate || {};
  gen.climate = {
    noiseScale: (cm.noiseScale != null) ? cm.noiseScale : 0.004,
    noiseAmp: (cm.noiseAmp != null) ? cm.noiseAmp : 0.16,
    snowTemp: (cm.snowTemp != null) ? cm.snowTemp : 0.34,
    snowFull: (cm.snowFull != null) ? cm.snowFull : 0.1,
    iceTemp: (cm.iceTemp != null) ? cm.iceTemp : 0.2,
    tundraTemp: (cm.tundraTemp != null) ? cm.tundraTemp : 0.1,
    taigaTemp: (cm.taigaTemp != null) ? cm.taigaTemp : 0.34,
    hotTemp: (cm.hotTemp != null) ? cm.hotTemp : 0.55,
    hotFull: (cm.hotFull != null) ? cm.hotFull : 0.9,
    dryMoist: (cm.dryMoist != null) ? cm.dryMoist : 0.55,
    wetBand: (cm.wetBand != null) ? cm.wetBand : 0.35,
    desertForestCut: (cm.desertForestCut != null) ? cm.desertForestCut : 0.9,
    desertRockCut: (cm.desertRockCut != null) ? cm.desertRockCut : 0.55,
    desertDry: (cm.desertDry != null) ? cm.desertDry : 0.4,
    oasisChance: (cm.oasisChance != null) ? cm.oasisChance : 0.1,
  };
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
    // Mountain PEAK threshold: the top `mountainShare` of the highland (a smaller land
    // fraction) becomes solid-stone peaks, the rest foothills - same sorted-quantile method.
    const mFrac = gen.highlandFrac * gen.rockZones.mountainShare;
    const mIdx = Math.min(ss.length - 1, Math.max(0, Math.floor((1 - mFrac) * ss.length)));
    gen.mountainThresh = ss[mIdx];
  } else {
    gen.highlandThresh = Infinity; // no highland (legacy v1, or highland weight 0)
    gen.mountainThresh = Infinity;
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
  // Globe: spawn at ~1/4 latitude = temperate (avoid the hot mid-row desert + the frozen seam).
  const cr = gen.infinite ? 0 : gen.wrapX ? Math.floor(gen.rows / 4) : Math.floor(gen.rows / 2);
  // Globe starts at the equator (cr) and only needs to scan pole-to-pole to find
  // land along the central meridian - not the whole (possibly 100k-wide) circumference.
  const maxRad = gen.infinite ? 4096 : gen.wrapX ? gen.rows : Math.max(gen.cols, gen.rows);
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
// Globe elevation: a wrapping continental-blend (low-freq continents + high-freq
// coast detail), domain-warped, then sCurve-redistributed for a continental look.
// Periodic in BOTH axes (sampled on two circles by gWrap2) so there is no seam in
// any direction. Mirrors the approved preview. Returns 0..1; sea level is sampled
// from it for land%.
function computeElevationGlobe(c, r) {
  const gl = gen.globe;
  const aw = (gWrap2(gen.gWarpX, c, r, gl.warpScale) * 2 - 1) * gl.warp;
  const bw = (gWrap2(gen.gWarpY, c, r, gl.warpScale) * 2 - 1) * gl.warp;
  const cc = c + aw, rr = r + bw;
  const cont = gWrap2(gen.gCont, cc, rr, gl.contScale);
  const detail = gWrap2(gen.gBase, cc, rr, gl.baseScale);
  let e = cont * (1 - gl.detailMix) + detail * gl.detailMix;
  e = e < 0 ? 0 : e > 1 ? 1 : e;
  return sCurve(e, gl.sharpen);
}
function computeElevation(c, r) {
  if (gen.globe) return computeElevationGlobe(c, r);
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
  if (gen.globe) return gWrap2(gen.gMoist, c, r, gen.globe.moistScale); // globe: wrapping (torus) moisture field
  const wa = gen.moistWarp;
  const wx = c + (gen.warpX(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * wa;
  const wy = r + (gen.warpY(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * wa;
  return gen.moist(wx * gen.moistScale, wy * gen.moistScale);
}
// Upland heatmap field (0..1), the smooth driver for highland regions. Memoized ("u").
export function uplandAt(c, r) { return memo("u", c, r, computeUpland); }
function computeUpland(c, r) {
  if (gen.globe) return gWrap2(gen.gUpland, c, r, gen.globe.uplandScale); // globe: wrapping (torus) upland field
  const wa = gen.moistWarp;
  const wx = c + (gen.warpX(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * wa;
  const wy = r + (gen.warpY(c * WARP_SCALE, r * WARP_SCALE) * 2 - 1) * wa;
  return gen.upland(wx * gen.uplandScale, wy * gen.uplandScale);
}
// --- Globe climate: a wrapping latitude band (temperate mid-row, frozen at the seam) --
// Drives snow ground / ice water / forest thinning. Memoized ("T"); neutral off-globe.
export function temperatureAt(c, r) {
  if (!gen || !gen.globe) return 0.6;
  return memo("T", c, r, computeTemperature);
}
function computeTemperature(c, r) {
  const cl = gen.climate;
  const lat = r / gen.rows;                        // 0..1 (the memo already canonicalized r)
  // LINEAR (triangle) gradient: cold (0) at the wrap seam (poles), hot (1) at the mid row
  // (equator), uniform change per row -> even, WIDE transitions (a cosine made the middle thin).
  let t = 1 - Math.abs(1 - 2 * lat);
  t += (gWrap2(gen.gTemp, c, r, cl.noiseScale) * 2 - 1) * cl.noiseAmp; // wavy band edges
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
// Snowiness 0..1 (0 = bare ground, 1 = full snow); a smooth ramp as it gets colder.
export function snownessAt(c, r) {
  if (!gen || !gen.globe) return 0;
  const cl = gen.climate, t = temperatureAt(c, r);
  if (t >= cl.snowTemp) return 0;
  if (t <= cl.snowFull) return 1;
  return (cl.snowTemp - t) / (cl.snowTemp - cl.snowFull);
}
// Water freezes to ice in the cold band.
export function iceAt(c, r) {
  return !!(gen && gen.globe) && temperatureAt(c, r) < gen.climate.iceTemp;
}
// Desertness 0..1 = HOT and DRY. Zero unless both the heat and dryness gates are met, so
// moist tropics stay green. Shared by the per-cell sampler + the hydrology pass.
function desertFrom(t, m) {
  const cl = gen.climate;
  // Temperature-LED: 0 below hotTemp, ramping to full desert by hotFull (a wide gradient).
  let d = (t - cl.hotTemp) / (cl.hotFull - cl.hotTemp);
  if (d <= 0) return 0;
  if (d > 1) d = 1;
  // Moisture only TEMPERS it - very-moist hot land stays greener (oasis / future tropics).
  const wet = (m - cl.dryMoist) / cl.wetBand;
  return wet > 0 ? d * Math.max(0, 1 - wet) : d;
}
// Per-cell desertness (globe): drives sand ground + sparser rocks/foliage + less rain. The
// green RING around a rare kept desert water body (oasis) reads as not-desert.
export function desertAt(c, r) {
  if (!gen || !gen.globe) return 0;
  const h = G.world.hydro;
  if (h && h.oasisNear && h.oasisNear[hydroCoarse(c, r)]) return 0;
  return desertFrom(temperatureAt(c, r), moistureAt(c, r));
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
  // Globe (torus): for the coast/beach logic, "water" means the OCEAN - below sea level,
  // minus the tiny isolated dips the hydrology pass fills in (isOceanAt). Lakes/ponds/
  // rivers are added separately in computeTileAt. No edge anywhere (both axes wrap).
  if (gen.globe) return isOceanAt(c, r);
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
  // Water: globe uses the hydrology classifier (ocean/lake/pond/river/stream - one consistent
  // type per body); other worlds use the plain elevation test. All render as the existing
  // water tile (distinct river art can swap in later via data).
  if (gen.globe ? hydroClassAt(c, r) : isWaterAt(c, r)) return "water";
  // genVersion>=2: smooth, coherent highland regions (the upland heatmap, see
  // isHighland) become rocky ground - stone in the region cores (highest score), dirt
  // on the rim. Highland is buildable; trees/rocks require grass, so they avoid it.
  if (isHighland(c, r)) {
    const hd = gen.highlandDef;
    const hs = highlandScoreAt(c, r);
    // genVersion>=3: the top tier (>= mountainThresh) is a solid-stone MOUNTAIN peak (no dirt
    // rim) - a flat-iso massif; below it the highland foothills keep the stone-core/dirt-rim.
    if (gen.genVersion >= 3 && hs >= gen.mountainThresh) return hd.tileHigh || "stone";
    const stoneCore = (hd.stoneCore != null) ? hd.stoneCore : 0.4;
    const stoneAt = gen.highlandThresh + (1 - gen.highlandThresh) * (1 - stoneCore);
    return (hs >= stoneAt) ? (hd.tileHigh || "stone") : (hd.tileLow || "dirt");
  }
  const d = coastDist(c, r);
  // Globe cold band: no sandy beaches in the snow biome - the coast there is snow meeting
  // ice. Above sandSnow snowiness, skip sand so the cell stays grass (-> the snow gradient).
  const noBeach = gen.globe && snownessAt(c, r) > ((gen.climate.sandSnow != null) ? gen.climate.sandSnow : 0.3);
  // genVersion>=2: wider, solid beaches on gentle coasts - cells within beachTiles of
  // water whose ground sits barely above sea level (low landHeight). A steep coast
  // (elevation climbs fast -> high landHeight right at the shore) fails the height
  // test and keeps only the thin probabilistic sand band below.
  if (!noBeach && gen.genVersion >= 2 && gen.beachTiles > 0 && d <= gen.beachTiles &&
      landHeightAt(c, r) < gen.beachHeight) {
    return "sand";
  }
  if (!noBeach) {
    const sand = GD.worldgen.sandChance;
    const maxCoast = sand.length - 1;
    const p = (d >= 1 && d <= maxCoast) ? sand[d] : 0;
    if (p > 0 && hash01(c, r, gen.sandSeed) < p) return "sand";
  }
  return "grass";
}
// Baseline mineable encoding for a cell: a rock (typeIndex 0) takes precedence,
// then an ore vein, else -1. Mirrors the seedRocks -> seedMinerals order (ore
// ignored trees because the forest pass ran last, so trees are not consulted).
// genVersion>=3 rock/ore by ZONE: solid-stone mountain PEAKS are richest, highland foothills
// moderate, a desert OASIS a little (rock only), open grass just rare FIELDSTONE (rock only),
// and open desert / beaches barren. clumpRock/clumpMineral still shape the clusters; the zone
// only scales the fill and gates ore off the lowlands - so mining is a place you seek out.
function rockZonedAt(c, r, tile) {
  const rz = gen.rockZones;
  const hs = highlandScoreAt(c, r);
  const hi = isHighland(c, r);
  const h = G.world.hydro;
  const oasis = !!(gen.globe && h && h.oasisNear && h.oasisNear[hydroCoarse(c, r)]);
  let rockMul = 0, oreMul = 0, small = false;
  if (hi && hs >= gen.mountainThresh) { rockMul = rz.mountainRockMul; oreMul = rz.mountainOreMul; } // peak: big boulders
  else if (hi) { rockMul = rz.highlandRockMul; oreMul = rz.highlandOreMul; }                        // foothill: big boulders
  else if (oasis) { rockMul = rz.oasisRockMul; small = true; }                                      // oasis: small rock, no ore
  else if (gen.globe && desertAt(c, r) > 0.4) { /* open desert: barren */ }
  else if (tile === "grass" || tile === "sand") { rockMul = rz.fieldstoneMul; small = true; }       // open ground: small fieldstone, no ore
  if (rockMul > 0 && gen.rockDensity > 0) {
    const field = gen.clumpRock(c * gen.scaleR, r * gen.scaleR);
    if (field > gen.thresholdR) {
      const local = (field - gen.thresholdR) / (1 - gen.thresholdR);
      // Big mountain/highland boulders use rock variants 0-1; loose fieldstone (open ground
      // + oasis) the smaller variants 2-3 (rock_small_*).
      if (hash01(c, r, gen.rSeed) < gen.fillR * local * rockMul) {
        const base = small ? 2 : 0;
        return hash01(c, r, gen.vSeed) < 0.5 ? base : base + 1;
      }
    }
  }
  if (oreMul > 0 && gen.mineralDensity > 0) {
    const field = gen.clumpMineral(c * gen.scaleM, r * gen.scaleM);
    if (field > gen.thresholdM) {
      const local = (field - gen.thresholdM) / (1 - gen.thresholdM);
      if (hash01(c, r, gen.mFillSeed) < gen.fillM * local * oreMul) {
        const types = GD.worldgen.mineral.types;
        const ti = Math.floor(hash01(c, r, gen.tSeed) * types.length) % types.length;
        return encodeMineable(mineableTypeIndex(types[ti]), 0);
      }
    }
  }
  return -1;
}
function computeRockRawAt(c, r) {
  const tile = baseTileAt(c, r);
  if (tile === "water") return -1;                  // never on ocean / lake / river
  // genVersion>=3: rock + ore live on ROCKY ground (see rockZonedAt). Needs highland to
  // exist; with none, fall back to the legacy grass scatter so the world still has ore.
  // Older worlds (genVersion<3) keep the legacy path entirely.
  if (gen.genVersion >= 3 && gen.highlandThresh !== Infinity) return rockZonedAt(c, r, tile);
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
      const dMul = gen.globe ? (1 - desertAt(c, r) * gen.climate.desertRockCut) : 1; // fewer rocks in desert
      if (hash01(c, r, gen.rSeed) < gen.fillR * local * hMul * dMul) {
        return hash01(c, r, gen.vSeed) < 0.5 ? 0 : 1; // rock variant (typeIndex 0)
      }
    }
  }
  // Keep veins off the world edge. The torus globe + infinite worlds have no edge.
  const minInterior = (gen.infinite || gen.globe) ? true
    : (c >= 2 && r >= 2 && c < gen.cols - 2 && r < gen.rows - 2);
  if (gen.mineralDensity > 0 && tile === "grass" && minInterior) {
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
  // Cheapest, most common rejection FIRST: a tree needs bare GRASS, so test the tile
  // before the rock-layer probe. This skips the rock-noise eval on every water / dirt /
  // stone cell - a big saving for the growth sweep and the per-frame entity probe, which
  // both call stageAt on huge numbers of non-grass cells (ocean especially).
  const placeF = GD.objects.tree.placeableOn;
  if (baseTileAt(c, r) !== placeF.tile) return -1; // grass only (highland dirt/stone excluded)
  if (baseRockRawAt(c, r) >= 0) return -1;         // no tree where a rock/ore sits
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
  // Globe: cold thins the forest - full canopy down to taigaTemp, fading to bare tundra
  // at tundraTemp (the frozen belt has no trees).
  if (gen.globe) {
    const t = temperatureAt(c, r), cl = gen.climate;
    dens *= (t <= cl.tundraTemp) ? 0 : (t >= cl.taigaTemp) ? 1 : (t - cl.tundraTemp) / (cl.taigaTemp - cl.tundraTemp);
    dens *= 1 - desertAt(c, r) * cl.desertForestCut; // deserts are sparse
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
  if (gen.globe && (snownessAt(c, r) > 0.5 || desertAt(c, r) > 0.4)) return -1; // no flowers on snow or in desert
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

// --- Globe hydrology: rivers + lakes (torus) ---------------------------------
// Computed ONCE at world creation on a CAPPED-resolution coarse grid (so the cost is
// independent of world size), then snapped per-cell when a tile is sampled. A
// priority-flood fills closed basins into lakes + routes all land to the ocean; flow
// accumulation marks high-throughput cells as rivers. The torus has no edge, so the
// drain set is simply the ocean (cells below sea level). Regenerated on load (not saved).
const D8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const HYDRO_LAKE_EPS = 0.0015; // a basin counts as a lake once it pools this far above its floor

// Binary min-heap keyed by elevation (the priority-flood frontier).
function MinHeap(cap) { this.e = new Float32Array(cap); this.i = new Int32Array(cap); this.n = 0; }
MinHeap.prototype.push = function (e, i) {
  let k = this.n++; this.e[k] = e; this.i[k] = i;
  while (k > 0) { const p = (k - 1) >> 1; if (this.e[p] <= this.e[k]) break; this._sw(p, k); k = p; }
};
MinHeap.prototype.pop = function () {
  const ri = this.i[0]; this.n--;
  if (this.n > 0) {
    this.e[0] = this.e[this.n]; this.i[0] = this.i[this.n]; let k = 0;
    for (;;) {
      let l = 2 * k + 1, r = 2 * k + 2, m = k;
      if (l < this.n && this.e[l] < this.e[m]) m = l;
      if (r < this.n && this.e[r] < this.e[m]) m = r;
      if (m === k) break; this._sw(m, k); k = m;
    }
  }
  return ri;
};
MinHeap.prototype._sw = function (a, b) {
  const e = this.e[a]; this.e[a] = this.e[b]; this.e[b] = e;
  const i = this.i[a]; this.i[a] = this.i[b]; this.i[b] = i;
};

// Build the coarse hydrology overlay for a globe world -> G.world.hydro.
function buildHydrology() {
  const g = gen.globe;
  if (!g) { G.world.hydro = null; return; }
  const cols = gen.cols, rows = gen.rows;
  const hw = Math.min(cols, (g.hydroMax | 0) || 512);
  const hh = Math.max(2, Math.round(hw * rows / cols));
  const k = cols / hw;              // world cells per coarse cell (uniform: rows/hh === k)
  const n = hw * hh, sea = G.world.landThreshold;
  // Coarse elevation = the SAME continental field sampled at coarse-cell centers, so
  // rivers/lakes sit in the per-cell valleys (no domain-warp mismatch).
  const elev = new Float32Array(n);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) elev[y * hw + x] = computeElevationGlobe((x + 0.5) * k, (y + 0.5) * k);
  }
  // Per-coarse-cell desertness (hot + dry), sampled directly (not memoized, to spare the
  // cache). Deserts dry up: no channels form there, and basins are filled - bar a rare oasis.
  const desert = new Float32Array(n);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) desert[y * hw + x] = desertFrom(computeTemperature((x + 0.5) * k, (y + 0.5) * k), computeMoisture((x + 0.5) * k, (y + 0.5) * k));
  }
  const DESERT_DRY = gen.climate.desertDry;      // a cell/basin this desert gets no water
  const OASIS_CHANCE = gen.climate.oasisChance;  // fraction of desert basins kept as oases
  // Priority-flood with an EPSILON tilt (Barnes 2014): the microscopic gradient off
  // every flat/filled cell guarantees a downhill path, so flow accumulation forms real
  // rivers. Without it the filled basins are dead-flat and water never concentrates -
  // which is why rivers were missing. Torus: wrap both axes; ocean cells are the drains.
  const filled = new Float32Array(n), seen = new Uint8Array(n), heap = new MinHeap(n);
  const EPS = 1e-6;
  for (let i = 0; i < n; i++) if (elev[i] < sea) { filled[i] = elev[i]; seen[i] = 1; heap.push(elev[i], i); }
  if (heap.n === 0) { // near-100% land: seed the single lowest cell as the outlet
    let lo = 0; for (let i = 1; i < n; i++) if (elev[i] < elev[lo]) lo = i;
    filled[lo] = elev[lo]; seen[lo] = 1; heap.push(elev[lo], lo);
  }
  while (heap.n > 0) {
    const i = heap.pop(), x = i % hw, y = (i / hw) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = (x + D8[d][0] + hw) % hw, ny = (y + D8[d][1] + hh) % hh, ni = ny * hw + nx;
      if (seen[ni]) continue;
      seen[ni] = 1;
      filled[ni] = elev[ni] > filled[i] + EPS ? elev[ni] : filled[i] + EPS;
      heap.push(filled[ni], ni);
    }
  }
  // Flow accumulation (steepest descent on the filled surface, high -> low). A cell is a
  // CHANNEL once its drainage exceeds channelThreshold; width grows with sqrt(drainage)
  // -> streams (2 wide) on small flows, rivers (3+) on the trunks.
  const acc = new Float32Array(n).fill(1);
  const order = new Int32Array(n); for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => filled[b] - filled[a]);
  const riverDir = new Uint8Array(n), riverW = new Uint8Array(n);
  const chThr = (g.channelThreshold != null) ? g.channelThreshold : 60;
  const wScale = (g.riverWidthScale != null) ? g.riverWidthScale : 0.16;
  const maxW = (g.maxRiverWidth != null) ? g.maxRiverWidth : 5;
  // Minimum channel width 2: a 1-tile-wide diagonal run only meets at corners (in iso the
  // tiles share a vertex, not an edge), so it reads as disconnected diamonds. >=2 keeps
  // every diagonal pass edge-connected - the "2x2 connecting sections".
  const minW = (g.minRiverWidth != null) ? g.minRiverWidth : 2;
  for (let o = 0; o < n; o++) {
    const i = order[o]; if (elev[i] < sea) continue; // ocean does not route
    const x = i % hw, y = (i / hw) | 0;
    let best = -1, bestF = filled[i], bestDir = 0;
    for (let d = 0; d < 8; d++) {
      const nx = (x + D8[d][0] + hw) % hw, ny = (y + D8[d][1] + hh) % hh, ni = ny * hw + nx;
      if (filled[ni] < bestF) { bestF = filled[ni]; best = ni; bestDir = d + 1; }
    }
    if (best >= 0) {
      if (acc[i] > chThr && desert[i] < DESERT_DRY) { riverDir[i] = bestDir; riverW[i] = Math.max(minW, Math.min(maxW, Math.round(Math.sqrt(acc[i]) * wScale))); } // no streams in desert
      acc[best] += acc[i];
    }
  }
  // Lake surface level per coarse cell (sentinel where it is not a pooled basin).
  const lakeLevel = new Float32Array(n);
  for (let i = 0; i < n; i++) lakeLevel[i] = (filled[i] > elev[i] + HYDRO_LAKE_EPS) ? filled[i] : -1e9;
  // Still-water connected components (torus 4-conn): classify each body by size into
  // ocean / lake / pond, fill only the tiniest. Channels (thin) are excluded here.
  const isStill = (i) => elev[i] < sea || filled[i] > elev[i] + HYDRO_LAKE_EPS;
  const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    const i = y * hw + x; if (!isStill(i)) continue;
    const ri = y * hw + (x + 1) % hw; if (isStill(ri)) { const a = find(i), b = find(ri); if (a !== b) parent[a] = b; }
    const di = ((y + 1) % hh) * hw + x; if (isStill(di)) { const a = find(i), b = find(di); if (a !== b) parent[a] = b; }
  }
  const size = new Map(); let largest = -1, largestSz = 0;
  for (let i = 0; i < n; i++) { if (!isStill(i)) continue; const r = find(i), s = (size.get(r) || 0) + 1; size.set(r, s); if (s > largestSz) { largestSz = s; largest = r; } }
  const pondMinT = (g.pondMinTiles != null) ? g.pondMinTiles : 4;
  const lakeMinT = (g.lakeMinTiles != null) ? g.lakeMinTiles : 35;
  const oceanMinCoarse = Math.max(1, Math.round(((g.oceanMinTiles != null) ? g.oceanMinTiles : 2500) / (k * k)));
  // Lake vs pond is by ACTUAL water-tile count, not coarse cells: a basin only fills the part
  // of each coarse cell below its surface, so the coarse footprint overcounts. The ocean (the
  // largest / very large body) is taken by coarse size; every other still body has its real
  // water tiles counted within its coarse footprint (cheap - lakes/ponds are small + few).
  const isOcean = (root) => (root === largest || size.get(root) >= oceanMinCoarse);
  const compTiles = new Map();  // component root -> actual water-tile count (non-ocean bodies)
  const compDesert = new Map(); // component root -> summed coarse desertness (desert/oasis test)
  for (let cy = 0; cy < hh; cy++) {
    for (let cx = 0; cx < hw; cx++) {
      const i = cy * hw + cx; if (!isStill(i)) continue;
      const root = find(i); if (isOcean(root)) continue;
      compDesert.set(root, (compDesert.get(root) || 0) + desert[i]);
      const level = Math.max(sea, lakeLevel[i]); // a tile is water where its elevation < this
      const c0 = Math.ceil(cx * k), c1 = Math.ceil((cx + 1) * k), r0 = Math.ceil(cy * k), r1 = Math.ceil((cy + 1) * k);
      let cnt = 0;
      for (let wr = r0; wr < r1; wr++) for (let wc = c0; wc < c1; wc++) if (computeElevationGlobe(wc, wr) < level) cnt++;
      if (cnt) compTiles.set(root, (compTiles.get(root) || 0) + cnt);
    }
  }
  // A basin sitting in the desert is FILLED in (deserts are dry) - unless a rare hash keeps it
  // as an OASIS (the water stays + gets a green ring via oasisNear below).
  const oasisRoots = new Set(), desertFill = new Set();
  for (const root of size.keys()) {
    if (isOcean(root)) continue;
    if ((compDesert.get(root) || 0) / Math.max(1, size.get(root)) <= DESERT_DRY) continue; // not a desert basin
    if (hash01(root, 0x0a515, (gen.s ^ 0x0a515ace) >>> 0) < OASIS_CHANCE) oasisRoots.add(root); else desertFill.add(root);
  }
  const bodyClass = new Uint8Array(n); // still-body class: 0 none, 1 ocean, 2 lake, 3 pond, 4 fill
  for (let i = 0; i < n; i++) {
    if (!isStill(i)) continue;
    const root = find(i);
    if (isOcean(root)) { bodyClass[i] = 1; continue; }
    if (desertFill.has(root)) { bodyClass[i] = 4; continue; } // dried-up desert basin -> land
    const t = compTiles.get(root) || 0;
    bodyClass[i] = (t >= lakeMinT) ? 2 : (t >= pondMinT) ? 3 : 4;
  }
  // Channel systems: connect channel cells along their flow; the WHOLE network is one type
  // (river if it reaches >= 3 wide anywhere, else stream), so a single channel never flips
  // stream<->river along its length.
  const csParent = new Int32Array(n); for (let i = 0; i < n; i++) csParent[i] = i;
  const csFind = (a) => { while (csParent[a] !== a) { csParent[a] = csParent[csParent[a]]; a = csParent[a]; } return a; };
  for (let i = 0; i < n; i++) {
    const dir = riverW[i] && riverDir[i]; if (!dir) continue;
    const x = i % hw, y = (i / hw) | 0;
    const ni = ((y + D8[dir - 1][1] + hh) % hh) * hw + (x + D8[dir - 1][0] + hw) % hw;
    if (riverW[ni]) { const a = csFind(i), b = csFind(ni); if (a !== b) csParent[a] = b; }
  }
  const sysMaxW = new Map();
  for (let i = 0; i < n; i++) { if (!riverW[i]) continue; const r = csFind(i); if (riverW[i] > (sysMaxW.get(r) || 0)) sysMaxW.set(r, riverW[i]); }
  // UNIFIED water type per coarse cell - the single source of truth the per-cell classifier
  // reads, so every tile of a body shares one class. Precedence ocean > lake > channel > pond
  // (a channel crossing a small basin is the river, not a pond).
  const waterType = new Uint8Array(n); // 0 land, 1 ocean, 2 lake, 3 pond, 4 river, 5 stream
  for (let i = 0; i < n; i++) {
    const bc = bodyClass[i];
    if (bc === 1) waterType[i] = 1;
    else if (bc === 2) waterType[i] = 2;
    else if (riverW[i]) waterType[i] = (sysMaxW.get(csFind(i)) >= 3) ? 4 : 5;
    else if (bc === 3) waterType[i] = 3;
  }
  // Ocean adjacency: a land coarse cell that touches the ocean keeps its per-cell coves;
  // isolated sub-cell dips (no ocean nearby) get filled to land instead of faux-ocean.
  const oceanNear = new Uint8Array(n);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    const i = y * hw + x;
    if (waterType[i] === 1 ||
        waterType[y * hw + (x + 1) % hw] === 1 || waterType[y * hw + (x + hw - 1) % hw] === 1 ||
        waterType[((y + 1) % hh) * hw + x] === 1 || waterType[((y + hh - 1) % hh) * hw + x] === 1) oceanNear[i] = 1;
  }
  // Oasis green ring: mark each kept-oasis coarse cell + its 4-neighbors so desertAt reads
  // them as not-desert (grass + a few trees/foliage around the rare desert water).
  const oasisNear = new Uint8Array(n);
  if (oasisRoots.size) {
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
      const i = y * hw + x;
      if (!isStill(i) || !oasisRoots.has(find(i))) continue;
      oasisNear[i] = 1;
      oasisNear[y * hw + (x + 1) % hw] = 1; oasisNear[y * hw + (x + hw - 1) % hw] = 1;
      oasisNear[((y + 1) % hh) * hw + x] = 1; oasisNear[((y + hh - 1) % hh) * hw + x] = 1;
    }
  }
  G.world.hydro = { hw, hh, k, waterType, lakeLevel, riverDir, riverW, oceanNear, oasisNear };
}

// Point-to-segment distance (coarse-grid units), for snapping a cell to a river path.
function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}
// Map a world cell to its coarse hydrology cell index (torus-wrapped).
function hydroCoarse(c, r) {
  const h = G.world.hydro;
  const cx = ((Math.floor(c / h.k) % h.hw) + h.hw) % h.hw;
  const cy = ((Math.floor(r / h.k) % h.hh) + h.hh) % h.hh;
  return cy * h.hw + cx;
}
// Ocean (the open sea) at this cell: below sea level, in (or touching) an ocean coarse
// cell. Coastal coves count; isolated below-sea dips are filled to land. Light (no channel
// scan) so the coast/beach logic can call it freely.
function isOceanAt(c, r) {
  if (elevationAt(c, r) >= G.world.landThreshold) return false;
  const h = G.world.hydro; if (!h) return true; // before the hydrology pass runs
  const ci = hydroCoarse(c, r), wt = h.waterType[ci];
  if (wt === 1) return true;
  if (wt === 0) return h.oceanNear[ci] === 1;
  return false; // lake/pond/river/stream coarse cell -> not the open ocean
}
// The channel class covering this cell - "river" | "stream" | null - read from the matched
// coarse channel cell's SYSTEM type (so it is consistent along the whole channel). Snaps to
// the coarse flow-path in a 5x5 neighborhood; torus-wrapped, geometry stays continuous.
function channelClassAt(c, r) {
  const h = G.world.hydro; if (!h) return null;
  const gx = c / h.k, gy = r / h.k, gxi = Math.floor(gx), gyi = Math.floor(gy);
  let stream = false;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const bx = gxi + dx, by = gyi + dy;
      const ci = (((by % h.hh) + h.hh) % h.hh) * h.hw + (((bx % h.hw) + h.hw) % h.hw);
      const w = h.riverW[ci]; if (!w) continue;
      const dd = D8[h.riverDir[ci] - 1];
      if (distToSeg(gx, gy, bx + 0.5, by + 0.5, bx + 0.5 + dd[0], by + 0.5 + dd[1]) < (w * 0.5) / h.k) {
        if (h.waterType[ci] === 4) return "river"; // river outranks stream when both are near
        stream = true;
      }
    }
  }
  return stream ? "stream" : null;
}
// THE per-cell water classification (single source of truth): ocean | lake | pond | river |
// stream | null. The TYPE comes from the coarse waterType (so a whole body is one class); the
// EXTENT is per-cell (crisp shores for bodies, the path for channels). Used by both
// computeTileAt (is it water?) and the debug overlay.
export function hydroClassAt(c, r) {
  const h = G.world.hydro; if (!h || !gen || !gen.globe) return null;
  const ci = hydroCoarse(c, r), wt = h.waterType[ci], e = elevationAt(c, r), sea = G.world.landThreshold;
  if (wt === 1) { if (e < sea) return "ocean"; }                  // ocean body (below sea level)
  else if (wt === 2 || wt === 3) {                                // lake / pond body
    if (e < sea || (h.lakeLevel[ci] > -1e8 && e < h.lakeLevel[ci])) return wt === 2 ? "lake" : "pond";
  }
  const ch = channelClassAt(c, r);                                // river / stream channel
  if (ch) return ch;
  if (wt === 0 && e < sea && h.oceanNear[ci] === 1) return "ocean"; // coastal cove in a land cell
  return null;
}

// --- Delta overlay -----------------------------------------------------------
// G.world.mods is a NESTED map (Map<col, Map<row, entry>>) keyed by integers, so a
// cell lookup builds no string (the old "c,r" key was allocated on every accessor
// call - tileAt/stageAt/... run per visible cell per frame). Nested maps also handle
// the unbounded/negative coords of infinite worlds, which a packed numeric key can't.
// Globe edits are keyed by CANONICAL coord (wrapCol/wrapRow), so one edit shows on
// every wrapped copy and is stored once. The save format stays the flat "c,r" array
// (see modsToEntries/modsFromEntries) for backward/forward compatibility.
function entryAt(c, r) {
  const m = G.world.mods;
  if (m.size === 0) return undefined;            // no columns edited yet
  const cm = m.get(wrapCol(c));
  return cm === undefined ? undefined : cm.get(wrapRow(r));
}
function ensureEntry(c, r) {
  const m = G.world.mods, col = wrapCol(c), row = wrapRow(r);
  let cm = m.get(col);
  if (cm === undefined) { cm = new Map(); m.set(col, cm); }
  let e = cm.get(row);
  if (e === undefined) { e = {}; cm.set(row, e); }
  return e;
}

// --- Delta-overlay helpers (used by persistence.js + the debug overlay) -------
export function createMods() { return new Map(); }                 // empty nested overlay
export function modsSize(m) { let n = 0; for (const cm of m.values()) n += cm.size; return n; }
function modsSetRaw(m, c, r, e) {                                   // c,r already canonical/raw
  let cm = m.get(c);
  if (cm === undefined) { cm = new Map(); m.set(c, cm); }
  cm.set(r, e);
}
export function modsSetCell(m, c, r, e) { modsSetRaw(m, c, r, e); } // legacy-array migration
// Flatten to the on-disk save shape: [["c,r", entry], ...] (unchanged across versions).
export function modsToEntries(m) {
  const out = [];
  for (const [c, cm] of m) for (const [r, e] of cm) out.push([c + "," + r, e]);
  return out;
}
// Rebuild the nested overlay from a saved [["c,r", entry], ...] array.
export function modsFromEntries(arr) {
  const m = new Map();
  if (Array.isArray(arr)) {
    for (const pair of arr) {
      const k = pair[0], e = pair[1];
      const ci = ("" + k).indexOf(",");
      modsSetRaw(m, +k.slice(0, ci), +k.slice(ci + 1), e);
    }
  }
  return m;
}

// Clamp a cell-range box to the world. Finite worlds clamp to [0,cols/rows-1];
// infinite worlds pass through unchanged (any coordinate is valid).
export function clampBox(c0, c1, r0, r1) {
  if (G.world.infinite) return { c0, c1, r0, r1 };
  // A WRAPPING axis is not clamped (callers read through the wrapping accessors /
  // draw at the raw coordinate); a bounded axis clamps to its edge. The torus globe
  // wraps both; a finite/flat world clamps both.
  return {
    c0: G.world.wrapX ? c0 : Math.max(0, c0),
    c1: G.world.wrapX ? c1 : Math.min(G.world.cols - 1, c1),
    r0: G.world.wrapY ? r0 : Math.max(0, r0),
    r1: G.world.wrapY ? r1 : Math.min(G.world.rows - 1, r1),
  };
}

export function tileAt(c, r) { const e = entryAt(c, r); return (e && e.t !== undefined) ? e.t : baseTileAt(c, r); }
export function stageAt(c, r) { const e = entryAt(c, r); return (e && e.st !== undefined) ? e.st : baseStageAt(c, r); }
export function progressAt(c, r) { const e = entryAt(c, r); return (e && e.pr !== undefined) ? e.pr : baseProgressAt(c, r); }
export function chopAt(c, r) { const e = entryAt(c, r); return (e && e.ch !== undefined) ? e.ch : 0; }
export function rockRawAt(c, r) { const e = entryAt(c, r); return (e && e.rk !== undefined) ? e.rk : baseRockRawAt(c, r); }

// Diagnostics for the debug overlay.
export function baseCacheSize() { return baseCacheCount; }

export function setTile(c, r, v) { ensureEntry(c, r).t = v; }
export function setStage(c, r, v) { ensureEntry(c, r).st = v; }
export function setProgress(c, r, v) { ensureEntry(c, r).pr = v; }
export function setChop(c, r, v) { ensureEntry(c, r).ch = v; }
export function setRockRaw(c, r, v) { ensureEntry(c, r).rk = v; }

// Growth-tick fast path. The sim's growthTick used to call stageAt + progressAt +
// setStage + setProgress per cell - four keyed Map lookups (each building a "c,r"
// string) for the same cell, 20x/sec across the whole priority disc + every
// building radius. This folds them into ONE entry lookup (and one set only when
// the cell actually grows): read stage/progress (override or baseline), bail if
// non-growable, advance, write both fields back into the same entry object.
// `gainMul` is the precomputed gain for AMORTIZED bands; EXACT bands derive their
// gain from growthStep here. Semantics are identical to the old grow() closure.
export function growCell(c, r, mature, stageFull, gainMul, exact, t, seed, g) {
  const mods = G.world.mods, col = wrapCol(c), row = wrapRow(r);
  let cm, e;
  if (mods.size > 0) { cm = mods.get(col); if (cm !== undefined) e = cm.get(row); }
  const st = (e && e.st !== undefined) ? e.st : baseStageAt(c, r);
  if (st < 0 || st >= mature) return;
  const gain = exact ? growthStep(c, r, t, seed) : gainMul;
  if (gain <= 0) return;
  let pr = ((e && e.pr !== undefined) ? e.pr : baseProgressAt(c, r)) + gain * g;
  let stage = st;
  if (exact) {
    if (pr >= stageFull) { stage = st + 1; pr = 0; }
  } else {
    while (pr >= stageFull && stage < mature) { stage++; pr -= stageFull; }
    if (stage >= mature) { stage = mature; pr = 0; }
  }
  if (!e) {
    if (cm === undefined) { cm = new Map(); mods.set(col, cm); }
    e = {}; cm.set(row, e);
  }
  e.st = stage; e.pr = pr;
}
