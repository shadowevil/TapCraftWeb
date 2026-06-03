// TapCraft - canvas rendering: sprites, shadows, the world, ground drops.
// Moved verbatim from the original game.js IIFE.
"use strict";

import {
  SPRITE, HALF_W, HALF_H, DEFAULT_Y_OFFSET,
  SHADOW_ALPHA, SHADOW_SKEW, SHADOW_SQUASH,
  SHADOW_POOL_ALPHA, SHADOW_POOL_RATIO, DROP_SCALE, SHADOW_MIN_ZOOM, WATER_ANIM_MIN_ZOOM, DECOR_MIN_ZOOM, SHADOW_SKIP_COUNT,
} from "./config.js";
import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { canvas, ctx, craftedHud } from "./dom.js";
import { hash01, inBounds } from "./rng.js";
import { plantSprite, tileSprite, waterFrameIndex } from "./assets.js";
import {
  cellCenter, worldToScreen, screenToWorld, worldToCell,
  visibleCellBounds, spriteRect, spriteRectAt,
  buildingAnchor, buildingDiamondWorld, buildingCells,
} from "./iso.js";
import { popFactor, dropImage, dropScreen } from "./resources.js";
import { canPlaceFootprint, canAffordBuilding, buildingTargets, cellsInRange, hutToolKind, hutToolCount } from "./buildings.js";
import { mineableAt, mineableSprite } from "./mineable.js";
import { tileAt, stageAt, progressAt, chopAt, rockRawAt, baseCacheSize, decorAt, shoreDist, biomeAt, moistureAt, landHeightAt, uplandAt, wrapCol, wrapRow, hydroClassAt, iceAt, temperatureAt, snownessAt, desertAt, modsSize, clampBox } from "./cells.js";
import * as glr from "./gl/glrender.js";
import { uvFor } from "./gl/atlas.js";
import { PERF, pBegin, pEnd, pCount } from "./perf.js";
import { renderAmbient, ambientCounts } from "./ambient.js";
import { envTint, shadowMul, weatherDim, weatherCloud, weatherRain, weatherKind } from "./env.js";
import { renderRain, renderLightning, activeSplashes, drawSplash } from "./weather.js";
import { positionBuildingPanel, updateBuildHint, updateDayCounter, updateBuildPanel } from "./ui.js";

// Globe: buildings (and their rings/panel) are drawn from a LIST at their canonical
// column, but the floor/objects wrap seamlessly by drawing the raw column. So shift a
// building's column to the wrapped copy nearest a reference column (the view center or
// the cursor) before drawing, so it appears in every wrapped view. Identity otherwise.
export function wrapColTo(col, refCol) {
  if (!G.world.wrapX) return col;
  const n = G.world.cols;
  return col + Math.round((refCol - col) / n) * n;
}
export function wrapRowTo(row, refRow) {
  if (!G.world.wrapY) return row;
  const n = G.world.rows;
  return row + Math.round((refRow - row) / n) * n;
}

// Sprite + placement for a plant cell (shared by render and hit-testing so
// they always agree on size/lift/flip).
export function plantDrawParams(stage, c, r) {
  const img = plantSprite(stage, c, r);
  if (!img) return null;
  // The tree object's data-driven yOffset (fallback to the engine default). Stage 0 is a
  // small dirt mound OBJECT on the grass, so it shares the same yOffset as the other stages.
  const yOffset = (GD.objects.tree.yOffset != null) ? GD.objects.tree.yOffset : DEFAULT_Y_OFFSET;
  if (stage === 0) return { img, yOffset, sc: 1, flip: false };
  const flip = hash01(c, r, (G.world.seed ^ 0x000000a1) >>> 0) < 0.5;
  const sc = 0.9 + hash01(c, r, (G.world.seed ^ 0x000000b2) >>> 0) * 0.2;
  return { img, yOffset, sc, flip };
}

// The object occupying a cell (mineable takes precedence; a cell never has both),
// with the draw params render and hit-testing share. null if the cell is bare.
// A mineable returns kind = its type id (rock/iron_vein/gold_vein) + mineable:true.
export function cellObject(c, r) {
  const m = mineableAt(c, r);
  if (m) {
    const img = mineableSprite(m);
    if (!img) return null;
    // The object's data-driven yOffset, with an optional per-variant override (variantYOffset,
    // e.g. small fieldstones sit higher); fallback to the engine default.
    const def = GD.objects[m.typeId] || {};
    const vyo = def.variantYOffset;
    const yOffset = (vyo && vyo[m.variant] != null) ? vyo[m.variant]
      : (def.yOffset != null) ? def.yOffset : DEFAULT_Y_OFFSET;
    return { kind: m.typeId, mineable: true, img, yOffset, sc: 1, flip: false, variant: m.variant };
  }
  const st = stageAt(c, r);
  if (st >= 0) {
    const dp = plantDrawParams(st, c, r);
    if (!dp) return null;
    return { kind: "tree", img: dp.img, yOffset: dp.yOffset, sc: dp.sc, flip: dp.flip, stage: st };
  }
  return null;
}

// Pixel-perfect hit test: the front-most targetable object whose opaque
// pixels are under the screen point (px, py), or null. Tests the un-popped
// sprite so the hitbox stays stable during the click "pop".
// Max object sprite extent (image px) used to bound the hit-test window: a tall
// tree rooted behind the cursor can still cover it, so we search a small screen
// box around (px,py) rather than the whole viewport - making hit-testing O(1) in
// the visible-cell count (critical when zoomed far out over a huge world).
const HIT_HMAX = 128, HIT_WMAX = 80;
export function objectAt(px, py) {
  if (!G.hasWorld) return null;
  const z = G.cam.zoom;
  // Screen box around the cursor -> the (small) range of cells whose sprites
  // could overlap it. Generous in every direction so no hit is missed.
  const pts = [
    screenToWorld(px - HIT_WMAX * z, py - HIT_HMAX * z),
    screenToWorld(px + HIT_WMAX * z, py - HIT_HMAX * z),
    screenToWorld(px - HIT_WMAX * z, py + HIT_HMAX * z),
    screenToWorld(px + HIT_WMAX * z, py + HIT_HMAX * z),
  ];
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const p of pts) {
    const cell = worldToCell(p.x, p.y);
    if (cell.col < minC) minC = cell.col; if (cell.col > maxC) maxC = cell.col;
    if (cell.row < minR) minR = cell.row; if (cell.row > maxR) maxR = cell.row;
  }
  const c0 = Math.floor(minC) - 1, c1 = Math.ceil(maxC) + 1;
  const r0 = Math.floor(minR) - 1, r1 = Math.ceil(maxR) + 1;
  for (let r = r1; r >= r0; r--) {          // front-to-back (reverse paint order)
    for (let c = c1; c >= c0; c--) {
      if (!inBounds(c, r)) continue;
      const obj = cellObject(c, r);
      if (!obj || !obj.img.complete || !obj.img.naturalWidth) continue;
      const t = GD.objects[obj.kind];
      if (!t || !t.targetable) continue;
      const img = obj.img;
      const w = img.naturalWidth || SPRITE, h = img.naturalHeight || SPRITE;
      const center = cellCenter(c, r);
      const s = worldToScreen(center.x, center.y);
      const dw = w * z * obj.sc, dh = h * z * obj.sc;
      const tx = s.x - dw / 2;
      const ty = s.y - obj.yOffset * z + (SPRITE / 2) * z - dh; // yOffset scales with zoom
      if (px < tx || px >= tx + dw || py < ty || py >= ty + dh) continue;
      let sx = (px - tx) / (z * obj.sc);
      const sy = (py - ty) / (z * obj.sc);
      if (obj.flip) sx = w - sx;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      const mask = img._mask;
      if (!mask || mask.a[iy * w + ix] > 16) {
        return { col: c, row: r, kind: obj.kind, mineable: !!obj.mineable, stage: obj.stage, variant: obj.variant };
      }
    }
  }
  return null;
}

