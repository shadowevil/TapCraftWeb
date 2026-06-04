// TapCraft - ecology: resource spreading (and with it, scarcity).
//
// Trees no longer regrow when felled and forage bushes never respawn in place -
// the ONLY way the world replenishes is SPREADING: a mature tree occasionally
// seeds a sprout into a nearby eligible cell, and a live grass patch (the wheat
// seed bush) occasionally spawns a new patch nearby. Chop faster than the
// forest seeds and you get deforestation; leave a grove alone and it slowly
// creeps outward. Rocks/ore veins do NOT spread - they are finite, full stop
// (see resources.harvestMine).
//
// Driven from the growth tick: sim.growthTick already visits every cell in the
// priority bands (and every building's harvest radius) and growCell returns the
// cell's effective stage - maybeSpread() rides that visit, so spreading obeys
// the same locality rule as growth (the ecology evolves near the player and
// around buildings; distant land is frozen until visited). The roll runs FIRST
// and is almost always a miss, so the per-cell cost is one Math.random.
//
// All tuning is data: GD.objects.tree.spread / GD.objects.grass_patch.spread =
//   { radius:    seed reach in tiles (random cell in the (2R+1)^2 box),
//     avgMinutes: average REAL minutes between seed attempts per source,
//     maxNeighbors: density cap - skip targets whose 8-neighborhood already
//                   holds more than this many of the same kind }.
// A failed attempt (ineligible target / too dense) is simply lost, which makes
// crowded or blocked areas self-throttle.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { TICK_MS } from "./config.js";
import { inBounds } from "./rng.js";
import {
  tileAt, stageAt, setStage, setProgress, rockRawAt,
  decorIdxAt, setDecorSpawned, snownessAt, desertAt,
  wrapCol, wrapRow,
} from "./cells.js";
import { patchAt } from "./farming.js";

// Per-tick probabilities + configs, derived once from the pack (refreshed on a
// dev pack reload). p = chance per source per tick; amortized growth bands pass
// their period as `mult` so the expected rate is band-independent.
let inited = false, treeCfg = null, bushCfg = null, pTree = 0, pBush = 0;
function refresh() {
  treeCfg = (GD.objects && GD.objects.tree && GD.objects.tree.spread) || null;
  bushCfg = (GD.objects && GD.objects.grass_patch && GD.objects.grass_patch.spread) || null;
  pTree = (treeCfg && treeCfg.avgMinutes > 0) ? (TICK_MS / 60000) / treeCfg.avgMinutes : 0;
  pBush = (bushCfg && bushCfg.avgMinutes > 0) ? (TICK_MS / 60000) / bushCfg.avgMinutes : 0;
  inited = true;
}
window.addEventListener("tapcraft:packreload", () => { inited = false; });

// One spread consideration for a cell the growth tick just visited. `st` is
// growCell's returned stage: undefined = farm cell (never a source), >= mature
// = a tree that may seed, < 0 = empty ground that may host a live forage patch.
export function maybeSpread(c, r, st, mult) {
  if (st === undefined) return;
  if (!inited) refresh();
  if (st >= GD.matureStage) {
    if (pTree > 0 && Math.random() < pTree * mult) trySpreadTree(c, r);
  } else if (st < 0) {
    // Roll BEFORE the (heavier) patch probe: almost every empty cell misses.
    if (pBush > 0 && Math.random() < pBush * mult && patchAt(c, r) >= 0) trySpreadBush(c, r);
  }
}

// A uniformly random non-centre offset in the (2R+1)^2 box.
function pickOffset(R) {
  const dx = ((Math.random() * (2 * R + 1)) | 0) - R;
  const dy = ((Math.random() * (2 * R + 1)) | 0) - R;
  return (dx === 0 && dy === 0) ? null : [dx, dy];
}

