// TapCraft - farming: tilling (garden hoe), wheat planting/harvesting, bucket
// watering, and grass-patch foraging.
//
// Tilling: hold Shift and click bare grass/dirt with a garden hoe owned. Each click
// costs 1 hoe durability and rolls GD.farming.tillChances[targetStage-1] to advance
// the soil (grass/dirt -> tilled_1 -> tilled_2 -> tilled_3). Only tilled stage >=
// plantStage accepts seeds. The pre-till tile is RETAINED on the cell delta (cells.js
// e.ot) and unplanted soil reverts to it after revertMinutes (cells.growFarmCell).
//
// Watering: the bucket is a crafted tool whose durability = total uses. Click water
// to fill it (1 use), click a tilled tile under 100% wet to pour (1 use) - the tile
// jumps to full saturation (wetness.pourWetness) and then dries normally. Wheat
// growth speed scales with the tile's wetness (cells.growFarmCell).
//
// Foraging: the grass-patch ground decor (GD.objects.grass_patch.decorSprites) is
// clickable; one click clears the patch (cells dc flag) with a small chance to drop
// wheat seeds - the bootstrap source of seeds (harvests then return some).
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { inBounds } from "./rng.js";
import {
  tileAt, stageAt, isTilledTile, tilledStageOf, wheatMature,
  setTilled, plantAt, clearCropAt,
  decorAt, decorClearedAt, setDecorCleared,
  wrapCol, wrapRow,
} from "./cells.js";
import { mineableAt } from "./mineable.js";
import { wetnessAt, pourWetness } from "./wetness.js";
import { bestToolId, useTool, spawnDrop, cellKey, toolDurabilityFor } from "./resources.js";
import { buildingCells } from "./iso.js";
import { footprintOf } from "./buildings.js";
import { updateResourceUI, postEvent } from "./ui.js";
import { updateCraftedHud } from "./crafting.js";
import { playSfx } from "./sound.js";
import { saveWorld } from "./persistence.js";

const WET_FULL = 0.999; // "100% wet" threshold for pour checks (float-safe)

function maxTilledStage() {
  const f = GD.farming;
  return (f && f.tillChances) ? f.tillChances.length : 3;
}
function plantStage() {
  const f = GD.farming;
  return (f && f.plantStage) ? f.plantStage : 3;
}
// Buckets live as TWO tool stacks: "bucket" (empty) and "bucket_water" (filled).
// Filling/pouring moves ONE bucket between the stacks, so the crafted HUD shows
// an empty pile and a full pile side by side.
function emptyBuckets() { return (G.world.tools && G.world.tools.bucket) || null; }
function filledBuckets() { return (G.world.tools && G.world.tools.bucket_water) || null; }
function bucketsOwned() {
  const e = emptyBuckets(), f = filledBuckets();
  return (e ? e.count | 0 : 0) + (f ? f.count | 0 : 0);
}

// True when any cell of a placed building's footprint covers (c,r). The list is
// small and this only runs on clicks / single-cell hover probes.
function underBuilding(c, r) {
  const list = G.world.buildings;
  if (!list || !list.length) return false;
  const cc = wrapCol(c), rr = wrapRow(r);
  for (const b of list) {
    const fp = footprintOf(b.type);
    for (const [bc, br] of buildingCells(b.col, b.row, fp.w, fp.h)) {
      if (wrapCol(bc) === cc && wrapRow(br) === rr) return true;
    }
  }
  return false;
}

// The forageable grass-patch decor index occupying this cell, or -1. Mirrors the
// render rule for cosmetic decor (bare grass only, hidden under buildings), plus
// the cleared flag - so hit-testing, rendering and tilling always agree.
export function patchAt(c, r) {
  const gp = GD.objects && GD.objects.grass_patch;
  if (!gp || !gp.targetable) return -1;
  if (tileAt(c, r) !== "grass" || stageAt(c, r) >= 0 || mineableAt(c, r)) return -1;
  const di = decorAt(c, r);
  if (di < 0) return -1;
  const list = gp.decorSprites || [];
  if (list.indexOf(di) < 0) return -1;
  if (decorClearedAt(c, r) || underBuilding(c, r)) return -1;
  return di;
}

// Can (c,r) be tilled (further)? Bare grass/dirt, or a crop-free tilled tile below
// the final stage. Objects, forage patches and buildings block the hoe.
export function canTillAt(c, r) {
  if (!inBounds(c, r)) return false;
  const t = tileAt(c, r);
  if (isTilledTile(t)) {
    return tilledStageOf(t) < maxTilledStage() && stageAt(c, r) < 0;
  }
  if (t !== "grass" && t !== "dirt") return false;
  if (stageAt(c, r) >= 0 || mineableAt(c, r)) return false;
  if (patchAt(c, r) >= 0) return false; // forage the patch first
  return !underBuilding(c, r);
}