// Pixel-perfect hit test for a placed building: the front-most building whose
// opaque pixels are under (px,py), or null. Buildings have no flip (explicit
// SE/SW art). Sorted front-to-back by footprint front tile (largest r+c).
export function buildingAt(px, py) {
  if (!G.hasWorld || !G.world.buildings.length) return null;
  const z = G.cam.zoom;
  // Globe: test each building at its wrapped copy nearest the cursor's cell, so a
  // building is clickable in any loop (it still returns the canonical building).
  const refCell = (G.world.wrapX || G.world.wrapY) ? worldToCell(screenToWorld(px, py).x, screenToWorld(px, py).y) : null;
  const refCol = refCell ? refCell.col : 0, refRow = refCell ? refCell.row : 0;
  const order = G.world.buildings
    .map((b) => ({ b, depth: (b.row + 1) + (b.col + 1) }))
    .sort((a, b) => b.depth - a.depth); // front-most first
  for (const { b } of order) {
    const img = buildingSprite(b);
    if (!img || !img.complete || !img.naturalWidth) continue;
    const w = img.naturalWidth || SPRITE, h = img.naturalHeight || SPRITE;
    const a = buildingAnchor(wrapColTo(b.col, refCol), wrapRowTo(b.row, refRow));
    const dw = w * z, dh = h * z;
    const tx = a.x - dw / 2, ty = a.y - dh;
    if (px < tx || px >= tx + dw || py < ty || py >= ty + dh) continue;
    const ix = Math.floor((px - tx) / z), iy = Math.floor((py - ty) / z);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
    const mask = img._mask;
    if (!mask || mask.a[iy * w + ix] > 16) return b;
  }
  return null;
}

// Top-left of a sprite drawn on cell-anchor `s` (shared by sprite + shadow).
export function blitImage(img, tx, ty, dw, dh, flip) {
  if (flip) {
    ctx.save();
    ctx.translate(tx + dw, ty);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(img, tx, ty, dw, dh);
  }
}
export function drawSprite(img, s, z, yOffset, sc, flip) {
  const r = spriteRect(img, s, z, yOffset, sc);
  blitImage(img, r.tx, r.ty, r.dw, r.dh, flip);
}
// Cast a sprite's pre-built black silhouette so it lies on the ground: pin it
// at the sprite's base and shear + squash it, so taller parts of the sprite
// project further down-left like a real shadow. `centerX` is the screen x the
// cast pivots around; `unit` is the px-per-image-px scale (z * sc).
export function drawShadowRect(img, centerX, r, unit, flip) {
  const sh = img._shadow;
  if (!sh) return;
  const meta = sh._sb;
  // Pin to the true opaque foot, not the image's bottom edge: saplings, rocks
  // etc. have transparent padding below the art, so anchoring to the image
  // edge would float the pool/cast below where the object actually stands.
  const footRows = meta ? (meta.maxy + 1) : (img.naturalHeight || SPRITE);
  const groundY = r.ty + footRows * unit;        // screen y of the foot
  // 1) Grounding pool: a soft ellipse under the foot so the shadow reads as
  //    anchored/centred instead of hanging off to one side.
  if (G.poolSprite && meta) {
    const fx = r.tx + meta.footX * unit;         // screen x of the foot
    const pw = meta.w * 0.9 * unit;              // pool width ~ footprint
    const ph = pw * SHADOW_POOL_RATIO;
    ctx.globalAlpha = SHADOW_POOL_ALPHA * frameShadowMul;
    ctx.drawImage(G.poolSprite, fx - pw / 2, groundY - ph / 2, pw, ph);
    ctx.globalAlpha = 1;
  }
  // 2) Directional cast: the silhouette sheared up-left and squashed flat,
  //    with the opaque foot row pinned to groundY (so it meets the pool).
  //    a=x-scale (flip), b=0, c=horizontal shear, d=vertical squash. Columns
  //    higher up the sprite (more negative local y) lean further left.
  ctx.save();
  ctx.globalAlpha = SHADOW_ALPHA * frameShadowMul;
  ctx.translate(centerX, groundY);
  ctx.transform(flip ? -1 : 1, 0, SHADOW_SKEW, SHADOW_SQUASH, 0, 0);
  ctx.drawImage(sh, -r.dw / 2, -footRows * unit, r.dw, r.dh);
  ctx.restore();
  ctx.globalAlpha = 1;
}
export function drawShadow(img, s, z, yOffset, sc, flip) {
  if (!img._shadow) return;
  drawShadowRect(img, s.x, spriteRect(img, s, z, yOffset, sc), z * sc, flip);
}

