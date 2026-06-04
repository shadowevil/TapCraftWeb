// TapCraft - canvas rendering: sprites, shadows, the world, ground drops.
// Moved verbatim from the original game.js IIFE.
"use strict";

import {
  SPRITE, HALF_W, HALF_H, DEFAULT_Y_OFFSET,
  SHADOW_ALPHA, SHADOW_SKEW, SHADOW_SQUASH,
  SHADOW_POOL_ALPHA, SHADOW_POOL_RATIO, DROP_SCALE, SHADOW_MIN_ZOOM, DECOR_MIN_ZOOM,
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
import { canPlaceFootprint, canAffordBuilding, buildingTargets, cellsInRange, hutToolKind, hutToolCount, footprintOf, yOffsetOf } from "./buildings.js";
import { mineableAt, mineableSprite } from "./mineable.js";
import { wetnessSize, wetnessAt } from "./wetness.js";
import { globeWeatherAt } from "./globeweather.js";
import { tileAt, stageAt, progressAt, chopAt, rockRawAt, baseCacheSize, decorAt, shoreDist, biomeAt, moistureAt, landHeightAt, uplandAt, wrapCol, wrapRow, hydroClassAt, iceAt, temperatureAt, snownessAt, desertAt, modsSize, clampBox, isTilledTile, tilledStageOf, wheatMature, decorClearedAt } from "./cells.js";
import { patchAt, resolveFarmCursor } from "./farming.js";
import * as glr from "./gl/glrender.js";
import { uvFor } from "./gl/atlas.js";
import { PERF, pBegin, pEnd, pCount } from "./perf.js";
import { renderAmbient, ambientCounts, cloudShadeAt, cloudsActive } from "./ambient.js";
import { frameLights, lightBoostAt } from "./lights.js";
import { envTint, shadowMul, weatherDim, weatherCloud, weatherRain, weatherKind, isNight } from "./env.js";
import { renderRain, renderLightning, activeSplashes, drawSplash } from "./weather.js";
import { positionBuildingPanel, updateBuildHint, updateDayCounter, updateBuildPanel } from "./ui.js";
import { updateForecast } from "./forecast.js";
import { drawMinimap } from "./minimap.js";

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
// Tilled cells host WHEAT (stage from the same st field, sprite from wheatImages);
// bare grass may host a forageable GRASS PATCH (a decor sprite promoted to a
// clickable object - flowers and the rest stay cosmetic).
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
  if (isTilledTile(tileAt(c, r))) {
    const st = stageAt(c, r);            // on tilled soil st = the wheat stage (-1 none)
    if (st < 0) return null;
    const img = G.wheatImages[st];
    if (!img) return null;
    const def = GD.objects.wheat || {};
    const flip = hash01(c, r, (G.world.seed ^ 0x000000e5) >>> 0) < 0.5;
    const sc = 0.92 + hash01(c, r, (G.world.seed ^ 0x000000f6) >>> 0) * 0.16;
    // Per-stage lift override (stageYOffset, e.g. the small seedling sits higher),
    // falling back to the object yOffset - mirrors the mineable variantYOffset.
    const syo = def.stageYOffset;
    const yOffset = (syo && syo[st] != null) ? syo[st]
      : (def.yOffset != null) ? def.yOffset : DEFAULT_Y_OFFSET;
    return { kind: "wheat", wheat: true, img, yOffset, sc, flip, stage: st };
  }
  const st = stageAt(c, r);
  if (st >= 0) {
    const dp = plantDrawParams(st, c, r);
    if (!dp) return null;
    return { kind: "tree", img: dp.img, yOffset: dp.yOffset, sc: dp.sc, flip: dp.flip, stage: st };
  }
  const pi = patchAt(c, r);
  if (pi >= 0) {
    const dp = decorDrawParams(pi, c, r);
    if (!dp) return null;
    return { kind: "grass_patch", patch: true, img: dp.img, yOffset: dp.yOffset, sc: dp.sc, flip: dp.flip, decorIdx: pi };
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
    .map((b) => { const fp = footprintOf(b.type); return { b, fp, depth: (b.row + fp.h - 1) + (b.col + fp.w - 1) }; })
    .sort((a, b) => b.depth - a.depth); // front-most first
  for (const { b, fp } of order) {
    const img = buildingSprite(b);
    if (!img || !img.complete || !img.naturalWidth) continue;
    const w = img.naturalWidth || SPRITE, h = img.naturalHeight || SPRITE;
    const a = buildingAnchor(wrapColTo(b.col, refCol), wrapRowTo(b.row, refRow), fp.w, fp.h);
    const dw = w * z, dh = h * z;
    const tx = a.x - dw / 2, ty = a.y - dh - yOffsetOf(b.type) * z; // same lift as drawBuilding/emitBuildingGL
    if (px < tx || px >= tx + dw || py < ty || py >= ty + dh) continue;
    const ix = Math.floor((px - tx) / z), iy = Math.floor((py - ty) / z);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
    const mask = img._mask;
    if (!mask || mask.a[iy * w + ix] > 16) return b;
  }
  return null;
}

// (The Canvas-2D world renderer was removed - the world draws exclusively
// through the WebGL batch (emit*GL below). The 2D ctx canvas remains as the
// OVERLAY layer: rings, highlights, ghost, ambient FX, rain, glow, debug.)

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
// The bobbing ring around a whole footprint (rear anchor col,row, size w x h).
// Same shape/halves as tileDiamond, but the four outer block vertices, lifted by
// the same gentle bob so it floats over the building.
export function buildingDiamond(col, row, z, w, h) {
  const lift = 8 + Math.sin(G.animTime * 0.004) * 3;
  const d = buildingDiamondWorld(col, row, w, h);
  const pt = (p) => { const s = worldToScreen(p.x, p.y); return { x: s.x, y: s.y - lift }; };
  return { top: pt(d.top), right: pt(d.right), bottom: pt(d.bottom), left: pt(d.left) };
}
// Shared lit-state for light-emitting buildings, computed ONCE per frame from
// the env tint (renderFrame, before the floor/entity passes) so the flame
// sprite swap and every light tint agree:
//   frameSceneDark - how dark the scene actually is (0..1), night tint AND
//                    weather dim combined (a stormy day darkens too),
//   frameLightsOn  - flames burn from dusk to dawn OR whenever the sky gets
//                    dark enough (overcast/rain/storm; ~0.13 cloudy .. 0.30 storm),
//   lightGainR/G/B - per-channel multiplier that makes a FULLY lit surface read
//                    as warm ~daylight THROUGH the env multiply (gain = warm
//                    target / tint, clamped) - this is the brightness-hold: a
//                    torch-lit tile keeps roughly its brightness at midnight or
//                    under a storm sky because its tint pre-counters the multiply.
const LIGHTS_ON_DARK = 0.12;
// Warm target of fully lit ground (keyed to the torch palette). Above 1.0 on
// red: torch-lit ground reads BRIGHTER than plain daylight up close, per user
// tuning (+25% over the original 1.0/0.84/0.62).
const LIGHT_WARM = [1.25, 1.05, 0.78];
const LIGHT_GAIN_MAX = 4.5;           // clamp on warm/tint (deep storm-midnight would explode otherwise)
let frameLightsOn = false, frameSceneDark = 0;
let lightGainR = 1, lightGainG = 1, lightGainB = 1;
function updateLightState(tintC) {
  frameSceneDark = tintC ? 1 - (tintC.r + tintC.g + tintC.b) / 765 : 0;
  frameLightsOn = isNight() || frameSceneDark >= LIGHTS_ON_DARK;
  const tr = tintC ? Math.max(0.08, tintC.r / 255) : 1;
  const tg = tintC ? Math.max(0.08, tintC.g / 255) : 1;
  const tb = tintC ? Math.max(0.08, tintC.b / 255) : 1;
  lightGainR = Math.min(LIGHT_GAIN_MAX, LIGHT_WARM[0] / tr);
  lightGainG = Math.min(LIGHT_GAIN_MAX, LIGHT_WARM[1] / tg);
  lightGainB = Math.min(LIGHT_GAIN_MAX, LIGHT_WARM[2] / tb);
}
// The sprite a building shows right now. Light-emitting buildings (def.light)
// swap to their flame animation frames while lit (night or a dark-enough sky,
// frameLightsOn), desynced per building so a row of torches doesn't pulse in
// unison; otherwise the facing art.
export function buildingSprite(b) {
  const def = GD.buildings[b.type];
  if (def && def.light) {
    const frames = G.lightFrames[b.type];
    if (frames && frames.length && frameLightsOn) {
      const ms = def.light.frameMs || 120;
      const t = G.animTime + (b.col * 131 + b.row * 197);
      return frames[Math.floor(t / ms) % frames.length];
    }
  }
  const set = G.buildingImages[b.type];
  if (!set) return null;
  return set[b.facing] || set.SE || null;
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

// --- Floor (WebGL, cached instance buffer) ----------------------------------
// The GL floor is emitted in WORLD-screen space and panned via a shader uniform, so it is
// rebuilt only when the zoom changes or the view scrolls past the emitted margin (NOT on a
// plain pan). glFloorBox is the cell range currently baked into the buffer; glFloorZoom the
// zoom it was emitted at. FLOOR_EMIT_MARGIN is the extra cell ring emitted around the visible
// box so small pans stay inside the cached buffer (fewer rebuilds during a drag).
let glFloorBox = null, glFloorZoom = -1, glFloorEpoch = -1;
let glFloorRefC = 0, glFloorRefR = 0; // reference cell the floor instances are emitted relative to
const FLOOR_EMIT_MARGIN = 6;
// DEV live-reload (gamedata.js): when an edited pack is hot-applied, drop the floor cache so
// tile-appearance tweaks redraw immediately (entity-pass data already re-reads GD each frame).
window.addEventListener("tapcraft:packreload", () => { glFloorBox = null; });
let glWasReady = false; // was the GL context ready last frame (force a floor rebuild after a context restore)
let glWaterTiles = [];     // [{idx,c,r}] cached-floor instance indices of visible water tiles
let glWaterFrameCached = -1; // the water frame currently baked into the cached floor buffer
// Every emitted floor instance {idx, c, r, base}, rebuilt with the floor buffer:
// the per-tile LIGHT pass (patchFloorLight) composes each tile's light level
// over its base tint (shallows/wetness baked at emit) and patches it in place.
let glFloorTiles = [];
let frameShadowMul = 1; // object-shadow alpha multiplier for this frame (day/night)
// WebGL floor: emit one instance per visible ground tile (the GPU redraws the
// whole floor cheaply each frame from the cached buffer).
function emitFloorGL(b, z, waterFrame, refC, refR) {
  glWaterTiles.length = 0; // rebuilt with the floor: indices of water tiles for the UV patch
  glFloorTiles.length = 0; // rebuilt with the floor: every instance, for the light tint patch
  floorLightActive = false; // fresh buffer holds base tints (patchFloorLight re-applies if needed)
  // World-screen space, RELATIVE to the reference cell (refC,refR): NO camera offset is baked
  // in (the shader adds it via u_cam/setFloorCam), so the cached buffer survives a pan. Emitting
  // relative to the reference keeps instance positions small -> float32-precise even on a globe/
  // infinite world panned far from the origin. Zoom IS baked, hence re-emit on a zoom change.
  const cx = -((refC - refR) * HALF_W) * z, cy = -((refC + refR) * HALF_H) * z;
  const half = (SPRITE / 2) * z;
  const ter = GD.worldgen.terrain || {};
  const shMax = ter.shallowTiles || 0, shA = ter.shallowAlpha || 0;
  const wetDk = (GD.farming && GD.farming.wetDarken != null) ? GD.farming.wetDarken : 0.28;
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
      } else if (isTilledTile(tile)) {
        // Watered farmland darkens with wetness (premultiplied multiply < 1). The wet level
        // moves slowly; G.floorEpoch invalidates the cached buffer as it changes.
        const wv = wetnessAt(c, r);
        if (wv > 0.02) {
          const d = 1 - wetDk * wv;
          tint = [d, d, d, 1];
        }
      }
      glFloorTiles.push({ idx: glr.floorInstanceCount(), c, r, base: tint });
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
  // The tile's light level (cloud shade down / torch boost up) tints the sprite
  // so the object darkens or glows with the ground it stands on (hover wins).
  const tint = hl ? HOVER_TINT : entityLightTint(c, r);
  glr.sprite(img, rect.tx, rect.ty, rect.dw, rect.dh, flip, tint);
}
function emitBuildingGL(bd, z) {
  const img = buildingSprite(bd);
  if (!img || !img.complete || !img.naturalWidth) return;
  const fp = footprintOf(bd.type);
  const a = buildingAnchor(bd.col, bd.row, fp.w, fp.h);
  const rect = spriteRectAt(img, a, z, yOffsetOf(bd.type), 1);
  if (z >= SHADOW_MIN_ZOOM) emitShadowRectGL(img, a.x, rect, z, false);
  // The footprint-centre tile's light level tints the building - a hut under a
  // cloud darkens with its ground; the torch at its own core glows brightest
  // of all (hover wins).
  const tint = bd.id === G.hoverBuilding
    ? BLD_HOVER_TINT
    : entityLightTint(bd.col + (fp.w - 1) / 2, bd.row + (fp.h - 1) / 2);
  glr.sprite(img, rect.tx, rect.ty, rect.dw, rect.dh, false, tint);
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
  const fp = footprintOf(bd.type);
  const rect = spriteRectAt(bimg, buildingAnchor(bd.col, bd.row, fp.w, fp.h), z, yOffsetOf(bd.type), 1);
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
      const fp = footprintOf(bd.type);
      const ring = buildingDiamond(wrapColTo(bd.col, ringRef.c), wrapRowTo(bd.row, ringRef.r), z, fp.w, fp.h);
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
  // Farming cursors: the swinging hoe (Shift over tillable ground) and the static
  // pour/fill/seeds icons (sets G.showHoe / G.farmCursor from the hover state).
  resolveFarmCursor();
  const wantCursor = (G.showHatchet || G.showPickaxe || G.showHoe || G.farmCursor) ? "none" : "default";
  if (canvas.style.cursor !== wantCursor) canvas.style.cursor = wantCursor;
  const z = G.cam.zoom;
  const b = visibleCellBounds();
  // Climate immersion: how snowy / desert the view is (center cell), smoothed. Snow drives
  // birds/ambience -> wind (ambient.js / sound.js) + rain -> snow + no lightning; desert
  // thins the rainfall (weather.js). Globe only.
  const ctrC = Math.round((b.c0 + b.c1) / 2), ctrR = Math.round((b.r0 + b.r1) / 2);
  G.viewSnow += ((G.world.wrapX ? snownessAt(ctrC, ctrR) : 0) - G.viewSnow) * 0.04;
  G.viewDesert += ((G.world.wrapX ? desertAt(ctrC, ctrR) : 0) - G.viewDesert) * 0.04;
  // The active cell is the hovered tree's cell (if any), else the ground tile.
  const activeCell = G.hover || G.hoverTile;
  // The world renders exclusively through WebGL. A lost context (GPU reset,
  // sleep) makes glReady() false: skip the world, show a restoring notice on
  // the overlay, and force a floor re-emit on resume (the GL buffers were
  // recreated empty by the contextrestored handler).
  if (!glr.glReady()) {
    glWasReady = false;
    drawGLRestoringNotice();
    return;
  }

  // Light state for THIS frame, before anything draws: the env tint color (the
  // multiply applied after the world flush), the lit/darkness state the flame
  // sprite swap + light tints read, and the emitter registry - so the floor
  // tint patch and the entity tints below all see this frame's flicker.
  const tintC = envTintColor();
  updateLightState(tintC);
  updateFrameLights(b);

  // Floor: clear the GL canvas + draw the cached floor instance buffer (the GPU
  // redraws the floor cheaply every frame; rebuilt only on a signature change).
  const _w0 = pBegin();
  glr.beginFrame();
  // Rebuild the floor buffer only when the zoom changed, the GL context just came
  // back (buffers were recreated), the visible box has scrolled past the emitted
  // (margin-padded) box, or a runtime tile change (till/revert/wet-tint,
  // G.floorEpoch) invalidated it. A plain pan does none of these, so it only
  // updates the u_cam uniform below - no per-frame floor re-emit. Water animates
  // at EVERY zoom without a rebuild: on a water tick, only the cached water
  // tiles' UVs are rewritten in place (cheap) and the buffer re-uploaded.
  const glWaterFrame = waterFrameIndex();
  const needFloorEmit = !glWasReady || z !== glFloorZoom || !glFloorBox || G.floorEpoch !== glFloorEpoch ||
    b.c0 < glFloorBox.c0 || b.c1 > glFloorBox.c1 || b.r0 < glFloorBox.r0 || b.r1 > glFloorBox.r1;
  if (needFloorEmit) {
    const eb = clampBox(b.c0 - FLOOR_EMIT_MARGIN, b.c1 + FLOOR_EMIT_MARGIN, b.r0 - FLOOR_EMIT_MARGIN, b.r1 + FLOOR_EMIT_MARGIN);
    glFloorRefC = eb.c0; glFloorRefR = eb.r0;
    glr.beginFloor(); emitFloorGL(eb, z, glWaterFrame, glFloorRefC, glFloorRefR); glr.endFloor();
    glFloorBox = eb; glFloorZoom = z; glWaterFrameCached = glWaterFrame; glFloorEpoch = G.floorEpoch;
  } else if (glWaterTiles.length && glWaterFrame !== glWaterFrameCached) {
    for (const w of glWaterTiles) {
      const uv = uvFor(tileSprite("water", w.c, w.r, glWaterFrame));
      if (uv) glr.patchFloorUV(w.idx, uv.u0, uv.v0, uv.u1, uv.v1);
    }
    glr.reuploadFloor();
    glWaterFrameCached = glWaterFrame;
  }
  // Per-tile light levels (cloud shade + torch boost) onto the cached buffer.
  // Re-patches every frame while clouds/torches are active; dormant otherwise.
  patchFloorLight();
  // Re-add the reference cell + camera in float64, pass the small result as u_cam: floor
  // screen pos = (instance, relative to ref) + u_cam = the same screen pos as before the pan.
  const fz = glFloorZoom;
  glr.setFloorCam((glFloorRefC - glFloorRefR) * HALF_W * fz + G.cam.x, (glFloorRefC + glFloorRefR) * HALF_H * fz + G.cam.y);
  glr.drawFloor();
  // entities + drops emit into the dynamic batch below; flush + env tint happen after them.
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
      const fp = footprintOf(bd.type);
      for (const [bc, br] of buildingCells(bd.col, bd.row, fp.w, fp.h)) decorCovered.add(wrapCol(bc) + "," + wrapRow(br));
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
      // delta-aware so nothing draws under a grown/placed object or a building. A FORAGED
      // grass patch (decor-cleared delta) is gone for good - never redrawn as decor.
      let decorIdx = -1;
      if (decorOn && !obj && tile === "grass" && !(decorCovered && decorCovered.has(wrapCol(c) + "," + wrapRow(r)))) {
        decorIdx = decorAt(c, r);
        if (decorIdx >= 0 && decorClearedAt(c, r)) decorIdx = -1;
      }
      if (obj || isActive || decorIdx >= 0) entities.push({ depth: r + c, col: c, c, r, obj, decorIdx, kind: "obj" });
    }
  }
  // Buildings draw from a list at their canonical cell; on the torus globe, shift each
  // to the wrapped copy nearest the view center (both axes) so it appears in the
  // current loop, and skip copies fully off-screen. The shifted cell feeds depth + anchor;
  // the depth key is the footprint's FRONT tile so painter's order holds for any size.
  const viewCenterC = (b.c0 + b.c1) / 2, viewCenterR = (b.r0 + b.r1) / 2;
  for (const bd of G.world.buildings) {
    const fp = footprintOf(bd.type);
    const dcol = wrapColTo(bd.col, viewCenterC), drow = wrapRowTo(bd.row, viewCenterR);
    if ((G.world.wrapX && (dcol + fp.w - 1 < b.c0 - 2 || dcol > b.c1 + 2)) ||
        (G.world.wrapY && (drow + fp.h - 1 < b.r0 - 2 || drow > b.r1 + 2))) continue;
    const dbd = (dcol === bd.col && drow === bd.row) ? bd : Object.assign({}, bd, { col: dcol, row: drow });
    entities.push({ depth: (drow + fp.h - 1) + (dcol + fp.w - 1), col: dcol + fp.w - 1, bd: dbd, kind: "bld" });
  }
  // Rain ground-splashes: injected at their tile's depth so nearer objects paint
  // over them (a splash never appears on top of a tree/rock - keeps the iso layering).
  for (const sp of activeSplashes()) {
    if (sp.c < b.c0 || sp.c > b.c1 || sp.r < b.r0 || sp.r > b.r1) continue;
    entities.push({ depth: sp.r + sp.c, col: sp.c, c: sp.c, r: sp.r, sp, kind: "splash" });
  }
  entities.sort((a, e) => (a.depth - e.depth) || (a.col - e.col) || (a.kind === "bld" ? -1 : 1));
  for (const e of entities) {
    if (e.kind === "bld") emitBuildingGL(e.bd, z);
    else if (e.kind === "splash") drawSplash(e.c, e.r, e.sp, z); // vector splash stays on the 2D overlay
    else emitCellObjectGL(e.c, e.r, z, e.obj, e.decorIdx);
  }
  pCount("entities", entities.length);
  pEnd("entities", _e0);

  // Ground drops (resource pickups) drawn on top of the world, each with a
  // matching cast shadow sheared along the ground.
  const _o0 = pBegin();
  emitDropsGL(z);

  // Finish the GL world batch: flush all sprites (floor + entities + drops) in one draw,
  // then the day/night + weather tint as a GPU multiply pass, then the vector rings on the
  // 2D overlay. Selected-target highlights / ghost / ambient / weather draw on the overlay
  // after this. tintC was computed before the entity pass (the flame-sprite swap needs it);
  // the light pass reuses it too.
  glr.flush();
  if (tintC) glr.drawEnvTint(tintC.r, tintC.g, tintC.b);
  drawWorldRingsGL(z, activeCell);
  glWasReady = true; // context healthy this frame (a loss forces a floor rebuild on resume)

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
    const gfp = footprintOf(G.buildMode.type);
    const front = G.hoverTile;                  // cursor anchors the front tile
    const col = front.col - (gfp.w - 1), row = front.row - (gfp.h - 1);  // -> rear anchor
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
    for (const [c, r] of buildingCells(col, row, gfp.w, gfp.h)) {
      if (!inBounds(c, r)) continue;
      const s = worldToScreen(cellCenter(c, r).x, cellCenter(c, r).y);
      fillTileDiamond(s, z, fill, edge);
    }
    // Ghost sprite preview on top, faded.
    const gimg = G.buildingImages[G.buildMode.type] &&
      (G.buildingImages[G.buildMode.type][G.buildMode.facing] || G.buildingImages[G.buildMode.type].SE);
    if (gimg && gimg.complete && gimg.naturalWidth) {
      const a = buildingAnchor(col, row, gfp.w, gfp.h);
      const r = spriteRectAt(gimg, a, z, yOffsetOf(G.buildMode.type), 1); // same lift as the placed draw
      ctx.globalAlpha = 0.6;
      ctx.drawImage(gimg, r.tx, r.ty, r.dw, r.dh);
      ctx.globalAlpha = 1;
    }
  }

  // Ambient cosmetic FX (moonbeams, birds, bugs) over the world. Cloud shade +
  // torch light are NOT painted: they ride the per-tile RGB tints applied in
  // the floor patch + entity emitters above.
  renderAmbient();

  // Flame glows: a small smooth bloom over each lit flame - the one painted
  // piece of the torch light, so the flame itself always reads as the emitter.
  renderFlameGlows(z, b);

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
  updateForecast();   // local conditions widget (weather + climate in the player's area)
  drawMinimap();      // coarse zoomable map in the forecast panel (re-renders only on move/zoom)
  pEnd("overlay", _o0);
}

