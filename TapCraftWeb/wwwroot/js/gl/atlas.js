// TapCraft - runtime texture atlas for the WebGL renderer.
//
// The game loads dozens of individual sprite PNGs (tiles, water frames, trees,
// ore, buildings, decoration, drops) plus runtime-baked shadow silhouettes and a
// grounding-pool disc. For batched GPU rendering they must live in ONE texture, so
// after all images are loaded we PACK every unique source image/canvas into a single
// offscreen canvas (a simple shelf packer) and record a UV rect per source. The GL
// renderer uploads that canvas as one texture; `uvFor(img)` maps "the sprite the game
// chose" -> its atlas UV. This keeps the entire asset pipeline + sprite-selection
// logic unchanged: only the draw call changes.
"use strict";

import { G } from "../state.js";

// source image/canvas -> { u0, v0, u1, v1, w, h }  (UVs normalized 0..1)
let uv = new Map();
let atlasCanvas = null;

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function dim(img) { return [img.naturalWidth || img.width || 0, img.naturalHeight || img.height || 0]; }

// Every unique drawable source the GL renderer can blit, deduped. Includes each
// sprite's baked black `_shadow` silhouette and the shared grounding `poolSprite`.
function collectSources() {
  const set = new Set();
  const add = (img) => { if (img) { const [w, h] = dim(img); if (w && h) set.add(img); } };
  for (const k of Object.keys(G.images)) add(G.images[k]);
  for (const img of (G.grassVariants || [])) add(img);
  for (const img of (G.snowVariants || [])) add(img);
  for (const img of (G.iceVariants || [])) add(img);
  for (const img of (G.transGrassSnow || [])) add(img);
  for (const img of (G.transDirtSnow || [])) add(img);
  for (const img of (G.transGrassDirt || [])) add(img);
  for (const k of Object.keys(G.waterImages)) for (const f of G.waterImages[k]) add(f);
  for (const img of G.stageImages) add(img);
  for (const img of G.treeImages) add(img);
  for (const k of Object.keys(G.oreImages)) for (const img of G.oreImages[k]) add(img);
  for (const img of (G.decorImages || [])) add(img);
  for (const id of Object.keys(G.buildingImages)) {
    const set2 = G.buildingImages[id];
    for (const f of Object.keys(set2)) add(set2[f]);
  }
  for (const id of Object.keys(G.smokeImages)) for (const img of G.smokeImages[id]) add(img);
  for (const k of Object.keys(G.resImages)) add(G.resImages[k]);
  for (const k of Object.keys(G.brokenIcons)) add(G.brokenIcons[k]);
  // Baked shadow silhouettes hang off each source image; add them as their own cells.
  const shadows = [];
  for (const img of set) if (img._shadow) shadows.push(img._shadow);
  for (const s of shadows) add(s);
  add(G.poolSprite);
  return [...set];
}

// Pack sources into rows (shelf packer): sort tall-first, lay left-to-right, wrap when
// a row would overflow `maxW`, 1px padding to avoid bilinear/edge bleed.
function shelfPack(sources, maxW) {
  const pad = 1;
  const items = sources.map((img) => { const [w, h] = dim(img); return { img, w, h }; })
    .sort((a, b) => b.h - a.h);
  let x = pad, y = pad, rowH = 0, usedW = pad;
  for (const it of items) {
    if (x + it.w + pad > maxW) { x = pad; y += rowH + pad; rowH = 0; } // new shelf
    it.x = x; it.y = y;
    x += it.w + pad;
    rowH = Math.max(rowH, it.h);
    usedW = Math.max(usedW, x + pad);
  }
  return { items, w: usedW, h: y + rowH + pad };
}

// Build the atlas canvas + UV map from the currently-loaded images. Call once images
// are loaded and shadows baked (main.js, after buildShadows). Returns the canvas to
// upload as the GL texture, or null if there is nothing to pack.
export function buildAtlas() {
  const sources = collectSources();
  if (!sources.length) return null;
  // Estimate a square-ish width so the atlas isn't a long thin strip.
  const area = sources.reduce((s, img) => { const [w, h] = dim(img); return s + (w + 1) * (h + 1); }, 0);
  let maxW = Math.min(4096, Math.max(256, nextPow2(Math.ceil(Math.sqrt(area)))));
  let packed = shelfPack(sources, maxW);
  // If it spilled taller than wide by a lot, widen once (keeps it inside texture caps).
  if (packed.h > maxW && maxW < 4096) { maxW = Math.min(4096, maxW * 2); packed = shelfPack(sources, maxW); }
  const aw = nextPow2(packed.w), ah = nextPow2(packed.h);
  const c = document.createElement("canvas");
  c.width = aw; c.height = ah;
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = false;
  uv = new Map();
  for (const it of packed.items) {
    cx.drawImage(it.img, it.x, it.y, it.w, it.h);
    uv.set(it.img, {
      u0: it.x / aw, v0: it.y / ah,
      u1: (it.x + it.w) / aw, v1: (it.y + it.h) / ah,
      w: it.w, h: it.h,
    });
  }
  atlasCanvas = c;
  return c;
}

// UV rect for a source image/canvas, or null if it is not in the atlas (e.g. failed to
// load) - callers skip drawing in that case, mirroring the old complete/naturalWidth guard.
export function uvFor(img) { return img ? (uv.get(img) || null) : null; }
export function atlasImage() { return atlasCanvas; }