// Floating top-face diamond for the active cell. Drawn in two halves so the
// object can sit between them: back (upper) edges behind it, front (lower)
// edges in front - the ring wraps around the object.
export function tileDiamond(s, z) {
  const lift = 8 + Math.sin(G.animTime * 0.004) * 3; // hover ~8px up, bob +-3px
  const cy = s.y - lift;
  const hw = HALF_W * z, hh = HALF_H * z;
  return {
    top: { x: s.x, y: cy - hh },
    right: { x: s.x + hw, y: cy },
    bottom: { x: s.x, y: cy + hh },
    left: { x: s.x - hw, y: cy },
  };
}
export function strokeDiamondHalf(d, part) {
  ctx.beginPath();
  if (part === "back") {
    ctx.moveTo(d.left.x, d.left.y);
    ctx.lineTo(d.top.x, d.top.y);
    ctx.lineTo(d.right.x, d.right.y);
  } else {
    ctx.moveTo(d.right.x, d.right.y);
    ctx.lineTo(d.bottom.x, d.bottom.y);
    ctx.lineTo(d.left.x, d.left.y);
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.stroke();
}

// --- Buildings -------------------------------------------------------
// The bobbing ring around a whole 2x2 footprint (rear anchor col,row). Same
// shape/halves as tileDiamond, but the four outer block vertices, lifted by
// the same gentle bob so it floats over the building.
export function buildingDiamond(col, row, z) {
  const lift = 8 + Math.sin(G.animTime * 0.004) * 3;
  const w = buildingDiamondWorld(col, row);
  const pt = (p) => { const s = worldToScreen(p.x, p.y); return { x: s.x, y: s.y - lift }; };
  return { top: pt(w.top), right: pt(w.right), bottom: pt(w.bottom), left: pt(w.left) };
}
export function buildingSprite(b) {
  const set = G.buildingImages[b.type];
  if (!set) return null;
  return set[b.facing] || set.SE || null;
}
// Draw a placed building (shadow then sprite) bottom-center anchored at its
// footprint's front-bottom vertex. `bright` lifts brightness for hover.
export function drawBuilding(b, z, bright) {
  const img = buildingSprite(b);
  if (!img || !img.complete || !img.naturalWidth) return; // naturalWidth 0 = broken/404
  const a = buildingAnchor(b.col, b.row);
  const r = spriteRectAt(img, a, z, 0, 1);
  if (z >= SHADOW_MIN_ZOOM) drawShadowRect(img, a.x, r, z, false);
  if (bright) ctx.filter = "brightness(1.5)";
  ctx.drawImage(img, r.tx, r.ty, r.dw, r.dh);
  if (bright) ctx.filter = "none";
}

// Per-cell draw params for a cosmetic decoration sprite: deterministic flip + slight
// scale jitter (so a field of decorations does not look stamped) and a small
// data-driven yOffset. Mirrors plantDrawParams. Returns null if the sprite is not ready.
function decorDrawParams(idx, c, r) {
  const img = G.decorImages[idx];
  if (!img || !img.complete || !img.naturalWidth) return null;
  const flip = hash01(c, r, (G.world.seed ^ 0x000000c3) >>> 0) < 0.5;
  const sc = 0.8 + hash01(c, r, (G.world.seed ^ 0x000000d4) >>> 0) * 0.35;
  const dec = GD.worldgen.decor || {};
  // Per-sprite yOffset override (spriteYOffset, keyed by sprite index) over the decor default.
  const syo = dec.spriteYOffset;
  const yOffset = (syo && syo[idx] != null) ? syo[idx] : (dec.yOffset != null) ? dec.yOffset : 0;
  return { img, yOffset, sc, flip };
}

// Draw a single cell's object (rock/tree) OR, on a bare cell, its cosmetic decoration
// (flower/grass patch) - with the shadow, click-pop scale (objects only), hover
// brighten (objects only), and - if it is the active cell - the bobbing outline ring
// wrapping it. Decorations are drawn like objects but never pop/highlight and are not
// targetable. Used by the unified entity pass so all three interleave by depth.
function drawCellObject(c, r, z, activeCell, obj, decorIdx) {
  const isActive = activeCell && activeCell.col === c && activeCell.row === r;
  // Resolve the sprite: a targetable object owns the cell; otherwise a decoration.
  let img = null, yOffset = DEFAULT_Y_OFFSET, sc = 1, flip = false, decor = false;
  if (obj && obj.img.complete && obj.img.naturalWidth) {
    img = obj.img; yOffset = obj.yOffset; sc = obj.sc * popFactor(c, r); flip = obj.flip;
  } else if (decorIdx >= 0) {
    const dp = decorDrawParams(decorIdx, c, r);
    if (dp) { img = dp.img; yOffset = dp.yOffset; sc = dp.sc; flip = dp.flip; decor = true; }
  }
  if (!img) {
    // Active empty/flat cell still needs its ground ring (no object to wrap).
    if (isActive) { const s = worldToScreen(cellCenter(c, r).x, cellCenter(c, r).y); const d = tileDiamond(s, z); strokeDiamondHalf(d, "back"); strokeDiamondHalf(d, "front"); }
    return;
  }
  const s = worldToScreen(cellCenter(c, r).x, cellCenter(c, r).y);
  const diamond = isActive ? tileDiamond(s, z) : null;
  if (diamond) strokeDiamondHalf(diamond, "back");
  if (z >= SHADOW_MIN_ZOOM && !frameShadowSkip) drawShadow(img, s, z, yOffset, sc, flip); // cast before the sprite (skipped in dense scenes)
  const hl = !decor && G.hover && G.hover.col === c && G.hover.row === r;
  if (hl) ctx.filter = "brightness(1.6)";
  drawSprite(img, s, z, yOffset, sc, flip);
  if (hl) ctx.filter = "none";
  if (diamond) strokeDiamondHalf(diamond, "front");
}

// Draw a placed building with its hover/selected ring and (when out of tools)
// the floating broken-tool icon. Used by the unified entity pass.
function drawBuildingEntity(bd, z) {
  const ringed = bd.id === G.hoverBuilding || bd.id === G.selectedBuilding;
  const ring = ringed ? buildingDiamond(bd.col, bd.row, z) : null;
  if (ring) strokeDiamondHalf(ring, "back");
  drawBuilding(bd, z, bd.id === G.hoverBuilding);
  if (ring) strokeDiamondHalf(ring, "front");
  // Out of tools -> idle: float the broken-tool icon gently above the hut.
  // ONLY harvester huts use tools; smelters/crafting buildings have no tool slot
  // and no targetKind, so hutToolKind/hutToolCount would throw for them - which
  // (inside this per-entity draw) would abort the whole entity pass mid-paint.
  if (GD.buildings[bd.type].category === "harvester" && hutToolCount(bd) <= 0) {
    const icon = G.brokenIcons[hutToolKind(bd)];
    if (icon && icon.complete && icon.naturalWidth) {
      const a = buildingAnchor(bd.col, bd.row);
      const bob = Math.sin(G.animTime * 0.004) * 4;            // gentle up/down glide
      const iw = icon.naturalWidth * z, ih = icon.naturalHeight * z;
      const cx = a.x, cy = a.y - (62 * z) - bob;               // float above the roof
      ctx.globalAlpha = 0.8;                                   // semi-transparent hint
      ctx.drawImage(icon, cx - iw / 2, cy - ih, iw, ih);
      ctx.globalAlpha = 1;
    }
  }
  drawSmoke(bd, z);
}

// Animated chimney smoke above a building (data: GD.buildings[type].smoke).
// Crossfades through the frames while gently bobbing, drawn at map scale and
// reduced opacity. The plume is anchored bottom-center on the per-facing stack
// point - given in image pixels from the building sprite's top-left - so it
// rises out of the chimney. A per-building phase offset keeps multiple forges
// from pulsing in unison.
function drawSmoke(bd, z) {
  const sdef = GD.buildings[bd.type].smoke;
  if (!sdef) return;
  const frames = G.smokeImages[bd.type];
  if (!frames || !frames.length) return;
  const anchor = (sdef.anchor && (sdef.anchor[bd.facing] || sdef.anchor.SE));
  if (!anchor) return;
  const bimg = buildingSprite(bd);
  if (!bimg || !bimg.complete || !bimg.naturalWidth) return;
  const a = buildingAnchor(bd.col, bd.row);
  const r = spriteRectAt(bimg, a, z, 0, 1);              // building sprite screen rect
  const stackX = r.tx + anchor[0] * z;                  // chimney point on screen
  const stackY = r.ty + anchor[1] * z;
  const off = bd.col * 131 + bd.row * 197;              // desync per building
  const t = G.animTime + off;
  const bob = Math.sin(t * (2 * Math.PI) / (sdef.bobMs || 1800)) * (sdef.bobPx || 2) * z;
  const baseY = stackY + bob;
  const n = frames.length;
  const phase = t / (sdef.frameMs || 450);
  const i = ((Math.floor(phase) % n) + n) % n;
  const f = phase - Math.floor(phase);                  // 0..1 blend to the next frame
  const op = (sdef.opacity != null) ? sdef.opacity : 0.75;
  const unit = z * (sdef.scale || 1);
  drawSmokeFrame(frames[i], stackX, baseY, unit, op * (1 - f));
  drawSmokeFrame(frames[(i + 1) % n], stackX, baseY, unit, op * f);
}
function drawSmokeFrame(img, cx, baseY, unit, alpha) {
  if (!img || !img.complete || !img.naturalWidth || alpha <= 0.001) return;
  const w = img.naturalWidth * unit, h = img.naturalHeight * unit;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, cx - w / 2, baseY - h, w, h);      // bottom-center at (cx, baseY)
  ctx.globalAlpha = 1;
}