// Day/night + weather scene tint: the color (0..255 RGB) the GL multiply pass
// (glr.drawEnvTint) scales the world by, or null if there is effectively no
// tint (or on the menu preview). Multiply gives true darkening with a clean
// blue night cast: the tint alpha is pre-blended toward white (a=0 ->
// identity), then the weather dim scales the whole light color down
// (overcast = dimmer).
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

// Lost-context notice: the world cannot draw while the WebGL context is gone
// (GPU reset / driver restart / OS sleep). The contextrestored handler rebuilds
// the pipeline + re-uploads the atlas; until then, tell the player on the
// (always-available) 2D overlay instead of freezing on a stale frame.
function drawGLRestoringNotice() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = "rgba(8, 12, 22, 0.85)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#dce6ff";
  ctx.font = "16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Restoring graphics...", w / 2, h / 2);
  ctx.textAlign = "left"; // restore the default other overlay text relies on
}

// --- Per-tile light (clouds down, torches up) --------------------------------
// The unified light model: every visible tile has a light level composed of
//   x (1 - cloudShadeAt)        - clouds darken the tile's OWN pixels (banded,
//                                 lumpy blobs; nothing is painted over the art),
//   x (1 + (lightGain-1)*boost) - emitters brighten it back up, warm per channel
//                                 and strong enough to pre-counter the upcoming
//                                 env multiply (the brightness-hold).
// Floor tiles apply it via the per-instance tint patch (patchFloorLight);
// objects/buildings standing on a tile apply the SAME factor via their sprite
// tint (entityLightTint) - so a tree under a cloud darkens with its ground and
// a tree by a torch glows with it, at the RGB level.
const LIGHT_FULL_DARK = 0.55; // scene darkness at which emitters hit full strength (~midnight)
const LIGHT_HOLD = 0.85;      // fraction of the warm/tint hold gain applied at full boost

