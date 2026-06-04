// TapCraft - "mineable" objects (FINITE, see ecology): stone rocks, ore veins
// (iron, gold), and fallen logs (hand-gathered wood). They all share the single
// per-cell layer G.world.rock, so a cell holds at most one mineable. To carry
// the TYPE without a parallel layer, the cell stores an encoded integer:
//   -1                  = empty
//   typeIndex*100 + var = a mineable of MINEABLE_TYPES[typeIndex], sprite variant
// IMPORTANT: stone rock is typeIndex 0, so old saves (which stored plain 0/1
// rock-variant values) decode unchanged as rock variant 0/1. Keep this order
// stable; append new types at the end (logs = typeIndex 3).
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { rockRawAt, setRockRaw } from "./cells.js";

export const MINEABLE_TYPES = ["rock", "iron_vein", "gold_vein", "logs"];
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
// Per-VARIANT stat overrides (data: variantStock / variantToughness keyed by
// variant index, mirroring variantYOffset) - e.g. the small surface rocks hold
// far less stone than the big ones but are soft enough for bare hands.
// mineableStockOf returns null when the type/variant is infinite (no stock).
export function mineableStockOf(def, variant) {
  const o = def.variantStock;
  if (o && o[variant] != null) return o[variant];
  return (def.stock != null) ? def.stock : null;
}
export function mineableToughnessOf(def, variant) {
  const o = def.variantToughness;
  if (o && o[variant] != null) return o[variant];
  // != null, NOT ||: toughness 0 (hand-gatherable, e.g. fallen logs) is a real
  // value - `0 || 1` would silently harden it back to tool-required.
  return (def.toughness != null) ? def.toughness : 1;
}
// Fixed per-gather output (sure-drop objects like fallen logs: the pile variant
// yields 2, singles 1). null = no override (the normal tool/hands roll applies).
export function mineableOutputOf(def, variant) {
  const o = def.variantOutput;
  if (o && o[variant] != null) return o[variant];
  return (def.output != null) ? def.output : null;
}
export function mineableSprite(m) {
  const imgs = G.oreImages[m.typeId];
  if (!imgs) return null;
  return imgs[m.variant] || imgs[0] || null;
}