// --- Floor cache -----------------------------------------------------
// The floor (ground tiles) only changes when the camera pans/zooms or the water
// frame advances - tiles themselves never change at runtime. Rather than redraw
// every visible tile each frame (thousands of drawImage calls when zoomed out),
// we render the floor once into an offscreen canvas and blit it; it is only
// re-rendered when its signature changes. The offscreen canvas mirrors the main
// canvas backing + DPR transform so the blit is a 1:1 device-pixel copy.
// 2D fallback floor cache (scrolling): the offscreen holds the floor for the viewport plus a
// FLOOR_2D_MARGIN-px ring, rendered relative to floorRefCam. A pan just BLITS the cached layer
// shifted by the integer camera delta (no per-tile redraw); it is re-rendered only when the
// zoom/water frame changes or the camera scrolls past the margin ring. floorRefValid gates the
// first render / forced redraws.
let floorCanvas = null, floorCtx = null;
let floorRefCamX = 0, floorRefCamY = 0, floorCacheZoom = -1, floorCacheWater = -1, floorRefValid = false;
const FLOOR_2D_MARGIN = 160; // CSS px ring rendered beyond the viewport (covers a pan before re-render)
// The GL floor is emitted in WORLD-screen space and panned via a shader uniform, so it is
// rebuilt only when the zoom changes or the view scrolls past the emitted margin (NOT on a
// plain pan). glFloorBox is the cell range currently baked into the buffer; glFloorZoom the
// zoom it was emitted at. FLOOR_EMIT_MARGIN is the extra cell ring emitted around the visible
// box so small pans stay inside the cached buffer (fewer rebuilds during a drag).
let glFloorBox = null, glFloorZoom = -1;
let glFloorRefC = 0, glFloorRefR = 0; // reference cell the floor instances are emitted relative to
const FLOOR_EMIT_MARGIN = 6;
// DEV live-reload (gamedata.js): when an edited pack is hot-applied, drop the floor cache so
// tile-appearance tweaks redraw immediately (entity-pass data already re-reads GD each frame).
window.addEventListener("tapcraft:packreload", () => { floorRefValid = false; glFloorBox = null; });
let glWasOn = false; // was the GL path active last frame (force a floor rebuild when it resumes)
let glWaterTiles = [];     // [{idx,c,r}] cached-floor instance indices of visible water tiles
let glWaterFrameCached = -1; // the water frame currently baked into the cached floor buffer
let frameShadowMul = 1; // object-shadow alpha multiplier for this frame (day/night)
let frameShadowSkip = false; // this frame, skip object cast shadows (too many entities)
function ensureFloorCanvas() {
  const dpr = window.devicePixelRatio || 1;
  // Offscreen = viewport + a margin ring on every side (so a pan can blit instead of redraw).
  const wantW = Math.ceil((canvas.clientWidth + 2 * FLOOR_2D_MARGIN) * dpr);
  const wantH = Math.ceil((canvas.clientHeight + 2 * FLOOR_2D_MARGIN) * dpr);
  if (!floorCanvas) { floorCanvas = document.createElement("canvas"); floorCtx = floorCanvas.getContext("2d"); }
  if (floorCanvas.width !== wantW || floorCanvas.height !== wantH) {
    floorCanvas.width = wantW; floorCanvas.height = wantH;
    floorRefValid = false; // size changed -> force a redraw
  }
}
// Cell-range bounding box for an arbitrary CSS screen rect (used to cover the margin-expanded
// 2D floor offscreen). Mirrors visibleCellBounds but for [x0,x1] x [y0,y1] instead of the canvas.
function cellBoundsForRect(x0, y0, x1, y1) {
  const pts = [screenToWorld(x0, y0), screenToWorld(x1, y0), screenToWorld(x0, y1), screenToWorld(x1, y1)];
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const p of pts) {
    const cc = worldToCell(p.x, p.y);
    minC = Math.min(minC, cc.col); maxC = Math.max(maxC, cc.col);
    minR = Math.min(minR, cc.row); maxR = Math.max(maxR, cc.row);
  }
  const M = 2;
  return clampBox(Math.floor(minC) - M, Math.ceil(maxC) + M, Math.floor(minR) - M, Math.ceil(maxR) + M);
}
function renderFloor(b, z, waterFrame) {
  const dpr = window.devicePixelRatio || 1;
  // Origin shifted by the margin so screen point (sx,sy) [relative to the current camera, which
  // is the reference camera at render time] lands at offscreen px (sx+MARGIN, sy+MARGIN)*dpr.
  floorCtx.setTransform(dpr, 0, 0, dpr, FLOOR_2D_MARGIN * dpr, FLOOR_2D_MARGIN * dpr);
  floorCtx.imageSmoothingEnabled = false;
  floorCtx.clearRect(-FLOOR_2D_MARGIN, -FLOOR_2D_MARGIN, canvas.clientWidth + 2 * FLOOR_2D_MARGIN, canvas.clientHeight + 2 * FLOOR_2D_MARGIN);
  const cx = G.cam.x, cy = G.cam.y, half = (SPRITE / 2) * z;
  const ter = GD.worldgen.terrain || {};
  const shMax = ter.shallowTiles || 0, shCol = ter.shallowColor || [150, 205, 225], shA = ter.shallowAlpha || 0;
  const hw = HALF_W * z, hh = HALF_H * z;
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const tile = tileAt(c, r);
      const tImg = tileSprite(tile, c, r, waterFrame);
      if (!tImg || !tImg.complete || !tImg.naturalWidth) continue; // skip broken/404 tiles
      const sx = (c - r) * HALF_W * z + cx, sy = (c + r) * HALF_H * z + cy;
      const dw = (tImg.naturalWidth || SPRITE) * z, dh = (tImg.naturalHeight || SPRITE) * z;
      floorCtx.drawImage(tImg, sx - dw / 2, sy + half - dh, dw, dh);
      // Coastal shallows: a translucent lighter wash over water near land, stronger
      // closer to shore. Cosmetic + pure per-cell, so it bakes into the cached floor.
      if (shMax > 0 && shA > 0 && tile === "water" && !iceAt(c, r)) {
        const sd = shoreDist(c, r);
        if (sd >= 1) {
          floorCtx.fillStyle = "rgba(" + shCol[0] + "," + shCol[1] + "," + shCol[2] + "," + (shA * (1 - (sd - 1) / shMax)) + ")";
          floorCtx.beginPath();
          floorCtx.moveTo(sx, sy - hh); floorCtx.lineTo(sx + hw, sy);
          floorCtx.lineTo(sx, sy + hh); floorCtx.lineTo(sx - hw, sy); floorCtx.closePath();
          floorCtx.fill();
        }
      }
    }
  }
}
// WebGL floor: emit one instance per visible ground tile (no offscreen cache - the GPU
// redraws the whole floor cheaply each frame). Same screen math as renderFloor. Coastal
// shallows are re-added as a per-instance tint in a later phase.
function emitFloorGL(b, z, waterFrame, refC, refR) {
  glWaterTiles.length = 0; // rebuilt with the floor: indices of water tiles for the UV patch
  // World-screen space, RELATIVE to the reference cell (refC,refR): NO camera offset is baked
  // in (the shader adds it via u_cam/setFloorCam), so the cached buffer survives a pan. Emitting
  // relative to the reference keeps instance positions small -> float32-precise even on a globe/
  // infinite world panned far from the origin. Zoom IS baked, hence re-emit on a zoom change.
  const cx = -((refC - refR) * HALF_W) * z, cy = -((refC + refR) * HALF_H) * z;
  const half = (SPRITE / 2) * z;
  const ter = GD.worldgen.terrain || {};
  const shMax = ter.shallowTiles || 0, shA = ter.shallowAlpha || 0;
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const tile = tileAt(c, r);
      const tImg = tileSprite(tile, c, r, waterFrame);
      if (!tImg || !tImg.naturalWidth) continue;
      const sx = (c - r) * HALF_W * z + cx, sy = (c + r) * HALF_H * z + cy;
      const dw = (tImg.naturalWidth || SPRITE) * z, dh = (tImg.naturalHeight || SPRITE) * z;
      // iceAt() goes through the memo string-key path; evaluate it once per water cell.
      const isWater = tile === "water";
      const ice = isWater && iceAt(c, r);
      if (isWater && !ice) glWaterTiles.push({ idx: glr.floorInstanceCount(), c, r }); // ice is static, not animated
      // Coastal shallows: lighten + cyan-shift water near shore via a per-instance tint (the
      // GL stand-in for the 2D translucent overlay). Strength fades with shore distance, and
      // it bakes into the cached floor buffer (pure per-cell, like the 2D version).
      let tint = null;
      if (shMax > 0 && shA > 0 && isWater && !ice) {
        const sd = shoreDist(c, r);
        if (sd >= 1) {
          const s = shA * (1 - (sd - 1) / shMax);
          tint = [1 + s * 1.0, 1 + s * 1.3, 1 + s * 1.7, 1];
        }
      }
      glr.sprite(tImg, sx - dw / 2, sy + half - dh, dw, dh, false, tint);
    }
  }
}

// --- WebGL entity emission (mirror of the 2D draw* helpers; sprites -> GL batch) -------
// Hover/day-night fold into a per-instance premultiplied tint; the active/selection rings
// are vector and stay on the 2D overlay (drawWorldRingsGL). Shadows are emitted freely -
// the GPU makes them cheap, so the dense-scene shadow-skip is irrelevant on the GL path.
const HOVER_TINT = [1.6, 1.6, 1.6, 1];      // object hover brighten (matches brightness 1.6)
const BLD_HOVER_TINT = [1.5, 1.5, 1.5, 1];  // building hover brighten (matches 1.5)
const BROKEN_TINT = [0.8, 0.8, 0.8, 0.8];   // floating broken-tool icon at 0.8 alpha

