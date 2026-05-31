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
import { mineableAt } from "./mineable.js";
import { doHarvest, toolDurabilityFor } from "./resources.js";
import { updateResourceUI } from "./ui.js";
import { updateCraftedHud } from "./crafting.js";

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
  const def = GD.buildings[type];
  const b = {
    id: "b_" + (G.world.tick | 0) + "_" + (G.world.buildings.length + 1),
    type, col, row,
    facing: facing === "SW" ? "SW" : "SE",
    produced: {},   // lifetime stat (resource id -> total ever harvested/smelted)
    stored: {},     // resources held at the building, awaiting collection
  };
  if (def.category === "harvester") {
    // Tool stock as a per-tool-id map so the hut can hold any tier of its kind.
    b.tools = {};
  } else if (def.category === "smelter") {
    b.oreStored = {};   // ore awaiting smelt (resource id -> count)
    b.ingots = {};      // smelted ingots awaiting collection
    b.fuel = 0;         // fuel pool (fed by depositing the fuel resource)
    b.smelt = null;     // current job { resource, elapsed }
  }
  G.world.buildings.push(b);
  return b;
}

// Is at least one building of a given type placed? (Blacksmith gate, etc.)
export function buildingExists(type) {
  return G.world.buildings.some((b) => b.type === type);
}

export function demolishBuilding(id) {
  const i = G.world.buildings.findIndex((b) => b.id === id);
  if (i < 0) return;
  refundOnDemolish(G.world.buildings[i]);
  G.world.buildings.splice(i, 1);
  delete G.buildWork[id];
  if (G.selectedBuilding === id) G.selectedBuilding = null;
  if (G.hoverBuilding === id) G.hoverBuilding = null;
  updateResourceUI();
  updateCraftedHud();
}

// Demolishing returns what the building still holds: 50% of its build cost
// (rounded down), every FULL (non-damaged) tool, and all unused/stored resources.
// A partly-worn active tool instance is lost (you can't un-wear it).
function refundOnDemolish(b) {
  const def = GD.buildings[b.type];
  for (const res of Object.keys(def.buildCost || {})) {
    G.world[res] = (G.world[res] | 0) + Math.floor((def.buildCost[res] | 0) * 0.5);
  }
  if (def.category === "harvester") {
    if (b.tools) {
      for (const tid of Object.keys(b.tools)) {
        const full = movableTools(b.tools[tid], tid);
        if (full <= 0) continue;
        const slot = G.world.tools[tid] || (G.world.tools[tid] = { count: 0, dura: 0 });
        if (slot.count <= 0) slot.dura = toolDurabilityFor(tid);
        slot.count += full;
      }
    }
    if (b.stored) for (const res of Object.keys(b.stored)) G.world[res] = (G.world[res] | 0) + (b.stored[res] | 0);
  } else if (def.category === "smelter") {
    if (b.oreStored) for (const res of Object.keys(b.oreStored)) G.world[res] = (G.world[res] | 0) + (b.oreStored[res] | 0);
    if (b.ingots) for (const res of Object.keys(b.ingots)) G.world[res] = (G.world[res] | 0) + (b.ingots[res] | 0);
    // Unused fuel pool back as whole units of the fuel resource (remainder lost).
    const fuelRes = def.fuelResource, fv = fuelRes ? (GD.resources[fuelRes].fuel || 0) : 0;
    if (fuelRes && fv > 0 && b.fuel > 0) G.world[fuelRes] = (G.world[fuelRes] | 0) + Math.floor(b.fuel / fv);
  }
}