// Rebuild the per-frame emitter registry (lights.js frameLights) that
// lightBoostAt reads. Pure data - nothing draws here. Runs BEFORE the floor
// pass so this frame's tints see this frame's flicker.
function updateFrameLights(vb) {
  frameLights.length = 0;
  if (!G.world.buildings.length || !frameLightsOn) return;
  const strength = Math.min(1, frameSceneDark / LIGHT_FULL_DARK);
  if (strength <= 0.04) return;
  const ctrC = (vb.c0 + vb.c1) / 2, ctrR = (vb.r0 + vb.r1) / 2;
  const t = G.animTime;
  for (const bd of G.world.buildings) {
    const L = GD.buildings[bd.type].light;
    if (!L) continue;
    const fp = footprintOf(bd.type);
    const radCells = L.radius || 4;
    // Nearest wrapped copy; skip lights that cannot reach the view.
    const dcol = wrapColTo(bd.col, ctrC), drow = wrapRowTo(bd.row, ctrR);
    if (dcol + fp.w - 1 < vb.c0 - radCells || dcol > vb.c1 + radCells ||
        drow + fp.h - 1 < vb.r0 - radCells || drow > vb.r1 + radCells) continue;
    const ph = bd.col * 131 + bd.row * 197;                // per-building phase
    const jit = 0.5 + 0.3 * Math.sin(t * 0.011 + ph) + 0.2 * Math.sin(t * 0.029 + ph * 1.7); // 0..1 organic
    const fl = 1 - (L.flicker || 0) * jit;                 // 1 .. 1-flicker
    // Light centre = the middle of the footprint (fractional for even sizes).
    const fcol = dcol + (fp.w - 1) / 2, frow = drow + (fp.h - 1) / 2;
    const reff = radCells * (0.92 + 0.08 * fl);            // reach breathes with the flame
    // lumens (data, default 1): pure intensity multiplier on the emitter's
    // boost - >1 overdrives past the warm target (saturating toward white at
    // the core), <1 is a dimmer ember. Reach stays the separate `radius` knob.
    const lumens = (L.lumens != null) ? L.lumens : 1;
    frameLights.push({ fcol, frow, reff, gain: strength * fl * lumens });
  }
}