function emitShadowRectGL(img, centerX, rect, unit, flip) {
  const sh = img._shadow; if (!sh) return;
  const meta = sh._sb;
  const footRows = meta ? (meta.maxy + 1) : (img.naturalHeight || SPRITE);
  const groundY = rect.ty + footRows * unit;
  if (G.poolSprite && meta) {
    const fx = rect.tx + meta.footX * unit;
    const pw = meta.w * 0.9 * unit, ph = pw * SHADOW_POOL_RATIO;
    glr.pool(G.poolSprite, fx, groundY, pw, ph, SHADOW_POOL_ALPHA * frameShadowMul);
  }
  glr.shadowCast(sh, centerX, groundY, rect.dw, rect.dh, footRows, unit, flip, SHADOW_SKEW, SHADOW_SQUASH, SHADOW_ALPHA * frameShadowMul);
}
function emitCellObjectGL(c, r, z, obj, decorIdx) {
  let img = null, yOffset = DEFAULT_Y_OFFSET, sc = 1, flip = false, decor = false;
  if (obj && obj.img.complete && obj.img.naturalWidth) {
    img = obj.img; yOffset = obj.yOffset; sc = obj.sc * popFactor(c, r); flip = obj.flip;
  } else if (decorIdx >= 0) {
    const dp = decorDrawParams(decorIdx, c, r);
    if (dp) { img = dp.img; yOffset = dp.yOffset; sc = dp.sc; flip = dp.flip; decor = true; }
  }
  if (!img) return;
  const s = worldToScreen(cellCenter(c, r).x, cellCenter(c, r).y);
  const rect = spriteRect(img, s, z, yOffset, sc);
  if (z >= SHADOW_MIN_ZOOM) emitShadowRectGL(img, s.x, rect, z * sc, flip);
  const hl = !decor && G.hover && G.hover.col === c && G.hover.row === r;
  glr.sprite(img, rect.tx, rect.ty, rect.dw, rect.dh, flip, hl ? HOVER_TINT : null);
}
function emitBuildingGL(bd, z) {
  const img = buildingSprite(bd);
  if (!img || !img.complete || !img.naturalWidth) return;
  const a = buildingAnchor(bd.col, bd.row);
  const rect = spriteRectAt(img, a, z, 0, 1);
  if (z >= SHADOW_MIN_ZOOM) emitShadowRectGL(img, a.x, rect, z, false);
  glr.sprite(img, rect.tx, rect.ty, rect.dw, rect.dh, false, bd.id === G.hoverBuilding ? BLD_HOVER_TINT : null);
  if (GD.buildings[bd.type].category === "harvester" && hutToolCount(bd) <= 0) {
    const icon = G.brokenIcons[hutToolKind(bd)];
    if (icon && icon.complete && icon.naturalWidth) {
      const bob = Math.sin(G.animTime * 0.004) * 4;
      const iw = icon.naturalWidth * z, ih = icon.naturalHeight * z;
      glr.sprite(icon, a.x - iw / 2, (a.y - 62 * z - bob) - ih, iw, ih, false, BROKEN_TINT);
    }
  }
  emitSmokeGL(bd, z);
}
function emitSmokeGL(bd, z) {
  const sdef = GD.buildings[bd.type].smoke; if (!sdef) return;
  const frames = G.smokeImages[bd.type]; if (!frames || !frames.length) return;
  const anchor = (sdef.anchor && (sdef.anchor[bd.facing] || sdef.anchor.SE)); if (!anchor) return;
  const bimg = buildingSprite(bd); if (!bimg || !bimg.complete || !bimg.naturalWidth) return;
  const rect = spriteRectAt(bimg, buildingAnchor(bd.col, bd.row), z, 0, 1);
  const stackX = rect.tx + anchor[0] * z, stackY = rect.ty + anchor[1] * z;
  const t = G.animTime + (bd.col * 131 + bd.row * 197);
  const bob = Math.sin(t * (2 * Math.PI) / (sdef.bobMs || 1800)) * (sdef.bobPx || 2) * z;
  const baseY = stackY + bob, n = frames.length;
  const phase = t / (sdef.frameMs || 450);
  const i = ((Math.floor(phase) % n) + n) % n, f = phase - Math.floor(phase);
  const op = (sdef.opacity != null) ? sdef.opacity : 0.75, unit = z * (sdef.scale || 1);
  emitSmokeFrameGL(frames[i], stackX, baseY, unit, op * (1 - f));
  emitSmokeFrameGL(frames[(i + 1) % n], stackX, baseY, unit, op * f);
}
function emitSmokeFrameGL(img, cx, baseY, unit, alpha) {
  if (!img || !img.complete || !img.naturalWidth || alpha <= 0.001) return;
  const w = img.naturalWidth * unit, h = img.naturalHeight * unit;
  glr.sprite(img, cx - w / 2, baseY - h, w, h, false, [alpha, alpha, alpha, alpha]);
}
function emitDropsGL(z) {
  for (const d of G.drops) {
    if (d.phase === "fly") continue;
    const img = dropImage(d.kind);
    if (!img || !img.complete || !img.naturalWidth) continue;
    const lw = (img.naturalWidth || 32) * z * DROP_SCALE, lh = (img.naturalHeight || 23) * z * DROP_SCALE;
    const sp = dropScreen(d);
    if (img._shadow) glr.shadowCast(img._shadow, sp.x, sp.y, lw, lh, 1, lh, false, SHADOW_SKEW, SHADOW_SQUASH, SHADOW_ALPHA * frameShadowMul);
    glr.sprite(img, sp.x - lw / 2, sp.y - lh, lw, lh, false, null);
  }
}
// Active-cell + building selection/hover rings (vector) on the 2D overlay, on top of the
// GL world. On GL they sit fully on top instead of wrapping behind the object (accepted).
function drawWorldRingsGL(z, activeCell) {
  if (activeCell) {
    const s = worldToScreen(cellCenter(activeCell.col, activeCell.row).x, cellCenter(activeCell.col, activeCell.row).y);
    const d = tileDiamond(s, z);
    strokeDiamondHalf(d, "back"); strokeDiamondHalf(d, "front");
  }
  // Globe: shift each ringed building to its in-view wrapped copy (both axes; matches
  // where the GL entity pass drew it). The 2D path rings ride the shifted entity, so
  // this is GL-only.
  const ringRef = (G.world.wrapX || G.world.wrapY)
    ? (() => { const bb = visibleCellBounds(); return { c: (bb.c0 + bb.c1) / 2, r: (bb.r0 + bb.r1) / 2 }; })()
    : { c: 0, r: 0 };
  for (const bd of G.world.buildings) {
    if (bd.id === G.hoverBuilding || bd.id === G.selectedBuilding) {
      const ring = buildingDiamond(wrapColTo(bd.col, ringRef.c), wrapRowTo(bd.row, ringRef.r), z);
      strokeDiamondHalf(ring, "back"); strokeDiamondHalf(ring, "front");
    }
  }
}