// --- Tools: the hut's own stock (per-tool-id map) + count-driven bonuses -----
// The TOOL KIND a hut uses (e.g. logging_hut -> "hatchet"). The hut's stock may
// hold any tier of that kind (stone + iron); the best tier present is used.
export function hutToolKind(b) {
  return GD.objects[GD.buildings[b.type].targetKind].tool;
}
// All tool ids of the hut's kind (e.g. hatchet + iron_hatchet).
function hutToolIds(b) {
  const kind = hutToolKind(b);
  return Object.keys(GD.tools).filter((id) => (GD.tools[id].kind || id) === kind);
}
// Total tools across all tiers in the hut.
export function hutToolCount(b) {
  if (!b.tools) return 0;
  let n = 0;
  for (const id of Object.keys(b.tools)) n += b.tools[id].count | 0;
  return n;
}
// Full (movable) tools in ONE per-id slot. A damaged active tool stays put; the
// "full" threshold is the TOOL'S OWN max durability (iron lasts longer than stone).
export function movableTools(slot, toolId) {
  if (!slot || slot.count <= 0) return 0;
  const damaged = slot.dura > 0 && slot.dura < toolDurabilityFor(toolId);
  return slot.count - (damaged ? 1 : 0);
}
// Movable tools of a kind across a stock map (sum over its slots).
function movableOfKind(stockMap, kind) {
  let n = 0;
  for (const id of Object.keys(GD.tools)) {
    if ((GD.tools[id].kind || id) !== kind) continue;
    n += movableTools(stockMap[id], id);
  }
  return n;
}
// The best (highest-sharpness) tool id present in a stock map for a kind.
function bestInStock(stockMap, kind) {
  let best = null, bs = -1;
  for (const id of Object.keys(GD.tools)) {
    if ((GD.tools[id].kind || id) !== kind) continue;
    const s = stockMap[id];
    if (s && s.count > 0 && (GD.tools[id].sharpness || 0) > bs) { best = id; bs = GD.tools[id].sharpness || 0; }
  }
  return best;
}
// Worker count = base + 1 per maxTargetPerTools tools currently in the hut.
export function effectiveMaxTargets(b) {
  const def = GD.buildings[b.type];
  const per = def.maxTargetPerTools | 0;
  const bonus = per > 0 ? Math.floor(hutToolCount(b) / per) : 0;
  return (def.maxTargets | 0) + bonus;
}
// Harvest interval after the per-tool speed bonus (clamped to maxSpeedBonus).
export function effectiveSpeedMs(b) {
  const def = GD.buildings[b.type];
  const bonus = Math.min(def.maxSpeedBonus || 0, hutToolCount(b) * (def.speedBonusPerTool || 0));
  return def.harvestSpeedMs * (1 - bonus);
}

// Move up to n FULL tools of a specific id between two per-id slots. Damaged
// tools stay put; seeds full durability when filling an empty destination slot.
function moveToolSlot(fromMap, toMap, toolId, n) {
  const from = fromMap[toolId] || (fromMap[toolId] = { count: 0, dura: 0 });
  const to = toMap[toolId] || (toMap[toolId] = { count: 0, dura: 0 });
  const m = Math.min(n | 0, movableTools(from, toolId));
  if (m <= 0) return 0;
  from.count -= m;
  if (from.count <= 0) from.dura = 0;
  if (to.count <= 0) to.dura = toolDurabilityFor(toolId);
  to.count += m;
  return m;
}
// Deposit n tools of the hut's kind from the player pool, preferring the best
// tier first (so iron goes in before stone). Returns total moved.
export function depositTool(id, n) {
  const b = findBuilding(id);
  if (!b) return 0;
  let left = n | 0, moved = 0;
  // best-first
  const ids = hutToolIds(b).sort((a, c) => (GD.tools[c].sharpness || 0) - (GD.tools[a].sharpness || 0));
  for (const tid of ids) {
    if (left <= 0) break;
    const m = moveToolSlot(G.world.tools, b.tools, tid, left);
    moved += m; left -= m;
  }
  if (moved > 0) updateCraftedHud();
  return moved;
}
// Withdraw n tools of the hut's kind back to the player pool (best tier first).
export function withdrawTool(id, n) {
  const b = findBuilding(id);
  if (!b) return 0;
  let left = n | 0, moved = 0;
  const ids = hutToolIds(b).sort((a, c) => (GD.tools[c].sharpness || 0) - (GD.tools[a].sharpness || 0));
  for (const tid of ids) {
    if (left <= 0) break;
    const m = moveToolSlot(b.tools, G.world.tools, tid, left);
    moved += m; left -= m;
  }
  if (moved > 0) updateCraftedHud();
  return moved;
}
// Movable counts for the panel: player pool vs hut (for the deposit/withdraw slider).
export function hutMovable(b) { return movableOfKind(b.tools, hutToolKind(b)); }
export function poolMovableForHut(b) { return movableOfKind(G.world.tools, hutToolKind(b)); }

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
// Is a cell an eligible target for this building's target kind? A logging hut
// (tree) targets mature trees; a mining hut (rock) targets ANY mineable on the
// cell - rock or ore vein - so one hut works the whole mineable family. (Whether
// it can actually extract a given vein is decided per-swing by toughness vs the
// hut's pickaxe sharpness.)
function isEligible(targetKind, c, r) {
  if (targetKind === "tree") return G.world.stage[r][c] >= GD.matureStage;
  if (targetKind === "rock") return G.world.rock[r][c] >= 0; // any encoded mineable
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
  if (!w) w = G.buildWork[b.id] = { workers: [], rate: [] };
  return w;
}
// Resize a hut's worker list to its current effective count, preserving the
// existing workers' cooldowns (new workers start ready).
function syncWorkers(w, n) {
  while (w.workers.length < n) w.workers.push({ nextAt: 0 });
  if (w.workers.length > n) w.workers.length = n;
}