// The tile's light factor as a premultiplied sprite tint, or null when neutral
// (no clouds overhead, no emitters near). Shared by every entity emitter.
function entityLightTint(c, r) {
  const cloudsOn = cloudsActive(), lightsOn = frameLights.length > 0;
  if (!cloudsOn && !lightsOn) return null;
  const shade = cloudsOn ? cloudShadeAt(c, r) : 0;
  const boost = lightsOn ? lightBoostAt(c, r) : 0;
  if (shade <= 0.004 && boost <= 0.004) return null;
  let fR = 1 - shade, fG = fR, fB = fR;
  if (boost > 0) {
    const h = boost * LIGHT_HOLD;
    fR *= 1 + (lightGainR - 1) * h;
    fG *= 1 + (lightGainG - 1) * h;
    fB *= 1 + (lightGainB - 1) * h;
  }
  return [fR, fG, fB, 1];
}

// Apply this frame's light levels to the cached floor buffer: every recorded
// instance gets tint = its base (shallows/wetness, baked at emit) x the tile's
// light factor, then ONE re-upload. Runs only while clouds or emitters are
// active; when both go quiet it restores the base tints once and goes dormant,
// so a clear noon keeps the zero-touch cached-floor fast path.
let floorLightActive = false;
function patchFloorLight() {
  const cloudsOn = cloudsActive(), lightsOn = frameLights.length > 0;
  if (!cloudsOn && !lightsOn) {
    if (floorLightActive) {
      for (const t of glFloorTiles) {
        const bt = t.base;
        glr.patchFloorTint(t.idx, bt ? bt[0] : 1, bt ? bt[1] : 1, bt ? bt[2] : 1, bt ? bt[3] : 1);
      }
      glr.reuploadFloor();
      floorLightActive = false;
    }
    return;
  }
  for (const t of glFloorTiles) {
    const shade = cloudsOn ? cloudShadeAt(t.c, t.r) : 0;
    const boost = lightsOn ? lightBoostAt(t.c, t.r) : 0;
    let fR = 1 - shade, fG = fR, fB = fR;
    if (boost > 0) {
      const h = boost * LIGHT_HOLD;
      fR *= 1 + (lightGainR - 1) * h;
      fG *= 1 + (lightGainG - 1) * h;
      fB *= 1 + (lightGainB - 1) * h;
    }
    const bt = t.base;
    glr.patchFloorTint(t.idx, (bt ? bt[0] : 1) * fR, (bt ? bt[1] : 1) * fG, (bt ? bt[2] : 1) * fB, bt ? bt[3] : 1);
  }
  glr.reuploadFloor();
  floorLightActive = true;
}

