// TapCraft - image loading, mask/shadow/pool baking, sprite selection.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { hash01, inBounds } from "./rng.js";
import { MINEABLE_TYPES } from "./mineable.js";
import { tileAt, grassVariantAt } from "./cells.js";

// --- Water autotiling -------------------------------------------------
export function isLand(col, row) {
  if (!inBounds(col, row)) return false;
  return tileAt(col, row) !== "water";
}
// Indexed by the 4-bit land mask (ne=1, se=2, sw=4, nw=8): single edges, the
// four two-edge corners, and "o" for any other multi-land combo. null = open.
export const WATER_EDGE_BY_MASK = [
  null, "ne", "se", "e", "sw", "o", "s", "o",
  "nw", "n", "o", "o", "w", "o", "o", "o",
];
export function waterEdge(col, row) {
  const mask = (isLand(col, row - 1) ? 1 : 0) | (isLand(col + 1, row) ? 2 : 0) |
               (isLand(col, row + 1) ? 4 : 0) | (isLand(col - 1, row) ? 8 : 0);
  return WATER_EDGE_BY_MASK[mask];
}
export function waterFrameIndex() {
  return Math.floor(G.animTime / GD.water.frameMs) % GD.water.frames;
}
// `frame` is computed once per render() and passed in (it's identical for
// every water cell in a frame), so the floor/mod isn't repeated per cell.
export function tileSprite(id, col, row, frame) {
  if (id === "water") {
    const key = waterEdge(col, row) || "center";
    const frames = G.waterImages[key];
    return frames ? frames[frame] : null;
  }
  // Grass: pick a per-cell variant sprite (biome-biased). Variant 0 is the base
  // grass.png. tileAt still reports "grass", so placement/spawns are unaffected.
  if (id === "grass" && G.grassVariants && G.grassVariants.length) {
    const v = G.grassVariants[grassVariantAt(col, row)] || G.grassVariants[0];
    return v || G.images.grass || null;
  }
  return G.images[id] || null;
}
export function plantSprite(stage, col, row) {
  if (stage < 0) return null;
  if (stage >= GD.matureStage) {
    const variant = hash01(col, row, (G.world.seed ^ 0x5bd1e995) >>> 0) < 0.5 ? 0 : 1;
    return G.treeImages[variant];
  }
  return G.stageImages[stage];
}

// Alpha masks for targetable sprites, for pixel-perfect hit testing.
export function buildMask(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  const oc = document.createElement("canvas");
  oc.width = w; oc.height = h;
  const octx = oc.getContext("2d");
  octx.drawImage(img, 0, 0);
  let data;
  try { data = octx.getImageData(0, 0, w, h).data; }
  catch (e) { return null; }
  const a = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = data[i * 4 + 3];
  return { w, h, a };
}
// Flat list of every building sprite Image across all ids/facings.
function allBuildingImages() {
  const out = [];
  for (const id of Object.keys(G.buildingImages)) {
    for (const facing of Object.keys(G.buildingImages[id])) out.push(G.buildingImages[id][facing]);
  }
  return out;
}
// Flat list of every mineable sprite Image across all types/variants.
function allOreImages() {
  const out = [];
  for (const typeId of Object.keys(G.oreImages)) out.push(...G.oreImages[typeId]);
  return out;
}
export function buildMasks() {
  for (const img of [...G.stageImages, ...G.treeImages, ...allOreImages(), ...allBuildingImages()]) {
    if (img && img.complete && img.naturalWidth) img._mask = buildMask(img);
  }
}