// One Shift+click till attempt. A swing always costs 1 hoe durability; the stage
// advance is the data-driven roll (100% / 50% / 25% by target stage).
function tillAt(c, r) {
  const f = GD.farming;
  if (!f) return false;
  const hoe = bestToolId(G.world.tools, "garden_hoe");
  if (!hoe || !canTillAt(c, r)) return false;
  const t = tileAt(c, r);
  const next = isTilledTile(t) ? tilledStageOf(t) + 1 : 1;
  const chances = f.tillChances || [1, 0.5, 0.25];
  useTool(hoe);
  playSfx("hit_stone", "effects");
  const p = (chances[next - 1] != null) ? chances[next - 1] : 0;
  if (Math.random() < p) setTilled(c, r, next);
  saveWorld();
  return true;
}

// Plant a seed on fully-tilled, crop-free soil. The seedling (wheat stage 0)
// appears immediately, with a click "pop" on it for unmistakable feedback.
function tryPlant(c, r) {
  const t = tileAt(c, r);
  if (!isTilledTile(t) || tilledStageOf(t) < plantStage()) return false;
  if (stageAt(c, r) >= 0) return false;
  if ((G.world.wheat_seeds | 0) <= 0) return false;
  G.world.wheat_seeds -= 1;
  plantAt(c, r);
  // Pop the freshly-planted seedling (no drops; purely the scale bounce).
  G.pops.set(cellKey(c, r), { col: c, row: r, t0: G.animTime, drop: "wheat_seeds", dropCount: 0, dropped: true });
  updateResourceUI();
  playSfx("hit_wood", "effects");
  saveWorld();
  return true;
}

// Use the ACTIVE bucket of `fromId` for one action (fill or pour, 1 use each) and
// move it - carrying its remaining uses - onto the other stack. A bucket on its
// last use WEARS OUT on this action instead: it is gone and nothing arrives.
// Returns true when a bucket (with uses left) actually landed on `toId`.
// NOTE: a moved bucket only stays the wear-tracked ACTIVE instance when the
// destination stack was empty; behind an existing active it is treated as fresh
// when promoted. With 100 uses per bucket the drift is negligible.
function shiftBucket(fromId, toId) {
  const tools = G.world.tools;
  const from = tools[fromId];
  if (!from || from.count <= 0) return false;
  const usesLeft = (from.dura | 0) - 1;                          // after this action
  from.count -= 1;
  from.dura = from.count > 0 ? toolDurabilityFor(fromId) : 0;    // next one is fresh
  let arrived = false;
  if (usesLeft <= 0) {
    postEvent(bucketsOwned() > 0 ? "A bucket wore out." : "Your last bucket wore out.");
  } else {
    const to = tools[toId] || (tools[toId] = { count: 0, dura: 0 });
    to.count += 1;
    if (to.count === 1) to.dura = usesLeft;
    arrived = true;
  }
  updateCraftedHud();
  return arrived;
}

// Click on water: fill ONE empty bucket (it moves to the filled stack). False when
// no bucket is owned (the click falls through to the normal empty-ground handling).
function tryFill() {
  const e = emptyBuckets(), f = filledBuckets();
  const empties = e ? e.count | 0 : 0, fulls = f ? f.count | 0 : 0;
  if (empties + fulls <= 0) return false;
  if (empties <= 0) { postEvent("All your buckets are already full of water."); return true; }
  if (shiftBucket("bucket", "bucket_water")) postEvent("Bucket filled with water.");
  saveWorld();
  return true;
}

// Click on a tilled tile / growing crop with a bucket owned: pour ONE filled bucket
// (full saturation; it returns to the empty stack), or explain why not
// ("No water buckets." / "Already fully saturated.").
function tryPour(c, r) {
  if (bucketsOwned() <= 0) return false; // never owned buckets: stay silent
  const f = filledBuckets();
  if (!f || f.count <= 0) { postEvent("No water buckets."); return true; }
  if (wetnessAt(c, r) >= WET_FULL) { postEvent("Already fully saturated."); return true; }
  pourWetness(c, r); // the water lands even if the bucket wears out on this pour
  shiftBucket("bucket_water", "bucket");
  saveWorld();
  return true;
}