// The one intentionally SMOOTH piece of the torch light: a small radial bloom
// right over the FLAME (top-centre of the building art), drawn on the overlay
// after the cloud shadows so the flame always reads as the emitter - not a
// post swallowed by its own banded pool. Color leans well toward white at the
// core, and it breathes/fades with the same flicker + darkness scaling as the
// pool. Data: L.glowRadius (sprite px, scaled by zoom), L.glowAlpha.
function renderFlameGlows(z, vb) {
  if (!G.world.buildings.length || !frameLightsOn) return;
  const strength = Math.min(1, frameSceneDark / LIGHT_FULL_DARK);
  if (strength <= 0.04) return;
  const ctrC = (vb.c0 + vb.c1) / 2, ctrR = (vb.r0 + vb.r1) / 2;
  const t = G.animTime;
  for (const bd of G.world.buildings) {
    const L = GD.buildings[bd.type].light;
    if (!L) continue;
    const fp = footprintOf(bd.type);
    // Nearest wrapped copy; skip flames outside the view (small margin).
    const dcol = wrapColTo(bd.col, ctrC), drow = wrapRowTo(bd.row, ctrR);
    if (dcol + fp.w - 1 < vb.c0 - 2 || dcol > vb.c1 + 2 ||
        drow + fp.h - 1 < vb.r0 - 2 || drow > vb.r1 + 2) continue;
    const img = buildingSprite(bd);
    if (!img || !img.complete || !img.naturalWidth) continue;
    const a = buildingAnchor(dcol, drow, fp.w, fp.h);
    const rect = spriteRectAt(img, a, z, yOffsetOf(bd.type), 1);
    const ph = bd.col * 131 + bd.row * 197;                // same phase as the pool
    const jit = 0.5 + 0.3 * Math.sin(t * 0.011 + ph) + 0.2 * Math.sin(t * 0.029 + ph * 1.7);
    const fl = 1 - (L.flicker || 0) * jit;
    // Glow brightness rides the same lumens knob as the tile boost (capped so
    // an overdriven light stays a soft bloom, not a hard disc).
    const lumens = (L.lumens != null) ? L.lumens : 1;
    const A = Math.min(0.9, (L.glowAlpha != null ? L.glowAlpha : 0.4) * strength * (0.75 + 0.25 * fl) * lumens);
    if (A <= 0.01) continue;
    const rp = (L.glowRadius != null ? L.glowRadius : 12) * z * (0.92 + 0.08 * fl);
    if (rp <= 1) continue;
    const gx = rect.tx + rect.dw / 2, gy = rect.ty + 2 * z; // flame = top-centre of the art
    const col3 = L.color || [255, 190, 100];
    const cr = Math.round(col3[0] + (255 - col3[0]) * 0.6); // near-white core
    const cg = Math.round(col3[1] + (255 - col3[1]) * 0.6);
    const cb = Math.round(col3[2] + (255 - col3[2]) * 0.6);
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, rp);
    g.addColorStop(0, "rgba(" + cr + ", " + cg + ", " + cb + ", " + A.toFixed(3) + ")");
    g.addColorStop(0.5, "rgba(" + col3[0] + ", " + col3[1] + ", " + col3[2] + ", " + (A * 0.4).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + col3[0] + ", " + col3[1] + ", " + col3[2] + ", 0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(gx, gy, rp, 0, Math.PI * 2); ctx.fill();
  }
}