export function render() {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!G.hasWorld) { G.hover = null; G.hoverTile = null; G.showHatchet = false; G.showPickaxe = false; canvas.style.cursor = "default"; return; }
  frameShadowMul = shadowMul(); // day/night dims object shadows (faint at night)
  const active = !G.inMenu && G.mouse.on;
  const _h0 = pBegin();
  G.hover = active ? objectAt(G.mouse.x, G.mouse.y) : null;
  // Building hover (resource wins): only when no targetable object is under the
  // cursor, and never while placing a new building.
  const hb = (active && !G.hover && !G.buildMode) ? buildingAt(G.mouse.x, G.mouse.y) : null;
  G.hoverBuilding = hb ? hb.id : null;
  if (active) {
    const wpt = screenToWorld(G.mouse.x, G.mouse.y);
    const cell = worldToCell(wpt.x, wpt.y);
    G.hoverTile = inBounds(cell.col, cell.row) ? cell : null;
  } else {
    G.hoverTile = null;
  }
  pEnd("hover", _h0);
  // Tool cursor (OS cursor hidden): hatchet over a choppable tree, pickaxe over
  // any mineable (rock/iron/gold vein). While holding to harvest, lock the tool
  // to the held category ("tree" | "mine").
  if (G.harvesting) {
    G.showHatchet = G.harvestKind === "tree";
    G.showPickaxe = G.harvestKind === "mine";
  } else {
    G.showHatchet = !!(G.hover && G.hover.kind === "tree" && G.hover.stage >= GD.matureStage);
    G.showPickaxe = !!(G.hover && G.hover.mineable);
  }
  const wantCursor = (G.showHatchet || G.showPickaxe) ? "none" : "default";
  if (canvas.style.cursor !== wantCursor) canvas.style.cursor = wantCursor;
  const z = G.cam.zoom;
  const b = visibleCellBounds();
  // Climate immersion: how snowy / desert the view is (center cell), smoothed. Snow drives
  // birds/ambience -> wind (ambient.js / sound.js) + rain -> snow + no lightning; desert
  // thins the rainfall (weather.js). Globe only.
  const ctrC = Math.round((b.c0 + b.c1) / 2), ctrR = Math.round((b.r0 + b.r1) / 2);
  G.viewSnow += ((G.world.wrapX ? snownessAt(ctrC, ctrR) : 0) - G.viewSnow) * 0.04;
  G.viewDesert += ((G.world.wrapX ? desertAt(ctrC, ctrR) : 0) - G.viewDesert) * 0.04;
  // Freeze the water animation when zoomed out so the cached floor stays valid
  // every frame (waves are imperceptible there); animate it only when zoomed in.
  const waterFrame = (z < WATER_ANIM_MIN_ZOOM) ? 0 : waterFrameIndex();
  // The active cell is the hovered tree's cell (if any), else the ground tile.
  const activeCell = G.hover || G.hoverTile;
  // Use the WebGL world renderer when enabled AND the context is ready. A lost GL context
  // makes glReady() false -> automatic fallback to the 2D path until it is restored.
  const useGL = G.useGL && glr.glReady();

  // Floor. GL path: clear the GL canvas + emit the visible tiles to the batch (the GPU
  // redraws the floor cheaply every frame; no offscreen cache). 2D fallback: re-render
  // tiles into the offscreen layer only when its signature (camera/zoom/water/range)
  // changes, else blit the cached layer with one device-pixel copy.
  const _w0 = pBegin();
  if (useGL) {
    glr.beginFrame();
    // Cache the floor instance buffer; rebuild it only when the floor signature changes
    // (camera/zoom/range - NOT the water frame) or when the GL path just resumed (its buffers
    // were recreated). Water animates at EVERY zoom without a rebuild: on a water tick, only
    // the cached water tiles' UVs are rewritten in place (cheap) and the buffer re-uploaded.
    const glWaterFrame = waterFrameIndex(); // GL animates water at all zooms (no 2D-style freeze)
    // Rebuild the floor buffer only when the zoom changed, the GL path just resumed, or the
    // visible box has scrolled past the emitted (margin-padded) box. A plain pan does neither,
    // so it only updates the u_cam uniform below - no per-frame floor re-emit.
    const needFloorEmit = !glWasOn || z !== glFloorZoom || !glFloorBox ||
      b.c0 < glFloorBox.c0 || b.c1 > glFloorBox.c1 || b.r0 < glFloorBox.r0 || b.r1 > glFloorBox.r1;
    if (needFloorEmit) {
      const eb = clampBox(b.c0 - FLOOR_EMIT_MARGIN, b.c1 + FLOOR_EMIT_MARGIN, b.r0 - FLOOR_EMIT_MARGIN, b.r1 + FLOOR_EMIT_MARGIN);
      glFloorRefC = eb.c0; glFloorRefR = eb.r0;
      glr.beginFloor(); emitFloorGL(eb, z, glWaterFrame, glFloorRefC, glFloorRefR); glr.endFloor();
      glFloorBox = eb; glFloorZoom = z; glWaterFrameCached = glWaterFrame;
    } else if (glWaterTiles.length && glWaterFrame !== glWaterFrameCached) {
      for (const w of glWaterTiles) {
        const uv = uvFor(tileSprite("water", w.c, w.r, glWaterFrame));
        if (uv) glr.patchFloorUV(w.idx, uv.u0, uv.v0, uv.u1, uv.v1);
      }
      glr.reuploadFloor();
      glWaterFrameCached = glWaterFrame;
    }
    // Re-add the reference cell + camera in float64, pass the small result as u_cam: floor
    // screen pos = (instance, relative to ref) + u_cam = the same screen pos as before the pan.
    const fz = glFloorZoom;
    glr.setFloorCam((glFloorRefC - glFloorRefR) * HALF_W * fz + G.cam.x, (glFloorRefC + glFloorRefR) * HALF_H * fz + G.cam.y);
    glr.drawFloor();
    // entities + drops emit into the dynamic batch below; flush + env tint happen after them.
  } else {
    ensureFloorCanvas();
    const dpr = window.devicePixelRatio || 1;
    // Re-render the offscreen only when the zoom/water frame changed or the camera has panned
    // past the margin ring; otherwise the cached floor is still valid and we just blit it
    // shifted by the integer camera delta. This keeps a plain pan to a single device-pixel copy.
    const dx = G.cam.x - floorRefCamX, dy = G.cam.y - floorRefCamY;
    if (!floorRefValid || z !== floorCacheZoom || waterFrame !== floorCacheWater ||
        Math.abs(dx) > FLOOR_2D_MARGIN - 1 || Math.abs(dy) > FLOOR_2D_MARGIN - 1) {
      const eb = cellBoundsForRect(-FLOOR_2D_MARGIN, -FLOOR_2D_MARGIN,
        canvas.clientWidth + FLOOR_2D_MARGIN, canvas.clientHeight + FLOOR_2D_MARGIN);
      renderFloor(eb, z, waterFrame);
      floorRefCamX = G.cam.x; floorRefCamY = G.cam.y; floorCacheZoom = z; floorCacheWater = waterFrame; floorRefValid = true;
    }
    const ddx = G.cam.x - floorRefCamX, ddy = G.cam.y - floorRefCamY; // 0 right after a re-render
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);   // identity: blit backing at the device-pixel cam delta
    ctx.drawImage(floorCanvas, Math.round((ddx - FLOOR_2D_MARGIN) * dpr), Math.round((ddy - FLOOR_2D_MARGIN) * dpr));
    ctx.restore();
  }
  pCount("cells", (b.c1 - b.c0 + 1) * (b.r1 - b.r0 + 1));
  pEnd("world", _w0);

  // Entities: collect each visible cell's object (computed once), depth-sort with
  // buildings, draw back-to-front over the floor. Runs every frame (objects grow,
  // animate, highlight on hover). Depth key: 1-tile object uses r+c; a building uses
  // its FRONT tile (row+1)+(col+1). Ties broken by column so the east-most paints last.
  const _e0 = pBegin();
  const entities = [];
  const decorOn = z >= DECOR_MIN_ZOOM;   // skip the decoration probe when zoomed far out
  // Cells under a building footprint: decorations on them despawn (a placed building
  // takes the tile). Built once per frame from the (few) buildings; only when decor is on.
  let decorCovered = null;
  if (decorOn && G.world.buildings.length) {
    decorCovered = new Set();
    // Canonical (wrapped) footprint keys so the probe matches on every torus copy.
    for (const bd of G.world.buildings) {
      for (const [bc, br] of buildingCells(bd.col, bd.row)) decorCovered.add(wrapCol(bc) + "," + wrapRow(br));
    }
  }
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const isActive = activeCell && activeCell.col === c && activeCell.row === r;
      const tile = tileAt(c, r);
      // Water never holds an object (trees/rocks/ore only spawn on land), so skip
      // the per-cell object probe there.
      const obj = (tile === "water") ? null : cellObject(c, r);
      // Cosmetic ground-cover decoration: only on a currently-bare grass cell not under
      // a building. decorAt is base-pure (cacheable); the !obj + !covered guards make it
      // delta-aware so nothing draws under a grown/placed object or a building.
      let decorIdx = -1;
      if (decorOn && !obj && tile === "grass" && !(decorCovered && decorCovered.has(wrapCol(c) + "," + wrapRow(r)))) decorIdx = decorAt(c, r);
      if (obj || isActive || decorIdx >= 0) entities.push({ depth: r + c, col: c, c, r, obj, decorIdx, kind: "obj" });
    }
  }
  // Buildings draw from a list at their canonical cell; on the torus globe, shift each
  // to the wrapped copy nearest the view center (both axes) so it appears in the
  // current loop, and skip copies fully off-screen. The shifted cell feeds depth + anchor.
  const viewCenterC = (b.c0 + b.c1) / 2, viewCenterR = (b.r0 + b.r1) / 2;
  for (const bd of G.world.buildings) {
    const dcol = wrapColTo(bd.col, viewCenterC), drow = wrapRowTo(bd.row, viewCenterR);
    if ((G.world.wrapX && (dcol + 1 < b.c0 - 2 || dcol > b.c1 + 2)) ||
        (G.world.wrapY && (drow + 1 < b.r0 - 2 || drow > b.r1 + 2))) continue;
    const dbd = (dcol === bd.col && drow === bd.row) ? bd : Object.assign({}, bd, { col: dcol, row: drow });
    entities.push({ depth: (drow + 1) + (dcol + 1), col: dcol + 1, bd: dbd, kind: "bld" });
  }
  // Rain ground-splashes: injected at their tile's depth so nearer objects paint
  // over them (a splash never appears on top of a tree/rock - keeps the iso layering).
  for (const sp of activeSplashes()) {
    if (sp.c < b.c0 || sp.c > b.c1 || sp.r < b.r0 || sp.r > b.r1) continue;
    entities.push({ depth: sp.r + sp.c, col: sp.c, c: sp.c, r: sp.r, sp, kind: "splash" });
  }
  entities.sort((a, e) => (a.depth - e.depth) || (a.col - e.col) || (a.kind === "bld" ? -1 : 1));
  // Dense scene -> skip per-object cast shadows (the costly part of each tree draw).
  // Hysteresis: once skipping, only resume shadows once the count falls well below the
  // threshold, so panning a forest edge doesn't flicker shadows on and off.
  frameShadowSkip = entities.length > (frameShadowSkip ? SHADOW_SKIP_COUNT * 0.75 : SHADOW_SKIP_COUNT);
  for (const e of entities) {
    if (useGL) {
      if (e.kind === "bld") emitBuildingGL(e.bd, z);
      else if (e.kind === "splash") drawSplash(e.c, e.r, e.sp, z); // vector splash stays on the 2D overlay
      else emitCellObjectGL(e.c, e.r, z, e.obj, e.decorIdx);
    } else if (e.kind === "bld") {
      drawBuildingEntity(e.bd, z);
    } else if (e.kind === "splash") {
      drawSplash(e.c, e.r, e.sp, z);
    } else {
      drawCellObject(e.c, e.r, z, activeCell, e.obj, e.decorIdx);
    }
  }
  pCount("entities", entities.length);
  pEnd("entities", _e0);

  // Ground drops (resource pickups) drawn on top of the world, each with a
  // matching cast shadow sheared along the ground.
  const _o0 = pBegin();
  if (useGL) {
    emitDropsGL(z);
  } else {
    for (const d of G.drops) {
      if (d.phase === "fly") continue;
      const img = dropImage(d.kind);
      if (!img || !img.complete || !img.naturalWidth) continue;
      const lw = (img.naturalWidth || 32) * z * DROP_SCALE;
      const lh = (img.naturalHeight || 23) * z * DROP_SCALE;
      const sp = dropScreen(d);
      if (img._shadow) {
        ctx.save();
        ctx.globalAlpha = SHADOW_ALPHA * frameShadowMul;
        ctx.translate(sp.x, sp.y); // base of the drop
        ctx.transform(1, 0, SHADOW_SKEW, SHADOW_SQUASH, 0, 0);
        ctx.drawImage(img._shadow, -lw / 2, -lh, lw, lh);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(img, sp.x - lw / 2, sp.y - lh, lw, lh);
    }
  }

  // Finish the GL world batch: flush all sprites (floor + entities + drops) in one draw,
  // then the day/night + weather tint as a GPU multiply pass, then the vector rings on the
  // 2D overlay. The 2D path applies the multiply directly. Selected-target highlights /
  // ghost / ambient / weather draw on the overlay after this.
  if (useGL) {
    glr.flush();
    const tc = envTintColor();
    if (tc) glr.drawEnvTint(tc.r, tc.g, tc.b);
    drawWorldRingsGL(z, activeCell);
  } else {
    applyEnvTint();
  }
  glWasOn = useGL; // for the floor-rebuild-on-resume check next frame

  // Selected building: highlight its in-range eligible targets so the player
  // can see what it will harvest.
  if (G.selectedBuilding) {
    const sb = G.world.buildings.find((x) => x.id === G.selectedBuilding);
    if (sb) {
      for (const t of buildingTargets(sb)) {
        const s = worldToScreen(cellCenter(t.c, t.r).x, cellCenter(t.c, t.r).y);
        fillTileDiamond(s, z, "rgba(95, 209, 95, 0.22)", "rgba(140, 240, 140, 0.7)");
      }
    }
  }

  // Placement ghost: a translucent footprint that follows the cursor, green
  // when the spot is valid (and affordable), red otherwise.
  if (G.buildMode && G.hoverTile) {
    const front = G.hoverTile;                  // cursor anchors the front tile
    const col = front.col - 1, row = front.row - 1;  // -> rear anchor
    const ok = canPlaceFootprint(G.buildMode.type, col, row) && canAffordBuilding(G.buildMode.type);
    // Range preview: faint coverage over every in-range cell, with eligible
    // targets (trees/rocks this building would work) outlined a bit stronger.
    for (const t of cellsInRange(G.buildMode.type, col, row)) {
      const s = worldToScreen(cellCenter(t.c, t.r).x, cellCenter(t.c, t.r).y);
      fillTileDiamond(s, z, "rgba(79, 140, 255, 0.10)", null);
    }
    for (const t of buildingTargets({ type: G.buildMode.type, col, row })) {
      const s = worldToScreen(cellCenter(t.c, t.r).x, cellCenter(t.c, t.r).y);
      fillTileDiamond(s, z, "rgba(95, 209, 95, 0.20)", "rgba(140, 240, 140, 0.55)");
    }
    const fill = ok ? "rgba(95, 209, 95, 0.28)" : "rgba(200, 70, 60, 0.30)";
    const edge = ok ? "rgba(150, 245, 150, 0.9)" : "rgba(255, 120, 110, 0.9)";
    for (const [c, r] of buildingCells(col, row)) {
      if (!inBounds(c, r)) continue;
      const s = worldToScreen(cellCenter(c, r).x, cellCenter(c, r).y);
      fillTileDiamond(s, z, fill, edge);
    }
    // Ghost sprite preview on top, faded.
    const gimg = G.buildingImages[G.buildMode.type] &&
      (G.buildingImages[G.buildMode.type][G.buildMode.facing] || G.buildingImages[G.buildMode.type].SE);
    if (gimg && gimg.complete && gimg.naturalWidth) {
      const a = buildingAnchor(col, row);
      const r = spriteRectAt(gimg, a, z, 0, 1);
      ctx.globalAlpha = 0.6;
      ctx.drawImage(gimg, r.tx, r.ty, r.dw, r.dh);
      ctx.globalAlpha = 1;
    }
  }

  // Ambient cosmetic FX (cloud shadows, birds, bugs) over the world.
  renderAmbient();

  // Falling rain: a screen-space foreground layer, in front of everything.
  renderRain();
  // Lightning flashes (storm) on top of the rain.
  renderLightning();

  // Dev cell inspector (console: debugoverlay true).
  if (G.debugOverlay) drawDebugOverlay(z);

  // Keep the world-anchored building panel and the placement hint in sync with
  // the current camera/selection (DOM overlays, updated once per rendered frame).
  positionBuildingPanel();
  updateBuildHint();
  updateBuildPanel(); // live: brighten build entries as soon as they become affordable
  updateDayCounter(); // reflect G.world.day in the "Day N" HUD counter
  pEnd("overlay", _o0);
}