// Is (c,r) within `range` tiles (CHEBYSHEV - diagonals count like straights) of
// any placed building's footprint? Drives the propagation clearance: nothing
// SEEDS and nothing TAKES ROOT this close to player construction - what is
// already growing there stays (it exists, it just cannot propagate). range 0
// still covers the footprint itself. Wrapped axes measure the nearest copy.
function nearBuilding(c, r, range) {
  const list = G.world.buildings;
  if (!list || !list.length) return false;
  const cc = wrapCol(c), rr = wrapRow(r);
  const cols = G.world.cols, rows = G.world.rows;
  for (const b of list) {
    const fp = (GD.buildings[b.type] && GD.buildings[b.type].footprint) || { w: 2, h: 2 };
    let dc, dr;
    if (G.world.wrapX) {
      let d = (((cc - b.col) % cols) + cols) % cols; // 0..cols-1 offset from the rect's west edge
      if (d > cols / 2) d -= cols;                   // nearest signed offset (torus)
      dc = d < 0 ? -d : (d > fp.w - 1 ? d - (fp.w - 1) : 0);
    } else {
      dc = Math.max(b.col - cc, 0, cc - (b.col + fp.w - 1));
    }
    if (dc > range) continue;
    if (G.world.wrapY) {
      let d = (((rr - b.row) % rows) + rows) % rows;
      if (d > rows / 2) d -= rows;
      dr = d < 0 ? -d : (d > fp.h - 1 ? d - (fp.h - 1) : 0);
    } else {
      dr = Math.max(b.row - rr, 0, rr - (b.row + fp.h - 1));
    }
    if (Math.max(dc, dr) <= range) return true;
  }
  return false;
}
function clearanceOf(sp) { return (sp.buildingClearance != null) ? sp.buildingClearance : 5; }
function treesAround(c, r) {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if ((dc || dr) && stageAt(c + dc, r + dr) >= 0) n++;
    }
  }
  return n;
}
function bushesAround(c, r) {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if ((dc || dr) && patchAt(c + dc, r + dr) >= 0) n++;
    }
  }
  return n;
}

// Seed a sprout near a mature tree. Target: bare grass (no object/mineable/
// forage bush/tilled soil - tilled tiles are not "grass") that is not already
// crowded. Flowers are fair game (the tree simply grows over them). BUILDING
// CLEARANCE blocks both ends: a source this close to construction cannot seed,
// and a target this close cannot take root (existing flora merely persists).
function trySpreadTree(c, r) {
  const sp = treeCfg;
  const range = clearanceOf(sp);
  if (nearBuilding(c, r, range)) return;     // source inside the clearance: exists, never propagates
  const off = pickOffset((sp.radius | 0) || 3);
  if (!off) return;
  const tc = c + off[0], tr = r + off[1];
  if (!inBounds(tc, tr)) return;
  if (tileAt(tc, tr) !== "grass") return;
  if (stageAt(tc, tr) >= 0 || rockRawAt(tc, tr) >= 0) return;
  if (patchAt(tc, tr) >= 0) return;          // never plant over a forage bush
  if (nearBuilding(tc, tr, range)) return;   // target inside the clearance of any building
  if (treesAround(tc, tr) > ((sp.maxNeighbors != null) ? sp.maxNeighbors : 3)) return;
  setStage(tc, tr, 0);
  setProgress(tc, tr, 0);
}

// Spawn a new forage patch near a live one. Target: bare grass showing NO decor
// (existing flowers/patches are kept), outside snow/desert (mirrors the base
// decor biome rule), not crowded with other patches. Same two-ended building
// clearance as the trees.
function trySpreadBush(c, r) {
  const sp = bushCfg;
  const range = clearanceOf(sp);
  if (nearBuilding(c, r, range)) return;     // source inside the clearance: exists, never propagates
  const off = pickOffset((sp.radius | 0) || 3);
  if (!off) return;
  const tc = c + off[0], tr = r + off[1];
  if (!inBounds(tc, tr)) return;
  if (tileAt(tc, tr) !== "grass") return;
  if (stageAt(tc, tr) >= 0 || rockRawAt(tc, tr) >= 0) return;
  if (decorIdxAt(tc, tr) >= 0) return;
  if (G.world.wrapX && (snownessAt(tc, tr) > 0.5 || desertAt(tc, tr) > 0.4)) return;
  if (nearBuilding(tc, tr, range)) return;   // target inside the clearance of any building
  if (bushesAround(tc, tr) > ((sp.maxNeighbors != null) ? sp.maxNeighbors : 2)) return;
  const list = (GD.objects.grass_patch && GD.objects.grass_patch.decorSprites) || [];
  if (!list.length) return;
  setDecorSpawned(tc, tr, list[(Math.random() * list.length) | 0]);
}