// --- Dev: live cell inspector overlay --------------------------------
// Highlights the hovered cell and prints everything known about that tile and
// any object on it (raw stage/rock/progress/chop, sprite dims, lift, screen
// coords, draw order key). Toggled with the `debugoverlay` console command.
// Rendered as three titled boxes - GLOBAL (stats), TILE (hovered cell), OBJECT (what
// is on it) - stacked top-left and flowed into a new column to the right when they
// would overflow the bottom of the viewport.
const DBG_PAD = 8, DBG_LH = 15;
function debugBoxSize(title, lines) {
  let maxw = ctx.measureText(title).width;
  for (const t of lines) { const w = ctx.measureText(t).width; if (w > maxw) maxw = w; }
  return { w: maxw + DBG_PAD * 2, h: (lines.length + 1) * DBG_LH + DBG_PAD * 2 };
}
function drawDebugBox(title, lines, x, y, w, h) {
  ctx.fillStyle = "rgba(6, 10, 20, 0.82)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(0, 255, 255, 0.6)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "#6fe9ff"; // title row
  ctx.fillText(title, x + DBG_PAD, y + DBG_PAD);
  ctx.fillStyle = "#dce6ff";
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + DBG_PAD, y + DBG_PAD + (i + 1) * DBG_LH);
}
function drawDebugOverlay(z) {
  const cell = G.hoverTile || G.hover;
  const gLines = [], tLines = [], oLines = []; // GLOBAL / TILE / OBJECT boxes
  if (!cell) {
    tLines.push("(hover a tile)");
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
    tLines.push("cell  col=" + c + " row=" + r + "  (r+c=" + (c + r) + ")");
    tLines.push("screen  x=" + Math.round(s.x) + " y=" + Math.round(s.y) + "  zoom=" + z.toFixed(2));
    tLines.push("tile  '" + tile + "'" + (tImg ? "  sprite " + (tImg.naturalWidth || "?") + "x" + (tImg.naturalHeight || "?") : "  (no sprite)"));
    tLines.push("raw  stage=" + stage + " rock=" + rock + " progress=" + prog + " chop=" + chop);
    // Biome classification + the fields that drive it (moisture, normalized height).
    // A water tile reports its hydrology class: ocean / lake / pond / river / stream.
    const hk = inB ? hydroClassAt(c, r) : null;
    const bi = inB ? (tile === "water" ? (hk || "water") : biomeAt(c, r)) : null;
    tLines.push("biome  " + (bi || "-") + "  moist=" + (inB ? moistureAt(c, r).toFixed(2) : "-") + " up=" + (inB ? uplandAt(c, r).toFixed(2) : "-") + " h=" + (inB ? landHeightAt(c, r).toFixed(2) : "-"));
    // Globe climate (latitude band): temperature, snowiness, and whether water freezes.
    if (inB && G.world.wrapX) tLines.push("climate  temp=" + temperatureAt(c, r).toFixed(2) + " snow=" + snownessAt(c, r).toFixed(2) + " desert=" + desertAt(c, r).toFixed(2) + (iceAt(c, r) ? "  ICE" : ""));
    // Globe regional weather field at this cell (independent per region; drifts over time).
    if (inB && G.world.wrapX) { const gw = globeWeatherAt(c, r); tLines.push("gweather  cloud=" + Math.round(gw.cloud * 100) + "% rain=" + Math.round(gw.rain * 100) + "% " + gw.kind); }
    // Ground wetness (0..1 this tile), its drying-relevant moisture, and whether the
    // surface can soak rain at all (terrain.wettable: stone + water stay dry).
    if (inB) {
      const wt = (GD.worldgen.terrain && GD.worldgen.terrain.wettable) || {};
      const dry = tile === "water" || wt[tile] === false;
      tLines.push("wetness  " + Math.round(wetnessAt(c, r) * 100) + "%  moist=" + moistureAt(c, r).toFixed(2) + (dry ? "  (surface stays dry)" : ""));
    }
    // Farmland: tilled stage + crop state (st on a tilled cell = the wheat stage).
    if (inB && isTilledTile(tile)) {
      tLines.push("farm  tilled stage " + tilledStageOf(tile) + (stage >= 0 ? "  wheat st=" + stage + "/" + wheatMature() : "  (no crop)"));
    }
    // The object the renderer would draw here (rock takes precedence).
    const obj = inB ? cellObject(c, r) : null;
    if (obj) {
      const img = obj.img;
      const matureMark = (obj.kind === "tree") ? (obj.stage >= GD.matureStage ? " MATURE" : "")
        : (obj.kind === "wheat") ? (obj.stage >= wheatMature() ? " MATURE" : "") : "";
      oLines.push("object  " + obj.kind + (obj.stage != null ? " stage=" + obj.stage + matureMark
        : (obj.variant != null ? " variant=" + obj.variant : "")));
      oLines.push("  yOffset=" + obj.yOffset + " sc=" + (obj.sc || 1).toFixed(2) + " flip=" + (!!obj.flip));
      oLines.push("  sprite " + (img && img.naturalWidth || "?") + "x" + (img && img.naturalHeight || "?") + (img && img.complete ? "" : " (loading)"));
      oLines.push("  src " + ((img && img.src) ? img.src.split("/").pop() : "(none)"));
    } else {
      oLines.push("object  none");
    }
    // A building whose footprint covers this cell?
    const bd = inB && G.world.buildings.find((bb) => {
      const fp = footprintOf(bb.type);
      return buildingCells(bb.col, bb.row, fp.w, fp.h).some(([bc, br]) => bc === c && br === r);
    });
    if (bd) oLines.push("building  " + bd.type + " @(" + bd.col + "," + bd.row + ") tools=" + (bd.tools ? bd.tools.count : 0));
    // Decoration (cosmetic ground cover) the renderer would draw here if the cell is
    // bare; notes when it is hidden because an object or building occupies the tile.
    const di = inB ? decorAt(c, r) : -1;
    if (di >= 0) {
      const dimg = G.decorImages[di];
      const dp = decorDrawParams(di, c, r);
      const hiddenBy = decorClearedAt(c, r) ? "foraged" : obj ? "object" : (bd ? "building" : null);
      oLines.push("decor  index=" + di + (hiddenBy ? "  (hidden: " + hiddenBy + ")" : ""));
      if (dp) oLines.push("  yOffset=" + dp.yOffset + " sc=" + dp.sc.toFixed(2) + " flip=" + (!!dp.flip));
      oLines.push("  sprite " + ((dimg && dimg.naturalWidth) || "?") + "x" + ((dimg && dimg.naturalHeight) || "?") + (dimg && dimg.complete ? "" : " (loading)"));
      oLines.push("  src " + ((dimg && dimg.src) ? dimg.src.split("/").pop() : "(none)"));
    } else {
      oLines.push("decor  none");
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
  // GLOBAL box: profiler (smoothed ms), counts, caches, ambient, env, weather.
  gLines.push("PERF  fps " + PERF.fps.toFixed(0) + "   ms (avg)");
  const phaseOrder = ["frame", "sim", "growth", "buildings", "anim", "render", "hover", "world", "entities", "overlay", "fx"];
  for (const name of phaseOrder) {
    if (PERF.ms[name] !== undefined) gLines.push("  " + name.padEnd(9) + PERF.ms[name].toFixed(2));
  }
  gLines.push("cells " + (PERF.count.cells || 0) + "  entities " + (PERF.count.entities || 0) + "  inst " + glr.instanceCount());
  gLines.push("baseCache " + baseCacheSize() + "  mods " + modsSize(G.world.mods) + "  wet " + wetnessSize(G.world.wet));
  const ac = ambientCounts();
  gLines.push("ambient  clouds " + ac.clouds + " swarms " + ac.swarms + " bugs " + ac.bugs + " birds " + ac.birds + " beams " + ac.beams);
  const tod = G.world.timeOfDay || 0, hh = Math.floor(tod * 24), mm = Math.floor((tod * 24 - hh) * 60);
  const phase = (tod < 0.21 || tod >= 0.79) ? "Night" : (tod < 0.31 ? "Dawn" : (tod < 0.69 ? "Day" : "Dusk"));
  const tn = envTint();
  gLines.push("env  day " + (G.world.day | 0 || 1) + "  " + (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm) + " " + phase +
    "  t=" + tod.toFixed(3) + "  shadow " + shadowMul().toFixed(2) + "  dim " + (tn ? Math.round(tn.a * 100) : 0) + "%");
  gLines.push("weather  " + weatherKind() + "  cloud " + Math.round(weatherCloud() * 100) + "%  rain " +
    Math.round(weatherRain() * 100) + "%  wdim " + Math.round(weatherDim() * 100) + "%");
  // Boxes float top-left, BELOW the crafted-tools HUD (which also floats top-left and
  // can wrap to multiple rows) so they never overlap. Coords are canvas-relative.
  const boxX = 8;
  let boxY = 8;
  if (craftedHud && craftedHud.childElementCount > 0) {
    const hud = craftedHud.getBoundingClientRect();
    const cv = canvas.getBoundingClientRect();
    boxY = Math.max(8, hud.bottom - cv.top + 8);
  }
  // Stack GLOBAL / TILE / OBJECT top-to-bottom; flow into a new column to the right
  // when the next box would run past the bottom of the viewport.
  const boxes = [["GLOBAL", gLines], ["TILE", tLines]];
  if (oLines.length) boxes.push(["OBJECT", oLines]);
  ctx.save();
  ctx.font = "12px Consolas, monospace";
  ctx.textBaseline = "top";
  const gap = 8, maxBottom = (canvas.clientHeight || 600) - 8;
  let bx = boxX, by = boxY, colW = 0;
  for (const [title, ls] of boxes) {
    const sz = debugBoxSize(title, ls);
    if (by > boxY && by + sz.h > maxBottom) { bx += colW + gap; by = boxY; colW = 0; } // wrap to a new column
    drawDebugBox(title, ls, bx, by, sz.w, sz.h);
    by += sz.h + gap;
    if (sz.w > colW) colW = sz.w;
  }
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