// Day/night + weather scene tint: one translucent rect over the whole viewport,
// drawn over the world (the cached floor + entities) but under UI highlights/FX.
// The day/night + weather tint color (0..255 RGB) to multiply the world by, or null if
// there is effectively no tint (or on the menu preview). Shared by the 2D fill and the GL
// multiply pass. Multiply (not a translucent rect) gives true darkening with a clean blue
// night cast: the tint alpha is pre-blended toward white (a=0 -> identity), then the
// weather dim scales the whole light color down (overcast = dimmer).
function envTintColor() {
  // Not on the main-menu preview: the day/night tint is a gameplay effect, and a multiply
  // over the menu's (intentionally transparent) regions would hide the CSS gradient behind.
  if (G.inMenu) return null;
  const tint = envTint();
  const ta = tint ? tint.a : 0;
  const wdim = weatherDim(); // extra darkening from overcast/rain (any time of day)
  if (ta <= 0.003 && wdim <= 0.003) return null;
  let r = 255, g = 255, b = 255;
  if (tint && ta > 0) {
    const inv = 1 - ta;
    r = 255 * inv + tint.r * ta; g = 255 * inv + tint.g * ta; b = 255 * inv + tint.b * ta;
  }
  if (wdim > 0) { const f = 1 - wdim; r *= f; g *= f; b *= f; }
  return { r, g, b };
}
function applyEnvTint() {
  const c = envTintColor();
  if (!c) return;
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = "rgb(" + Math.round(c.r) + ", " + Math.round(c.g) + ", " + Math.round(c.b) + ")";
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.restore();
}

