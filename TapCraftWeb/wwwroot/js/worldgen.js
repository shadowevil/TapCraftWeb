// TapCraft - world generation (terrain, rocks, forest) and transients reset.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { hash01, makeFbm, makeLayer, inBounds } from "./rng.js";
import { setMineable, hasMineable } from "./mineable.js";
import { updateResourceUI } from "./ui.js";
import { updateCraftedHud } from "./crafting.js";

// --- Generation -------------------------------------------------------
export function generate(cols, rows, seed, settings) {
  G.world.cols = cols;
  G.world.rows = rows;
  G.world.seed = seed >>> 0;
  G.world.settings = { ...settings };
  G.world.tick = 0;
  G.world.tiles = makeLayer(cols, rows, "water");
  G.world.stage = makeLayer(cols, rows, -1);
  G.world.progress = makeLayer(cols, rows, 0);
  G.world.chop = makeLayer(cols, rows, 0);
  G.world.rock = makeLayer(cols, rows, -1);
  G.world.wood = 0;
  G.world.stone = 0;
  G.world.iron = 0;
  G.world.gold = 0;
  G.world.iron_ingot = 0;
  G.world.gold_ingot = 0;
  G.world.tools = newTools();
  G.world.craft = {};
  G.world.buildings = [];
  resetTransients();
  generateTerrain();
  seedRocks();      // rocks first
  seedMinerals();   // ore veins next (also on the mineable layer, avoid rocks)
  seedForest();     // forest avoids any mineable cell
  G.hasWorld = true;
  updateResourceUI();
  updateCraftedHud();
}

export function newTools() {
  const t = {};
  for (const k of Object.keys(GD.tools)) t[k] = { count: 0, dura: 0 };
  return t;
}

export function resetTransients() {
  G.pops.clear();
  G.chopResets.clear();
  G.drops = [];
  G.buildWork = {};       // per-building worker/sweep/rate runtime, rebuilt lazily
  G.selectedBuilding = null;
  G.hoverBuilding = null;
  G.buildMode = null;
}

export function generateTerrain() {
  const cols = G.world.cols, rows = G.world.rows, s = G.world.seed;
  const base = makeFbm(s, 6);
  const warpXn = makeFbm((s ^ 0x9e3779b9) >>> 0, 4);
  const warpYn = makeFbm((s ^ 0x85ebca6b) >>> 0, 4);
  const baseScale = 0.045, warpScale = 0.08, warpAmt = 22;
  const contrast = 1.5, falloffExp = 2.4, falloffMul = 1.0;
  const v = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = c + (warpXn(c * warpScale, r * warpScale) * 2 - 1) * warpAmt;
      const wy = r + (warpYn(c * warpScale, r * warpScale) * 2 - 1) * warpAmt;
      let e = base(wx * baseScale, wy * baseScale);
      e = (e - 0.5) * contrast + 0.5;
      const nx = (wx / (cols - 1) - 0.5) * 2;
      const ny = (wy / (rows - 1) - 0.5) * 2;
      const d = Math.min(1, Math.hypot(nx, ny));
      v[r * cols + c] = e - Math.pow(d, falloffExp) * falloffMul;
    }
  }
  const sorted = Float64Array.from(v).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - G.world.settings.landFraction) * sorted.length)));
  const threshold = sorted[idx];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      G.world.tiles[r][c] = v[r * cols + c] >= threshold ? "grass" : "water";
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r < 2 || c < 2 || r >= rows - 2 || c >= cols - 2) G.world.tiles[r][c] = "water";
    }
  }
  // Beaches: sand near the coast, fading inland.
  const SAND_CHANCE = GD.worldgen.sandChance;
  const maxCoast = SAND_CHANCE.length - 1;
  const dist = new Int32Array(cols * rows).fill(-1);
  const queue = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (G.world.tiles[r][c] === "water") { const i = r * cols + c; dist[i] = 0; queue.push(i); }
    }
  }
  const N4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    if (dist[i] >= maxCoast) continue;
    const cc = i % cols, rr = (i - cc) / cols;
    for (const [dc, dr] of N4) {
      const nc = cc + dc, nr = rr + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (dist[ni] !== -1) continue;
      dist[ni] = dist[i] + 1; queue.push(ni);
    }
  }
  const sandSeed = (s ^ 0x27d4eb2f) >>> 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (G.world.tiles[r][c] !== "grass") continue;
      const d = dist[r * cols + c];
      const p = d >= 1 && d <= maxCoast ? SAND_CHANCE[d] : 0;
      if (p > 0 && hash01(c, r, sandSeed) < p) G.world.tiles[r][c] = "sand";
    }
  }
}

// True only when the 8 surrounding tiles are all grass (deep interior).
export function grassSurrounded(col, row) {
  if (G.world.tiles[row][col] !== "grass") return false;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nc = col + dc, nr = row + dr;
      if (!inBounds(nc, nr) || G.world.tiles[nr][nc] !== "grass") return false;
    }
  }
  return true;
}

// Weighted random starting stage for a newly seeded tree.
export function pickInitialStage(c, r, s) {
  const weights = GD.worldgen.initialStageWeights;
  const u = hash01(c, r, (s ^ 0x3c6ef35f) >>> 0);
  let acc = 0;
  for (let st = 0; st < weights.length; st++) {
    acc += weights[st];
    if (u < acc) return st;
  }
  return GD.matureStage;
}