// Forage a grass patch: the patch is cleared and may drop seeds. The per-world
// creation slider (settings.seedChance, 0..0.25 fraction) overrides the pack
// chance; 0 is a VALID value (never drops), hence the typeof check.
function foragePatch(c, r) {
  const gp = GD.objects.grass_patch || {};
  setDecorCleared(c, r);
  playSfx("hit_wood", "effects");
  const ws = G.world.settings;
  const chance = (ws && typeof ws.seedChance === "number" && isFinite(ws.seedChance)) ? ws.seedChance
    : (gp.dropChance != null ? gp.dropChance : 0.05);
  if (Math.random() < chance) {
    spawnDrop(c, r, gp.drop || "wheat_seeds");
  }
  saveWorld();
}

// Harvest mature wheat: wheat drops + a chance of seeds back; the soil stays
// tilled (revert clock restarts via clearCropAt).
function harvestWheatAt(c, r) {
  const f = GD.farming || {};
  const def = GD.objects.wheat || {};
  const yMin = (f.wheatYieldMin != null) ? f.wheatYieldMin : 1;
  const yMax = (f.wheatYieldMax != null) ? f.wheatYieldMax : 2;
  const n = yMin + Math.floor(Math.random() * (yMax - yMin + 1));
  for (let i = 0; i < n; i++) spawnDrop(c, r, def.drop || "wheat");
  if (Math.random() < ((f.seedReturnChance != null) ? f.seedReturnChance : 0.5)) {
    const sMin = (f.seedReturnMin != null) ? f.seedReturnMin : 1;
    const sMax = (f.seedReturnMax != null) ? f.seedReturnMax : 2;
    const sn = sMin + Math.floor(Math.random() * (sMax - sMin + 1));
    for (let i = 0; i < sn; i++) spawnDrop(c, r, "wheat_seeds");
  }
  clearCropAt(c, r);
  playSfx("hit_wood", "effects");
  saveWorld();
}

// --- Input entry points (input.js) -------------------------------------------
// Left-click on a farm OBJECT (wheat / grass patch). True when consumed - these
// are single-click actions and never start a harvest hold.
export function farmObjectClick(obj) {
  if (!G.running || !obj) return false;
  if (obj.kind === "grass_patch") { foragePatch(obj.col, obj.row); return true; }
  if (obj.kind === "wheat") {
    if (obj.stage >= wheatMature()) harvestWheatAt(obj.col, obj.row);
    else tryPour(obj.col, obj.row); // watering a growing crop (toasts when it can't)
    return true;
  }
  return false;
}
// Left-click on object-free ground: till (Shift) / fill the bucket on water /
// plant / pour on tilled soil. True when the click performed a farm action.
export function farmGroundClick(col, row, shift) {
  if (!G.running || !G.hasWorld || !inBounds(col, row)) return false;
  const t = tileAt(col, row);
  if (shift) return tillAt(col, row);
  if (t === "water") return tryFill();
  if (isTilledTile(t)) {
    if (tryPlant(col, row)) return true;
    return tryPour(col, row);
  }
  return false;
}

// --- Hover cursor state (render.js, once per frame) ---------------------------
// Sets G.showHoe (swinging hoe cursor over tillable ground while Shift is held)
// and G.farmCursor ("pour" | "fill" | "seeds" static icons). The pour icon shows
// whenever a bucket is OWNED and the tile can take water (clicking with all
// buckets empty then explains itself); at 100% wet no icon shows, matching the click.
function canShowPour(c, r) {
  return bucketsOwned() > 0 && wetnessAt(c, r) < WET_FULL;
}
export function resolveFarmCursor() {
  G.showHoe = false;
  G.farmCursor = null;
  if (!G.hasWorld || G.inMenu || !G.running || G.buildMode || !G.mouse.on || !GD.farming) return;
  const hov = G.hover;
  if (hov) {
    // Growing wheat invites watering; everything else keeps its normal cursor.
    if (hov.kind === "wheat" && hov.stage < wheatMature() && canShowPour(hov.col, hov.row)) G.farmCursor = "pour";
    return;
  }
  const cell = G.hoverTile;
  if (!cell || !inBounds(cell.col, cell.row)) return;
  const c = cell.col, r = cell.row;
  if (G.shiftDown) {
    if (bestToolId(G.world.tools, "garden_hoe") && canTillAt(c, r)) G.showHoe = true;
    return;
  }
  const t = tileAt(c, r);
  if (t === "water") {
    const e = emptyBuckets();
    if (e && e.count > 0) G.farmCursor = "fill"; // something left to fill
    return;
  }
  if (isTilledTile(t)) {
    if (tilledStageOf(t) >= plantStage() && stageAt(c, r) < 0 && (G.world.wheat_seeds | 0) > 0) {
      G.farmCursor = "seeds";
      return;
    }
    if (canShowPour(c, r)) G.farmCursor = "pour";
  }
}