// A solid-black, alpha-preserving copy of a sprite, used as its drop shadow.
// We also cache the opaque foot geometry (oc._sb) so the grounding pool can be
// centred under where the object actually meets the ground, not the raw image
// centre (matters for off-centre art like the rocks).
export function buildShadow(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  const oc = document.createElement("canvas");
  oc.width = w; oc.height = h;
  const octx = oc.getContext("2d");
  octx.drawImage(img, 0, 0);
  const data = octx.getImageData(0, 0, w, h).data; // alpha read before recolour
  octx.globalCompositeOperation = "source-in"; // keep alpha, replace color
  octx.fillStyle = "#000";
  octx.fillRect(0, 0, w, h);
  let minx = w, maxx = -1, maxy = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
    }
  }
  // foot centre = mean x over the bottom few opaque rows (the ground contact)
  let fsum = 0, fcount = 0;
  for (let y = Math.max(0, maxy - 5); y <= maxy && maxy >= 0; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) { fsum += x; fcount++; }
    }
  }
  oc._sb = {
    footX: fcount ? fsum / fcount : w / 2,
    maxy: maxy < 0 ? h - 1 : maxy,
    w: (maxx >= minx) ? (maxx - minx + 1) : w,
  };
  return oc;
}
// A radial black->transparent disc, baked once and reused as the soft
// grounding pool under every object (cheaper than a per-frame gradient).
export function buildPool() {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const cx = c.getContext("2d");
  const g = cx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(0.55, "rgba(0,0,0,0.5)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, S, S);
  return c;
}
export function buildShadows() {
  G.poolSprite = buildPool();
  for (const img of [...G.stageImages, ...G.treeImages, ...allOreImages(), ...Object.values(G.resImages), ...allBuildingImages(), ...(G.decorImages || [])]) {
    if (img && img.complete && img.naturalWidth) img._shadow = buildShadow(img);
  }
}

// --- Image loading ----------------------------------------------------
export function loadImages() {
  const pending = [];
  const queue = (store, key, src) => {
    const img = new Image();
    store[key] = img;
    pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = src; }));
  };
  for (const id of Object.keys(GD.tiles)) queue(G.images, id, GD.tiles[id].src);
  const waterBases = GD.water.bases;
  for (const key of Object.keys(waterBases)) {
    const arr = (G.waterImages[key] = []);
    for (let f = 1; f <= GD.water.frames; f++) {
      const img = new Image();
      arr.push(img);
      pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = `assets/tiles/${waterBases[key]}_${f}.png`; }));
    }
  }
  GD.objects.tree.stageSprites.forEach((src, i) => queue(G.stageImages, i, src));
  GD.objects.tree.matureSprites.forEach((src, i) => queue(G.treeImages, i, src));
  // Grass tile variants (biome-selected per cell; index 0 = base grass.png).
  const grassVariants = (GD.worldgen.grass && GD.worldgen.grass.variants) || [];
  G.grassVariants = [];
  grassVariants.forEach((src, i) => {
    const img = (G.grassVariants[i] = new Image());
    pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = src; }));
  });
  // Cosmetic ground-cover decoration sprites (flowers / grass patches), drawn as
  // objects (lifted sprite + cast shadow) in the entity pass.
  const decorSprites = (GD.worldgen.decor && GD.worldgen.decor.sprites) || [];
  G.decorImages = [];
  decorSprites.forEach((src, i) => {
    const img = (G.decorImages[i] = new Image());
    pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = src; }));
  });
  // Mineable variant sprites, keyed by type id (rock, iron_vein, gold_vein).
  for (const typeId of MINEABLE_TYPES) {
    const arr = (G.oreImages[typeId] = []);
    (GD.objects[typeId].variantSprites || []).forEach((src, i) => {
      const img = (arr[i] = new Image());
      pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = src; }));
    });
  }
  // Resource pickup icons, keyed by resource id (wood, stone, ...).
  for (const kind of Object.keys(GD.resources)) {
    const img = (G.resImages[kind] = new Image());
    pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = GD.resources[kind].icon; }));
  }
  // Tool cursor sprites, keyed by tool id (hatchet, pickaxe, ...).
  for (const toolType of Object.keys(GD.tools)) {
    const img = (G.toolImages[toolType] = new Image());
    pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = GD.tools[toolType].icon; }));
    // Broken-tool icon (floats over an idle hut that has run out of this tool).
    const brokenSrc = GD.tools[toolType].brokenIcon;
    if (brokenSrc) {
      const bimg = (G.brokenIcons[toolType] = new Image());
      pending.push(new Promise((res) => { bimg.onload = res; bimg.onerror = res; bimg.src = brokenSrc; }));
    }
  }
  // Building sprites, keyed by building id then facing (SE, SW).
  for (const id of Object.keys(GD.buildings)) {
    const facings = (G.buildingImages[id] = {});
    for (const facing of Object.keys(GD.buildings[id].sprites)) {
      const img = (facings[facing] = new Image());
      pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = GD.buildings[id].sprites[facing]; }));
    }
    // Optional animated smoke/effect frames (e.g. the Forge chimney smoke).
    const smoke = GD.buildings[id].smoke;
    if (smoke && smoke.frames) {
      const arr = (G.smokeImages[id] = []);
      smoke.frames.forEach((src, i) => {
        const img = (arr[i] = new Image());
        pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = src; }));
      });
    }
  }
  return Promise.all(pending);
}
