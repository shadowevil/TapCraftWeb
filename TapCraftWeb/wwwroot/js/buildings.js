// TapCraft - buildings: placement, demolition, the per-tick worker simulation
// and auto-sweep. Buildings are data-driven (GD.buildings) automated harvesters
// with a 2x2 footprint. Each runs `maxTargets` concurrent workers that swing
// the nearest in-range eligible resource once per harvestSpeedMs (reusing the
// manual harvest path, but tool-free), and periodically sweep resting drops in
// range to the resource bar.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { cellCenter } from "./iso.js";
import { buildingCells } from "./iso.js";
import { inBounds } from "./rng.js";
import { cellObject } from "./render.js";
import { doHarvest, spawnDrop, startDropFly, cellKey } from "./resources.js";

const RATE_WINDOW_MS = 15000; // production-rate smoothing window

export function buildingDef(type) { return GD.buildings[type]; }

// --- Placement -------------------------------------------------------
// Every footprint cell must be in-bounds, a placeable tile, free of objects
// (tree/rock), and not overlap another building. (No water: water tiles are
// not in placeableTiles.)
export function canPlaceFootprint(type, col, row) {
  const def = GD.buildings[type];
  if (!def) return false;
  const tiles = def.placeableTiles;
  for (const [c, r] of buildingCells(col, row)) {
    if (!inBounds(c, r)) return false;
    if (tiles.indexOf(G.world.tiles[r][c]) < 0) return false;
    if (cellObject(c, r)) return false;            // tree or rock present
  }
  // No overlap with an existing building's footprint.
  const want = footprintKeys(col, row);
  for (const b of G.world.buildings) {
    for (const k of footprintKeys(b.col, b.row)) if (want.has(k)) return false;
  }
  return true;
}

export function canAffordBuilding(type) {
  const cost = GD.buildings[type].buildCost;
  return (G.world.wood | 0) >= cost.wood && (G.world.stone | 0) >= cost.stone;
}

// Place a building at rear-anchor (col,row). Returns the new building or null
// if invalid/unaffordable. Deducts the build cost.
export function placeBuilding(type, col, row, facing) {
  if (!canPlaceFootprint(type, col, row) || !canAffordBuilding(type)) return null;
  const cost = GD.buildings[type].buildCost;
  G.world.wood -= cost.wood;
  G.world.stone -= cost.stone;
  const b = {
    id: "b_" + (G.world.tick | 0) + "_" + (G.world.buildings.length + 1),
    type, col, row,
    facing: facing === "SW" ? "SW" : "SE",
    produced: {},
  };
  G.world.buildings.push(b);
  return b;
}

export function demolishBuilding(id) {
  const i = G.world.buildings.findIndex((b) => b.id === id);
  if (i < 0) return;
  G.world.buildings.splice(i, 1);
  delete G.buildWork[id];
  if (G.selectedBuilding === id) G.selectedBuilding = null;
  if (G.hoverBuilding === id) G.hoverBuilding = null;
}

export function findBuilding(id) {
  return G.world.buildings.find((b) => b.id === id) || null;
}

function footprintKeys(col, row) {
  const set = new Set();
  for (const [c, r] of buildingCells(col, row)) set.add(r * G.world.cols + c);
  return set;
}

// World-space center of the 2x2 block (for range checks + panel anchor).
export function buildingCenter(b) {
  const c = cellCenter(b.col + 0.5, b.row + 0.5);
  return c;
}

// --- Targets ---------------------------------------------------------
// Is a cell an eligible target for this building's target kind?
function isEligible(targetKind, c, r) {
  if (targetKind === "tree") return G.world.stage[r][c] >= GD.matureStage;
  if (targetKind === "rock") return G.world.rock[r][c] >= 0;
  return false;
}

// Every in-bounds cell within a building type's (Euclidean) harvest radius of
// the footprint with rear-anchor (col,row). Used to preview a building's
// coverage area while placing it. Each entry: {c,r}.
export function cellsInRange(type, col, row) {
  const radius = GD.buildings[type].harvestRadius;
  const cx = col + 0.5, cy = row + 0.5;              // 2x2 footprint center
  const r2 = (radius + 0.5) * (radius + 0.5);
  const c0 = Math.max(0, Math.floor(cx - radius - 1));
  const c1 = Math.min(G.world.cols - 1, Math.ceil(cx + radius + 1));
  const r0 = Math.max(0, Math.floor(cy - radius - 1));
  const r1 = Math.min(G.world.rows - 1, Math.ceil(cy + radius + 1));
  const out = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d2 = (c + 0.5 - cx) * (c + 0.5 - cx) + (r + 0.5 - cy) * (r + 0.5 - cy);
      if (d2 <= r2) out.push({ c, r });
    }
  }
  return out;
}

