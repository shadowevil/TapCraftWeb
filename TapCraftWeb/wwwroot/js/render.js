// TapCraft - canvas rendering: sprites, shadows, the world, ground drops.
// Moved verbatim from the original game.js IIFE.
"use strict";

import {
  SPRITE, HALF_W, HALF_H, OBJECT_LIFT,
  SHADOW_ALPHA, SHADOW_SKEW, SHADOW_SQUASH,
  SHADOW_POOL_ALPHA, SHADOW_POOL_RATIO, DROP_SCALE,
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
import { positionBuildingPanel, updateBuildHint } from "./ui.js";

// Sprite + placement for a plant cell (shared by render and hit-testing so
// they always agree on size/lift/flip).
export function plantDrawParams(stage, c, r) {
  const img = plantSprite(stage, c, r);
  if (!img) return null;
  // Stage 0 is a small dirt mound OBJECT on the grass (not a ground-cube tile),
  // so it lifts like every other stage and needs no special-casing - no scale/
  // flip jitter on the tiny mound though.
  if (stage === 0) return { img, lift: OBJECT_LIFT, sc: 1, flip: false };
  const flip = hash01(c, r, (G.world.seed ^ 0x000000a1) >>> 0) < 0.5;
  const sc = 0.9 + hash01(c, r, (G.world.seed ^ 0x000000b2) >>> 0) * 0.2;
  return { img, lift: OBJECT_LIFT, sc, flip };
}

// The object occupying a cell (mineable takes precedence; a cell never has both),
// with the draw params render and hit-testing share. null if the cell is bare.
// A mineable returns kind = its type id (rock/iron_vein/gold_vein) + mineable:true.
export function cellObject(c, r) {
  const m = mineableAt(c, r);
  if (m) {
    const img = mineableSprite(m);
    if (!img) return null;
    return { kind: m.typeId, mineable: true, img, lift: OBJECT_LIFT, sc: 1, flip: false, variant: m.variant };
  }
  const st = G.world.stage[r][c];
  if (st >= 0) {
    const dp = plantDrawParams(st, c, r);
    if (!dp) return null;
    return { kind: "tree", img: dp.img, lift: dp.lift, sc: dp.sc, flip: dp.flip, stage: st };
  }
  return null;
}

// Pixel-perfect hit test: the front-most targetable object whose opaque
// pixels are under the screen point (px, py), or null. Tests the un-popped
// sprite so the hitbox stays stable during the click "pop".
export function objectAt(px, py) {
  if (!G.hasWorld) return null;
  const z = G.cam.zoom;
  const b = visibleCellBounds();
  for (let r = b.r1; r >= b.r0; r--) {      // front-to-back (reverse paint order)
    for (let c = b.c1; c >= b.c0; c--) {
      const obj = cellObject(c, r);
      if (!obj || !obj.img.complete) continue;
      const t = GD.objects[obj.kind];
      if (!t || !t.targetable) continue;
      const img = obj.img;
      const w = img.naturalWidth || SPRITE, h = img.naturalHeight || SPRITE;
      const center = cellCenter(c, r);
      const s = worldToScreen(center.x, center.y);
      const dw = w * z * obj.sc, dh = h * z * obj.sc;
      const tx = s.x - dw / 2;
      const ty = s.y - obj.lift * z + (SPRITE / 2) * z - dh; // lift scales with zoom
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
  const order = G.world.buildings
    .map((b) => ({ b, depth: (b.row + 1) + (b.col + 1) }))
    .sort((a, b) => b.depth - a.depth); // front-most first
  for (const { b } of order) {
    const img = buildingSprite(b);
    if (!img || !img.complete) continue;
    const w = img.naturalWidth || SPRITE, h = img.naturalHeight || SPRITE;
    const a = buildingAnchor(b.col, b.row);
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
export function drawSprite(img, s, z, lift, sc, flip) {
  const r = spriteRect(img, s, z, lift, sc);
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
    ctx.globalAlpha = SHADOW_POOL_ALPHA;
    ctx.drawImage(G.poolSprite, fx - pw / 2, groundY - ph / 2, pw, ph);
    ctx.globalAlpha = 1;
  }
  // 2) Directional cast: the silhouette sheared up-left and squashed flat,
  //    with the opaque foot row pinned to groundY (so it meets the pool).
  //    a=x-scale (flip), b=0, c=horizontal shear, d=vertical squash. Columns
  //    higher up the sprite (more negative local y) lean further left.
  ctx.save();
  ctx.globalAlpha = SHADOW_ALPHA;
  ctx.translate(centerX, groundY);
  ctx.transform(flip ? -1 : 1, 0, SHADOW_SKEW, SHADOW_SQUASH, 0, 0);
  ctx.drawImage(sh, -r.dw / 2, -footRows * unit, r.dw, r.dh);
  ctx.restore();
  ctx.globalAlpha = 1;
}
export function drawShadow(img, s, z, lift, sc, flip) {
  if (!img._shadow) return;
  drawShadowRect(img, s.x, spriteRect(img, s, z, lift, sc), z * sc, flip);
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
  if (!img || !img.complete) return;
  const a = buildingAnchor(b.col, b.row);
  const r = spriteRectAt(img, a, z, 0, 1);
  drawShadowRect(img, a.x, r, z, false);
  if (bright) ctx.filter = "brightness(1.5)";
  ctx.drawImage(img, r.tx, r.ty, r.dw, r.dh);
  if (bright) ctx.filter = "none";
}

// Draw a single cell's object (rock/tree) with its shadow, click-pop scale,
// hover brighten, and - if it is the active cell - the bobbing outline ring
// wrapping it (back edges behind, front edges in front). Used by the unified
// entity pass so objects and buildings interleave by depth.
function drawCellObject(c, r, z, activeCell) {
  const obj = cellObject(c, r);
  const isActive = activeCell && activeCell.col === c && activeCell.row === r;
  if (!obj || !obj.img.complete) {
    // Active empty/flat cell still needs its ground ring (no object to wrap).
    if (isActive) { const s = worldToScreen(cellCenter(c, r).x, cellCenter(c, r).y); const d = tileDiamond(s, z); strokeDiamondHalf(d, "back"); strokeDiamondHalf(d, "front"); }
    return;
  }
  const s = worldToScreen(cellCenter(c, r).x, cellCenter(c, r).y);
  const sc = obj.sc * popFactor(c, r);
  const diamond = isActive ? tileDiamond(s, z) : null;
  if (diamond) strokeDiamondHalf(diamond, "back");
  drawShadow(obj.img, s, z, obj.lift, sc, obj.flip); // cast before the sprite
  const hl = G.hover && G.hover.col === c && G.hover.row === r;
  if (hl) ctx.filter = "brightness(1.6)";
  drawSprite(obj.img, s, z, obj.lift, sc, obj.flip);
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
  if (!bimg || !bimg.complete) return;
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

export function render() {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!G.hasWorld) { G.hover = null; G.hoverTile = null; G.showHatchet = false; G.showPickaxe = false; canvas.style.cursor = "default"; return; }
  const active = !G.inMenu && G.mouse.on;
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
  const waterFrame = waterFrameIndex(); // same for all water cells this frame
  // The active cell is the hovered tree's cell (if any), else the ground tile.
  const activeCell = G.hover || G.hoverTile;
  // Pass A - floor: every visible ground tile.
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const tImg = tileSprite(G.world.tiles[r][c], c, r, waterFrame);
      if (tImg && tImg.complete) {
        const s = worldToScreen(cellCenter(c, r).x, cellCenter(c, r).y);
        drawSprite(tImg, s, z, 0, 1, false);
      }
    }
  }

  // Pass B - entities: ONE depth-sorted list of all objects (rocks/trees) and
  // buildings, drawn over the floor in back-to-front order. A single sort makes
  // the 2x2 building "just another entity", so objects and buildings interleave
  // correctly (a tree in front of a building draws over it; a rock behind it is
  // covered) with no special-case post-pass. Depth key: 1-tile object uses r+c;
  // a building uses its FRONT tile (row+1)+(col+1). Ties broken by column so the
  // east-most of a shared diagonal paints last.
  const entities = [];
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const obj = cellObject(c, r);
      const isActive = activeCell && activeCell.col === c && activeCell.row === r;
      if (obj || isActive) entities.push({ depth: r + c, col: c, c, r, kind: "obj" });
    }
  }
  for (const bd of G.world.buildings) {
    entities.push({ depth: (bd.row + 1) + (bd.col + 1), col: bd.col + 1, bd, kind: "bld" });
  }
  entities.sort((a, e) => (a.depth - e.depth) || (a.col - e.col) || (a.kind === "bld" ? -1 : 1));
  for (const e of entities) {
    if (e.kind === "bld") drawBuildingEntity(e.bd, z);
    else drawCellObject(e.c, e.r, z, activeCell);
  }

  // Ground drops (resource pickups) drawn on top of the world, each with a
  // matching cast shadow sheared along the ground.
  for (const d of G.drops) {
    if (d.phase === "fly") continue;
    const img = dropImage(d.kind);
    if (!img || !img.complete) continue;
    const lw = (img.naturalWidth || 32) * z * DROP_SCALE;
    const lh = (img.naturalHeight || 23) * z * DROP_SCALE;
    const sp = dropScreen(d);
    if (img._shadow) {
      ctx.save();
      ctx.globalAlpha = SHADOW_ALPHA;
      ctx.translate(sp.x, sp.y); // base of the drop
      ctx.transform(1, 0, SHADOW_SKEW, SHADOW_SQUASH, 0, 0);
      ctx.drawImage(img._shadow, -lw / 2, -lh, lw, lh);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(img, sp.x - lw / 2, sp.y - lh, lw, lh);
  }

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
    if (gimg && gimg.complete) {
      const a = buildingAnchor(col, row);
      const r = spriteRectAt(gimg, a, z, 0, 1);
      ctx.globalAlpha = 0.6;
      ctx.drawImage(gimg, r.tx, r.ty, r.dw, r.dh);
      ctx.globalAlpha = 1;
    }
  }

  // Dev cell inspector (console: debugoverlay true).
  if (G.debugOverlay) drawDebugOverlay(z);

  // Keep the world-anchored building panel and the placement hint in sync with
  // the current camera/selection (DOM overlays, updated once per rendered frame).
  positionBuildingPanel();
  updateBuildHint();
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
    const tile = inB ? G.world.tiles[r][c] : "(out of bounds)";
    const stage = inB ? G.world.stage[r][c] : -1;
    const rock = inB ? G.world.rock[r][c] : -1;
    const prog = inB ? (G.world.progress[r][c] | 0) : 0;
    const chop = inB ? (G.world.chop[r][c] | 0) : 0;
    const center = cellCenter(c, r);
    const s = worldToScreen(center.x, center.y);
    const tImg = inB ? tileSprite(tile, c, r, waterFrameIndex()) : null;
    lines.push("cell  col=" + c + " row=" + r + "  (r+c=" + (c + r) + ")");
    lines.push("screen  x=" + Math.round(s.x) + " y=" + Math.round(s.y) + "  zoom=" + z.toFixed(2));
    lines.push("tile  '" + tile + "'" + (tImg ? "  sprite " + (tImg.naturalWidth || "?") + "x" + (tImg.naturalHeight || "?") : "  (no sprite)"));
    lines.push("raw  stage=" + stage + " rock=" + rock + " progress=" + prog + " chop=" + chop);
    // The object the renderer would draw here (rock takes precedence).
    const obj = inB ? cellObject(c, r) : null;
    if (obj) {
      const img = obj.img;
      const matureMark = (obj.kind === "tree") ? (obj.stage >= GD.matureStage ? " MATURE" : "") : "";
      lines.push("object  " + obj.kind + (obj.kind === "tree" ? " stage=" + obj.stage + matureMark : " variant=" + obj.variant));
      lines.push("  lift=" + obj.lift + " sc=" + (obj.sc || 1).toFixed(2) + " flip=" + (!!obj.flip));
      lines.push("  sprite " + (img && img.naturalWidth || "?") + "x" + (img && img.naturalHeight || "?") + (img && img.complete ? "" : " (loading)"));
      lines.push("  src " + ((img && img.src) ? img.src.split("/").pop() : "(none)"));
    } else {
      lines.push("object  none");
    }
    // A building whose footprint covers this cell?
    const bd = inB && G.world.buildings.find((bb) =>
      buildingCells(bb.col, bb.row).some(([bc, br]) => bc === c && br === r));
    if (bd) lines.push("building  " + bd.type + " @(" + bd.col + "," + bd.row + ") tools=" + (bd.tools ? bd.tools.count : 0));
    // Outline the inspected cell in cyan (no bob) so it is unambiguous.
    const hw = HALF_W * z, hh = HALF_H * z;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - hh); ctx.lineTo(s.x + hw, s.y);
    ctx.lineTo(s.x, s.y + hh); ctx.lineTo(s.x - hw, s.y); ctx.closePath();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0, 255, 255, 0.95)"; ctx.stroke();
  }
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