// Advance every building by dtMs of world (sim) time. Branches by category:
// harvester huts swing tools; smelters convert ore->ingots over time.
export function updateBuildings(dtMs) {
  if (!G.world.buildings || !G.world.buildings.length) return;
  const now = (G.buildClock = (G.buildClock || 0) + dtMs); // monotonic ms while running
  for (const b of G.world.buildings) {
    const cat = GD.buildings[b.type].category;
    if (cat === "harvester") updateHarvester(b, now);
    else if (cat === "smelter") updateSmelter(b, dtMs);
  }
}

// A harvester hut is IDLE unless it holds at least one matching tool; while it
// has tools, each swing burns the hut's OWN durability (best tier first) and
// accrues yield to b.stored (no physical drops).
function updateHarvester(b, now) {
  const def = GD.buildings[b.type];
  const w = workState(b);
  if (hutToolCount(b) <= 0) { w.workers.length = 0; return; } // idle: no tools
  syncWorkers(w, effectiveMaxTargets(b));
  const speedMs = effectiveSpeedMs(b);
  const targets = buildingTargets(b);
  const claimed = new Set();
  let idx = 0;
  for (const worker of w.workers) {
    if (hutToolCount(b) <= 0) break;   // ran out of tools mid-tick -> stop
    if (now < worker.nextAt) continue;
    let pick = null;
    while (idx < targets.length) {
      const t = targets[idx++];
      if (!claimed.has(t.key)) { pick = t; break; }
    }
    if (!pick) break;
    claimed.add(pick.key);
    worker.nextAt = now + speedMs;
    const m = mineableAt(pick.c, pick.r);
    const objKind = m ? m.typeId : def.targetKind;
    const got = doHarvest(
      { kind: objKind, mineable: !!m, col: pick.c, row: pick.r },
      { building: true, noDrops: true, toolStock: b.tools }
    );
    if (got > 0) {
      const res = GD.objects[objKind].drop;
      b.produced[res] = (b.produced[res] | 0) + got;
      b.stored[res] = (b.stored[res] | 0) + got;
      w.rate.push({ t: now, n: got });
    }
  }
  while (w.rate.length && now - w.rate[0].t > RATE_WINDOW_MS) w.rate.shift();
}

