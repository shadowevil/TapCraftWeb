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
import { canvas, ctx } from "./dom.js";
import { hash01, inBounds } from "./rng.js";
import { plantSprite, tileSprite, waterFrameIndex } from "./assets.js";
import {
  cellCenter, worldToScreen, screenToWorld, worldToCell,
  visibleCellBounds, spriteRect, spriteRectAt,
  buildingFrontTile, buildingAnchor, buildingDiamondWorld, buildingCells,
} from "./iso.js";
import { popFactor, dropImage, dropScreen } from "./resources.js";
import { canPlaceFootprint, canAffordBuilding, buildingTargets, cellsInRange } from "./buildings.js";
import { positionBuildingPanel, updateBuildHint } from "./ui.js";

// Sprite + placement for a plant cell (shared by render and hit-testing so
// they always agree on size/lift/flip).
export function plantDrawParams(stage, c, r) {
  const img = plantSprite(stage, c, r);
  if (!img) return null;
  if (stage === 0) return { img, lift: 0, sc: 1, flip: false };
  const flip = hash01(c, r, (G.world.seed ^ 0x000000a1) >>> 0) < 0.5;
  const sc = 0.9 + hash01(c, r, (G.world.seed ^ 0x000000b2) >>> 0) * 0.2;
  return { img, lift: OBJECT_LIFT, sc, flip };
}

// The object occupying a cell (rock takes precedence; a cell never has both),
// with the draw params render and hit-testing share. null if the cell is bare.
export function cellObject(c, r) {
  const rk = G.world.rock[r][c];
  if (rk >= 0) {
    const img = G.rockImages[rk];
    if (!img) return null;
    return { kind: "rock", img, lift: 0, sc: 1, flip: false, variant: rk };
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
        return { col: c, row: r, kind: obj.kind, stage: obj.stage, variant: obj.variant };
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
  // Tool cursor (OS cursor hidden): hatchet over a choppable tree, pickaxe
  // over a rock. While holding to harvest, lock the tool to the held kind.
  if (G.harvesting) {
    G.showHatchet = G.harvestKind === "tree";
    G.showPickaxe = G.harvestKind === "rock";
  } else {
    G.showHatchet = !!(G.hover && G.hover.kind === "tree" && G.hover.stage >= GD.matureStage);
    G.showPickaxe = !!(G.hover && G.hover.kind === "rock");
  }
  const wantCursor = (G.showHatchet || G.showPickaxe) ? "none" : "default";
  if (canvas.style.cursor !== wantCursor) canvas.style.cursor = wantCursor;
  const z = G.cam.zoom;
  const b = visibleCellBounds();
  const waterFrame = waterFrameIndex(); // same for all water cells this frame
  // The active cell is the hovered tree's cell (if any), else the ground tile.
  const activeCell = G.hover || G.hoverTile;
  // Index buildings by their front tile (col+1,row+1) so each draws in the
  // cell loop at its largest-r+c cell for correct painter's-order occlusion.
  const cols = G.world.cols;
  const buildingByFront = new Map();
  for (const bd of G.world.buildings) {
    const f = buildingFrontTile(bd.col, bd.row);
    buildingByFront.set(f.row * cols + f.col, bd);
  }
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const center = cellCenter(c, r);
      const s = worldToScreen(center.x, center.y);
      const tImg = tileSprite(G.world.tiles[r][c], c, r, waterFrame);
      if (tImg && tImg.complete) drawSprite(tImg, s, z, 0, 1, false);
      // Active outline in two halves: back edges behind the object, front
      // edges in front, so the ring wraps around the object on this cell.
      const isActive = activeCell && activeCell.col === c && activeCell.row === r;
      const diamond = isActive ? tileDiamond(s, z) : null;
      if (diamond) strokeDiamondHalf(diamond, "back");
      // The cell's object (rock or tree), with the click-pop scale applied.
      const obj = cellObject(c, r);
      if (obj && obj.img.complete) {
        const sc = obj.sc * popFactor(c, r);
        drawShadow(obj.img, s, z, obj.lift, sc, obj.flip); // cast before the sprite
        const hl = G.hover && G.hover.col === c && G.hover.row === r;
        if (hl) ctx.filter = "brightness(1.6)";
        drawSprite(obj.img, s, z, obj.lift, sc, obj.flip);
        if (hl) ctx.filter = "none";
      }
      if (diamond) strokeDiamondHalf(diamond, "front");
      // A building whose front tile is this cell: draw it here, wrapped by its
      // bobbing 2x2 ring when hovered or selected (back edges, sprite, front).
      const bd = buildingByFront.get(r * cols + c);
      if (bd) {
        const ringed = bd.id === G.hoverBuilding || bd.id === G.selectedBuilding;
        const ring = ringed ? buildingDiamond(bd.col, bd.row, z) : null;
        if (ring) strokeDiamondHalf(ring, "back");
        drawBuilding(bd, z, bd.id === G.hoverBuilding);
        if (ring) strokeDiamondHalf(ring, "front");
      }
    }
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

  // Keep the world-anchored building panel and the placement hint in sync with
  // the current camera/selection (DOM overlays, updated once per rendered frame).
  positionBuildingPanel();
  updateBuildHint();
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