// All eligible target cells within the building's (Euclidean) harvest radius,
// measured from the footprint center, nearest first. Each entry: {c,r,d2,key}.
export function buildingTargets(b) {
  const def = GD.buildings[b.type];
  const radius = def.harvestRadius;
  const cx = b.col + 0.5, cy = b.row + 0.5;          // footprint center in cells
  const r2 = (radius + 0.5) * (radius + 0.5);        // +0.5 so edge tiles count
  const c0 = Math.max(0, Math.floor(cx - radius - 1));
  const c1 = Math.min(G.world.cols - 1, Math.ceil(cx + radius + 1));
  const r0 = Math.max(0, Math.floor(cy - radius - 1));
  const r1 = Math.min(G.world.rows - 1, Math.ceil(cy + radius + 1));
  const out = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d2 = (c + 0.5 - cx) * (c + 0.5 - cx) + (r + 0.5 - cy) * (r + 0.5 - cy);
      if (d2 > r2) continue;
      if (isEligible(def.targetKind, c, r)) out.push({ c, r, d2, key: r * G.world.cols + c });
    }
  }
  out.sort((a, b) => a.d2 - b.d2);
  return out;
}

// --- Simulation (called from sim.tick at the fixed step) -------------
function workState(b) {
  let w = G.buildWork[b.id];
  if (!w) {
    const def = GD.buildings[b.type];
    const n = Math.max(1, def.maxTargets | 0);
    w = G.buildWork[b.id] = {
      workers: Array.from({ length: n }, () => ({ nextAt: 0 })), // nextAt in ms (world clock)
      nextSweepAt: 0,
      rate: [], // [{t, n}] recent production events for the smoothed rate
    };
  }
  return w;
}

// Advance every building by dtMs of world (sim) time. Drops physically spawn
// via the manual harvest path; the building credits `produced` (a lifetime
// stat) and periodically sweeps resting in-range drops to the bar.
export function updateBuildings(dtMs) {
  if (!G.world.buildings || !G.world.buildings.length) return;
  const now = (G.buildClock = (G.buildClock || 0) + dtMs); // monotonic ms while running
  for (const b of G.world.buildings) {
    const def = GD.buildings[b.type];
    const w = workState(b);
    // Re-pick targets fresh each tick; claims are local so two workers (or two
    // buildings sharing range) never lock the same cell in one tick.
    const targets = buildingTargets(b);
    const claimed = new Set();
    let idx = 0;
    for (const worker of w.workers) {
      if (now < worker.nextAt) continue;
      // Next free nearest target not already claimed this tick.
      let pick = null;
      while (idx < targets.length) {
        const t = targets[idx++];
        if (!claimed.has(t.key)) { pick = t; break; }
      }
      if (!pick) break; // no targets left for the remaining workers this tick
      claimed.add(pick.key);
      worker.nextAt = now + def.harvestSpeedMs;
      const got = doHarvest({ kind: def.targetKind, col: pick.c, row: pick.r }, { tooled: false, building: true });
      if (got > 0) {
        const res = GD.objects[def.targetKind].drop;
        b.produced[res] = (b.produced[res] | 0) + got;
        w.rate.push({ t: now, n: got });
      }
    }
    // Trim the rate window.
    while (w.rate.length && now - w.rate[0].t > RATE_WINDOW_MS) w.rate.shift();
    // Auto-sweep: send resting in-range drops flying to the bar.
    if (now >= w.nextSweepAt) {
      w.nextSweepAt = now + def.sweepIntervalMs;
      sweepDrops(b);
    }
  }
}

function sweepDrops(b) {
  const def = GD.buildings[b.type];
  const center = cellCenter(b.col + 0.5, b.row + 0.5); // world px
  // Range in world px: radius cells -> *2*HALF_W-ish; use cell-space check via
  // back-conversion is overkill, so compare in cell space using drop ground pos.
  const radius = def.harvestRadius;
  const r2 = (radius + 0.5) * (radius + 0.5);
  const cx = b.col + 0.5, cy = b.row + 0.5;
  for (const d of G.drops) {
    if (d.phase !== "rest") continue;
    // Convert the drop's world ground position back to fractional cell coords.
    const cc = d.gx / (2 * 16) + d.gy / (2 * 8); // inverse of cellCenter (HALF_W=16,HALF_H=8)
    const rr = d.gy / (2 * 8) - d.gx / (2 * 16);
    const d2 = (cc - cx) * (cc - cx) + (rr - cy) * (rr - cy);
    if (d2 <= r2) startDropFly(d);
  }
}

// --- Analytics (for the panel) ---------------------------------------
export function producedTotal(b) {
  let total = 0;
  for (const k in b.produced) total += b.produced[k] | 0;
  return total;
}
// Smoothed production per minute from the recent window.
export function productionPerMin(b) {
  const w = G.buildWork[b.id];
  if (!w || !w.rate.length) return 0;
  let n = 0;
  for (const e of w.rate) n += e.n;
  return Math.round((n / (RATE_WINDOW_MS / 1000)) * 60);
}