// A smelter (Forge) converts deposited ORE into ingots over time, drawing from
// a fuel pool (fed by depositing the fuel resource). Per ingot: 1 ore + the
// ore's fuelCost from the pool. Smelt time scales with the fuel resource value:
// baseSmeltMs * (1 - fuelValue/60). Idle without ore or sufficient fuel.
function updateSmelter(b, dtMs) {
  const def = GD.buildings[b.type];
  const fuelValue = GD.resources[def.fuelResource].fuel || 0;
  const smeltMs = def.baseSmeltMs * (1 - Math.min(0.95, fuelValue / 60));
  if (!b.smelt) {
    // Start a job on the first ore type that has stock AND enough fuel.
    for (const res of (def.smelts || [])) {
      const fuelCost = GD.resources[res].fuelCost || 0;
      if ((b.oreStored[res] | 0) > 0 && b.fuel >= fuelCost) { b.smelt = { resource: res, elapsed: 0 }; break; }
    }
  }
  if (!b.smelt) return;
  const res = b.smelt.resource, fuelCost = GD.resources[res].fuelCost || 0;
  // If the inputs vanished (withdrawn / out of fuel), cancel the job.
  if ((b.oreStored[res] | 0) <= 0 || b.fuel < fuelCost) { b.smelt = null; return; }
  b.smelt.elapsed += dtMs;
  if (b.smelt.elapsed >= smeltMs) {
    b.oreStored[res] -= 1;
    b.fuel -= fuelCost;
    const ingot = GD.resources[res].smeltTo;
    b.ingots[ingot] = (b.ingots[ingot] | 0) + 1;
    b.produced[ingot] = (b.produced[ingot] | 0) + 1;
    b.smelt = null; // pick the next job next tick
  }
}

// Total resources currently held at a building (awaiting collection).
export function storedTotal(b) {
  let total = 0;
  for (const k in b.stored) total += b.stored[k] | 0;
  return total;
}

// Move all of a building's collectable output into the player's pool: harvester
// `stored`, smelter `ingots`.
// Move a building's collectable output into the player pool. With `only` set,
// collects just that one resource (Forge has a Receive button per ingot type);
// otherwise collects everything in the bag (harvester "Receive").
export function receiveResources(id, only) {
  const b = findBuilding(id);
  if (!b) return 0;
  // Harvesters collect `stored`; smelters collect `ingots`. Every building has
  // an (often empty) `stored` map, so choosing the bag by truthiness would wrongly
  // route a smelter down the harvester path - decide by category instead.
  const sink = GD.buildings[b.type].category === "smelter" ? "ingots" : "stored";
  const bag = b[sink];
  if (!bag) return 0;
  let moved = 0;
  const keys = only ? [only] : Object.keys(bag);
  for (const res of keys) {
    const n = bag[res] | 0;
    if (n > 0) { G.world[res] = (G.world[res] | 0) + n; moved += n; }
    bag[res] = 0;
  }
  if (moved > 0) updateResourceUI();
  return moved;
}

// --- Forge (smelter) deposit/withdraw -------------------------------------
// Ore the player can deposit (what the forge smelts).
export function forgeOreTypes(b) { return GD.buildings[b.type].smelts || []; }
// Ore in the forge that is NOT locked in the current job (withdrawable).
export function forgeFreeOre(b, res) {
  const locked = (b.smelt && b.smelt.resource === res) ? 1 : 0;
  return Math.max(0, (b.oreStored[res] | 0) - locked);
}
export function depositOre(id, res, n) {
  const b = findBuilding(id);
  if (!b || !b.oreStored) return 0;
  const m = Math.min(n | 0, G.world[res] | 0);
  if (m <= 0) return 0;
  G.world[res] -= m;
  b.oreStored[res] = (b.oreStored[res] | 0) + m;
  updateResourceUI();
  return m;
}
export function withdrawOre(id, res, n) {
  const b = findBuilding(id);
  if (!b || !b.oreStored) return 0;
  const m = Math.min(n | 0, forgeFreeOre(b, res)); // cannot pull the in-progress unit
  if (m <= 0) return 0;
  b.oreStored[res] -= m;
  G.world[res] = (G.world[res] | 0) + m;
  updateResourceUI();
  return m;
}
// Deposit fuel (the forge's fuel resource) -> adds that resource's fuel value to
// the pool per unit. Burned fuel cannot be withdrawn.
export function depositFuel(id, n) {
  const b = findBuilding(id);
  if (!b) return 0;
  const fuelRes = GD.buildings[b.type].fuelResource;
  const m = Math.min(n | 0, G.world[fuelRes] | 0);
  if (m <= 0) return 0;
  G.world[fuelRes] -= m;
  b.fuel += m * (GD.resources[fuelRes].fuel || 0);
  updateResourceUI();
  return m;
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
