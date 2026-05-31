// TapCraft - "mineable" objects (pickaxe-harvested, infinite): stone rocks and
// ore veins (iron, gold). They all share the single per-cell layer G.world.rock,
// so a cell holds at most one mineable. To carry the TYPE without a parallel
// layer, the cell stores an encoded integer:
//   -1                  = empty
//   typeIndex*100 + var = a mineable of MINEABLE_TYPES[typeIndex], sprite variant
// IMPORTANT: stone rock is typeIndex 0, so old saves (which stored plain 0/1
// rock-variant values) decode unchanged as rock variant 0/1. Keep this order
// stable; append new ore types at the end.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { rockRawAt, setRockRaw } from "./cells.js";

export const MINEABLE_TYPES = ["rock", "iron_vein", "gold_vein"];
const STRIDE = 100;

export function mineableTypeId(index) { return MINEABLE_TYPES[index] || null; }
export function mineableTypeIndex(typeId) { return MINEABLE_TYPES.indexOf(typeId); }

// Decode a raw cell value -> { typeId, typeIndex, variant } or null if empty.
export function decodeMineable(raw) {
  if (raw == null || raw < 0) return null;
  const typeIndex = Math.floor(raw / STRIDE);
  const variant = raw - typeIndex * STRIDE;
  const typeId = MINEABLE_TYPES[typeIndex];
  if (!typeId) return null;
  return { typeId, typeIndex, variant };
}
export function encodeMineable(typeIndex, variant) { return typeIndex * STRIDE + (variant | 0); }

// The mineable on a cell (reads the rock layer via cells.js), or null.
export function mineableAt(c, r) {
  return decodeMineable(rockRawAt(c, r));
}
export function setMineable(c, r, typeId, variant) {
  const i = mineableTypeIndex(typeId);
  if (i < 0) return;
  setRockRaw(c, r, encodeMineable(i, variant || 0));
}
export function hasMineable(c, r) {
  return rockRawAt(c, r) >= 0;
}

// The data def + resolved variant sprite for a decoded mineable.
export function mineableDef(typeId) { return GD.objects[typeId]; }
export function mineableSprite(m) {
  const imgs = G.oreImages[m.typeId];
  if (!imgs) return null;
  return imgs[m.variant] || imgs[0] || null;
}