// Seed stone clusters on grass: a low-frequency clump field decides where
// clusters are, then a per-cell roll (densest at a clump's core) scatters
// individual rocks. Two sprite variants for variety. Grass-only.
export function seedRocks() {
  const cols = G.world.cols, rows = G.world.rows, s = G.world.seed;
  const density = G.world.settings.rockDensity;
  const cluster = G.world.settings.rockCluster;
  if (density <= 0) return;
  const rock = GD.worldgen.rock;
  const placeOn = GD.objects.rock.placeableOn;
  const clump = makeFbm((s ^ 0x51ed2701) >>> 0, 3);
  const rSeed = (s ^ 0x1f83d9ab) >>> 0;
  const vSeed = (s ^ 0x7f4a7c15) >>> 0;
  // Higher cluster -> lower frequency -> bigger, fewer clumps.
  const scale = rock.scaleTight + (rock.scaleSpread - rock.scaleTight) * cluster;
  // Higher density -> lower threshold (more clumped area) + higher core fill.
  const threshold = rock.thresholdBase - rock.thresholdDensityFactor * density;
  const fill = rock.fillMax * density;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (G.world.tiles[r][c] !== placeOn.tile) continue;
      if (placeOn.requireInterior && !grassSurrounded(c, r)) continue;
      const field = clump(c * scale, r * scale);
      if (field <= threshold) continue;
      const local = (field - threshold) / (1 - threshold);
      if (hash01(c, r, rSeed) < fill * local) {
        // Stone rock = mineable typeIndex 0, variant 0/1 (unchanged encoding).
        G.world.rock[r][c] = hash01(c, r, vSeed) < 0.5 ? 0 : 1;
      }
    }
  }
}

// Seed ore veins (iron, gold) on empty grass via a clump field driven by the
// "mineral" slider, then GUARANTEE each type's minCount by force-placing any
// shortfall on random eligible cells. Veins share the mineable layer with rocks
// and never overwrite a rock. Deterministic from the world seed.
export function seedMinerals() {
  const cols = G.world.cols, rows = G.world.rows, s = G.world.seed;
  const density = G.world.settings.mineral != null ? G.world.settings.mineral : 0.4;
  const cfg = GD.worldgen.mineral;
  const types = cfg.types || [];
  const clump = makeFbm((s ^ 0x2c1b3a9f) >>> 0, 3);
  const scale = cfg.scaleTight + (cfg.scaleSpread - cfg.scaleTight) * density;
  const threshold = cfg.thresholdBase - cfg.thresholdDensityFactor * density;
  const fill = cfg.fillMax * density;

  // Eligibility: a placeable, empty (no rock/ore/tree) grass cell.
  const eligible = (c, r) => {
    if (!inBounds(c, r)) return false;
    if (G.world.tiles[r][c] !== "grass") return false;
    if (hasMineable(c, r)) return false;
    if (G.world.stage[r][c] >= 0) return false;
    // keep off the very edge (matches the 2-tile water border)
    return c >= 2 && r >= 2 && c < cols - 2 && r < rows - 2;
  };

  const placed = {}; // typeId -> count
  for (const t of types) placed[t] = 0;

  // Noise pass: scatter veins; pick a type per cell by a hash so iron/gold mix.
  const tSeed = (s ^ 0x6b43a9c7) >>> 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!eligible(c, r)) continue;
      const field = clump(c * scale, r * scale);
      if (field <= threshold) continue;
      const local = (field - threshold) / (1 - threshold);
      if (hash01(c, r, (s ^ 0x10a4f2bd) >>> 0) >= fill * local) continue;
      const ti = Math.floor(hash01(c, r, tSeed) * types.length) % types.length;
      const typeId = types[ti];
      setMineable(c, r, typeId, 0);
      placed[typeId]++;
    }
  }

  // Guarantee minCount per type: deterministically force-place any shortfall.
  for (const typeId of types) {
    const need = (GD.objects[typeId].minCount | 0) - (placed[typeId] | 0);
    for (let k = 0; k < need; k++) {
      const cell = findEligibleCell(eligible, (s ^ 0x9e3b1c77) + typeId.length * 131 + k * 2654435761);
      if (cell) { setMineable(cell.c, cell.r, typeId, 0); placed[typeId]++; }
    }
  }
}

// Deterministically scan for the first eligible cell starting from a seeded
// pseudo-random offset (so guaranteed veins are not always in a corner).
function findEligibleCell(eligible, seedVal) {
  const cols = G.world.cols, rows = G.world.rows, total = cols * rows;
  const start = (Math.abs(seedVal | 0) % total + total) % total;
  for (let i = 0; i < total; i++) {
    const idx = (start + i * 2654435761) % total; // stride by a large odd-ish step
    const c = idx % cols, r = (idx - c) / cols;
    if (eligible(c, r)) return { c, r };
  }
  return null;
}

// Seed forests on eligible grass; trees start at varied stages/progress.
export function seedForest() {
  const cols = G.world.cols, rows = G.world.rows, s = G.world.seed;
  const density = G.world.settings.forestDensity;
  const cluster = G.world.settings.cluster;
  if (density <= 0) return;
  const placeOn = GD.objects.tree.placeableOn;
  const fNoise = makeFbm((s ^ 0x1b56c4e9) >>> 0, 4);
  const fSeed = (s ^ 0x632be59b) >>> 0;
  const fScale = 0.14;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (G.world.rock[r][c] >= 0) continue; // no tree where a rock sits
      if (G.world.tiles[r][c] !== placeOn.tile) continue;
      if (placeOn.requireInterior && !grassSurrounded(c, r)) continue;
      const rnd = hash01(c, r, fSeed);
      const noise = fNoise(c * fScale, r * fScale);
      const score = rnd * (1 - cluster) + noise * cluster;
      if (score > 1 - density) {
        const st = pickInitialStage(c, r, s);
        G.world.stage[r][c] = st;
        G.world.progress[r][c] = st >= GD.matureStage ? 0 : hash01(c, r, (s ^ 0x2545f491) >>> 0) * GD.worldgen.stageFull;
      }
    }
  }
}