// --- Dev: live cell inspector overlay --------------------------------
// Highlights the hovered cell and prints everything known about that tile and
// any object on it (raw stage/rock/progress/chop, sprite dims, lift, screen
// coords, draw order key). Toggled with the `debugoverlay` console command.
function drawDebugOverlay(z) {
  const cell = G.hoverTile || G.hover;
  const lines = [];
  if (!cell) {
    lines.push("debug overlay ON");
    lines.push("(hover a tile)");
  } else {
    const c = cell.col, r = cell.row;
    const inB = inBounds(c, r);
    const tile = inB ? tileAt(c, r) : "(out of bounds)";
    const stage = inB ? stageAt(c, r) : -1;
    const rock = inB ? rockRawAt(c, r) : -1;
    const prog = inB ? (progressAt(c, r) | 0) : 0;
    const chop = inB ? (chopAt(c, r) | 0) : 0;
    const center = cellCenter(c, r);
    const s = worldToScreen(center.x, center.y);
    const tImg = inB ? tileSprite(tile, c, r, waterFrameIndex()) : null;
    lines.push("cell  col=" + c + " row=" + r + "  (r+c=" + (c + r) + ")");
    lines.push("screen  x=" + Math.round(s.x) + " y=" + Math.round(s.y) + "  zoom=" + z.toFixed(2));
    lines.push("tile  '" + tile + "'" + (tImg ? "  sprite " + (tImg.naturalWidth || "?") + "x" + (tImg.naturalHeight || "?") : "  (no sprite)"));
    lines.push("raw  stage=" + stage + " rock=" + rock + " progress=" + prog + " chop=" + chop);
    // Biome classification + the fields that drive it (moisture, normalized height).
    // A water tile reports its hydrology class: ocean / lake / pond / river / stream.
    const hk = inB ? hydroClassAt(c, r) : null;
    const bi = inB ? (tile === "water" ? (hk || "water") : biomeAt(c, r)) : null;
    lines.push("biome  " + (bi || "-") + "  moist=" + (inB ? moistureAt(c, r).toFixed(2) : "-") + " up=" + (inB ? uplandAt(c, r).toFixed(2) : "-") + " h=" + (inB ? landHeightAt(c, r).toFixed(2) : "-"));
    // Globe climate (latitude band): temperature, snowiness, and whether water freezes.
    if (inB && G.world.wrapX) lines.push("climate  temp=" + temperatureAt(c, r).toFixed(2) + " snow=" + snownessAt(c, r).toFixed(2) + " desert=" + desertAt(c, r).toFixed(2) + (iceAt(c, r) ? "  ICE" : ""));
    // The object the renderer would draw here (rock takes precedence).
    const obj = inB ? cellObject(c, r) : null;
    if (obj) {
      const img = obj.img;
      const matureMark = (obj.kind === "tree") ? (obj.stage >= GD.matureStage ? " MATURE" : "") : "";
      lines.push("object  " + obj.kind + (obj.kind === "tree" ? " stage=" + obj.stage + matureMark : " variant=" + obj.variant));
      lines.push("  yOffset=" + obj.yOffset + " sc=" + (obj.sc || 1).toFixed(2) + " flip=" + (!!obj.flip));
      lines.push("  sprite " + (img && img.naturalWidth || "?") + "x" + (img && img.naturalHeight || "?") + (img && img.complete ? "" : " (loading)"));
      lines.push("  src " + ((img && img.src) ? img.src.split("/").pop() : "(none)"));
    } else {
      lines.push("object  none");
    }
    // A building whose footprint covers this cell?
    const bd = inB && G.world.buildings.find((bb) =>
      buildingCells(bb.col, bb.row).some(([bc, br]) => bc === c && br === r));
    if (bd) lines.push("building  " + bd.type + " @(" + bd.col + "," + bd.row + ") tools=" + (bd.tools ? bd.tools.count : 0));
    // Decoration (cosmetic ground cover) the renderer would draw here if the cell is
    // bare; notes when it is hidden because an object or building occupies the tile.
    const di = inB ? decorAt(c, r) : -1;
    if (di >= 0) {
      const dimg = G.decorImages[di];
      const dp = decorDrawParams(di, c, r);
      const hiddenBy = obj ? "object" : (bd ? "building" : null);
      lines.push("decor  index=" + di + (hiddenBy ? "  (hidden: " + hiddenBy + ")" : ""));
      if (dp) lines.push("  yOffset=" + dp.yOffset + " sc=" + dp.sc.toFixed(2) + " flip=" + (!!dp.flip));
      lines.push("  sprite " + ((dimg && dimg.naturalWidth) || "?") + "x" + ((dimg && dimg.naturalHeight) || "?") + (dimg && dimg.complete ? "" : " (loading)"));
      lines.push("  src " + ((dimg && dimg.src) ? dimg.src.split("/").pop() : "(none)"));
    } else {
      lines.push("decor  none");
    }
    // Outline the inspected cell in cyan (no bob) so it is unambiguous.
    const hw = HALF_W * z, hh = HALF_H * z;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - hh); ctx.lineTo(s.x + hw, s.y);
    ctx.lineTo(s.x, s.y + hh); ctx.lineTo(s.x - hw, s.y); ctx.closePath();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0, 255, 255, 0.95)"; ctx.stroke();
  }
  // Per-frame profiler readout (smoothed ms). 'frame' is the whole RAF callback;
  // sim = growth + building updates this frame; render = hover + world + entities +
  // overlay; world = floor draw + per-cell object probe (the zoom-out hot path).
  lines.push("");
  lines.push("PERF  fps " + PERF.fps.toFixed(0) + "   ms (avg)");
  const phaseOrder = ["frame", "sim", "growth", "buildings", "anim", "render", "hover", "world", "entities", "overlay", "fx"];
  for (const name of phaseOrder) {
    if (PERF.ms[name] !== undefined) lines.push("  " + name.padEnd(9) + PERF.ms[name].toFixed(2));
  }
  lines.push("cells " + (PERF.count.cells || 0) + "  entities " + (PERF.count.entities || 0) + "  shadows " + (G.useGL ? "GL" : (frameShadowSkip ? "OFF(dense)" : "on")) + (G.useGL ? "  inst " + glr.instanceCount() : ""));
  lines.push("baseCache " + baseCacheSize() + "  mods " + modsSize(G.world.mods));
  const ac = ambientCounts();
  lines.push("ambient  clouds " + ac.clouds + " swarms " + ac.swarms + " bugs " + ac.bugs + " birds " + ac.birds + " beams " + ac.beams);
  const tod = G.world.timeOfDay || 0, hh = Math.floor(tod * 24), mm = Math.floor((tod * 24 - hh) * 60);
  const phase = (tod < 0.21 || tod >= 0.79) ? "Night" : (tod < 0.31 ? "Dawn" : (tod < 0.69 ? "Day" : "Dusk"));
  const tn = envTint();
  lines.push("env  day " + (G.world.day | 0 || 1) + "  " + (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm) + " " + phase +
    "  t=" + tod.toFixed(3) + "  shadow " + shadowMul().toFixed(2) + "  dim " + (tn ? Math.round(tn.a * 100) : 0) + "%");
  lines.push("weather  " + weatherKind() + "  cloud " + Math.round(weatherCloud() * 100) + "%  rain " +
    Math.round(weatherRain() * 100) + "%  wdim " + Math.round(weatherDim() * 100) + "%");
  // Text panel, top-left, fixed (screen). Start it BELOW the crafted-tools HUD
  // (which also floats top-left and can wrap to multiple rows) so they never
  // overlap. Coords are canvas-relative; the HUD/canvas rects convert for us.
  const boxX = 8;
  let boxY = 8;
  if (craftedHud && craftedHud.childElementCount > 0) {
    const hud = craftedHud.getBoundingClientRect();
    const cv = canvas.getBoundingClientRect();
    boxY = Math.max(8, hud.bottom - cv.top + 8);
  }
  ctx.save();
  ctx.font = "12px Consolas, monospace";
  const pad = 8, lh = 15;
  let maxw = 0;
  for (const t of lines) maxw = Math.max(maxw, ctx.measureText(t).width);
  const boxW = maxw + pad * 2, boxH = lines.length * lh + pad * 2;
  ctx.fillStyle = "rgba(6, 10, 20, 0.82)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = "rgba(0, 255, 255, 0.6)";
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#dce6ff";
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], boxX + pad, boxY + pad + i * lh);
  ctx.restore();
}

// Filled top-face diamond on a cell anchor (no bob), for ghosts/highlights.
function fillTileDiamond(s, z, fill, stroke) {
  const hw = HALF_W * z, hh = HALF_H * z;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y - hh);
  ctx.lineTo(s.x + hw, s.y);
  ctx.lineTo(s.x, s.y + hh);
  ctx.lineTo(s.x - hw, s.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.lineWidth = 1.5; ctx.strokeStyle = stroke; ctx.stroke(); }
}
