// TapCraft - isometric coordinate transforms, culling and view fitting.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { HALF_W, HALF_H, SPRITE, MAX_VISIBLE_CELLS } from "./config.js";
import { G } from "./state.js";
import { canvas } from "./dom.js";

// Minimum zoom (max zoom-out): derived so the visible CELL-BOUNDING-BOX stays
// under the budget. visibleCellBounds iterates the axis-aligned box of the rotated
// (diamond) viewport; its side in cells is W/(2*HALF_W*z) + H/(2*HALF_H*z), so the
// box holds (A/z)^2 cells where A = W/(2*HALF_W) + H/(2*HALF_H). Solve (A/z)^2 = budget.
export function minZoom() {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  const a = w / (2 * HALF_W) + h / (2 * HALF_H);
  return a / Math.sqrt(MAX_VISIBLE_CELLS);
}

// --- Coordinate transforms / culling ---------------------------------
export function cellCenter(col, row) {
  return { x: (col - row) * HALF_W, y: (col + row) * HALF_H };
}
export function worldToScreen(wx, wy) {
  return { x: wx * G.cam.zoom + G.cam.x, y: wy * G.cam.zoom + G.cam.y };
}
export function screenToWorld(sx, sy) {
  return { x: (sx - G.cam.x) / G.cam.zoom, y: (sy - G.cam.y) / G.cam.zoom };
}
export function worldToCell(wx, wy) {
  return {
    col: Math.round(wx / (HALF_W * 2) + wy / (HALF_H * 2)),
    row: Math.round(wy / (HALF_H * 2) - wx / (HALF_W * 2)),
  };
}
export function visibleCellBounds() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const pts = [screenToWorld(0, 0), screenToWorld(w, 0), screenToWorld(0, h), screenToWorld(w, h)];
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const p of pts) {
    const { col, row } = worldToCell(p.x, p.y);
    minC = Math.min(minC, col); maxC = Math.max(maxC, col);
    minR = Math.min(minR, row); maxR = Math.max(maxR, row);
  }
  const M = 4;
  const c0 = Math.floor(minC) - M, c1 = Math.ceil(maxC) + M;
  const r0 = Math.floor(minR) - M, r1 = Math.ceil(maxR) + M;
  // Infinite worlds have no edge to clamp against; finite worlds clamp to bounds.
  if (G.world.infinite) return { c0, c1, r0, r1 };
  // A WRAPPING axis is left unclamped - the floor/entity loops iterate the raw
  // coordinates (drawing at the raw screen position) while the cell accessors
  // canonicalize the lookup, giving a seamless loop. The torus globe wraps both axes.
  return {
    c0: G.world.wrapX ? c0 : Math.max(0, c0),
    c1: G.world.wrapX ? c1 : Math.min(G.world.cols - 1, c1),
    r0: G.world.wrapY ? r0 : Math.max(0, r0),
    r1: G.world.wrapY ? r1 : Math.min(G.world.rows - 1, r1),
  };
}

// The cell at the CENTER of the current view (midpoint of the visible cell box). Several systems
// sample "where the player is looking" from here - growth (sim.js), regional weather (env.js),
// the forecast widget, and the wetness status readout - so the definition lives in one place
// instead of being re-derived identically at each call site.
export function viewCenterCell() {
  const vb = visibleCellBounds();
  return { c: Math.round((vb.c0 + vb.c1) / 2), r: Math.round((vb.r0 + vb.r1) / 2) };
}

// Top-left of a sprite drawn on cell-anchor `s` (shared by sprite + shadow).
export function spriteRect(img, s, z, lift, sc) {
  const w = img.naturalWidth || img.width || SPRITE;
  const h = img.naturalHeight || img.height || SPRITE;
  const dw = w * z * sc, dh = h * z * sc;
  return { dw, dh, tx: s.x - dw / 2, ty: s.y - lift * z + (SPRITE / 2) * z - dh };
}
// Same shape as spriteRect but bottom-center anchored exactly at screen point
// `a` (no cell-diamond slack). Used for multi-tile buildings whose plant point
// is the front-bottom vertex of their footprint block (see buildingAnchor).
export function spriteRectAt(img, a, z, lift, sc) {
  const w = img.naturalWidth || img.width || SPRITE;
  const h = img.naturalHeight || img.height || SPRITE;
  const dw = w * z * sc, dh = h * z * sc;
  return { dw, dh, tx: a.x - dw / 2, ty: a.y - dh - lift * z };
}

// --- Buildings (data-driven w x h footprint) ---------------------------------
// A building's rear anchor is (col,row); it occupies the w x h block extending
// to the SE. The "front" tile (col+w-1, row+h-1) has the largest r+c, so drawing
// the sprite there in the cell loop gives correct painter's-order occlusion.
// w/h default to the classic 2x2 so callers of the old shape stay correct;
// buildings.js footprintOf(type) supplies the data-driven size (1x1 torch,
// 3x3 town hall, 2x2 huts).
export function buildingCells(col, row, w = 2, h = 2) {
  const out = [];
  for (let dr = 0; dr < h; dr++) {
    for (let dc = 0; dc < w; dc++) out.push([col + dc, row + dr]);
  }
  return out;
}
export function buildingFrontTile(col, row, w = 2, h = 2) {
  return { col: col + w - 1, row: row + h - 1 };
}
// Screen point where a bottom-center-anchored building sprite should plant:
// the front-bottom vertex of the footprint's surface block. (Uses +HALF_H off
// the front cell center, not spriteRect's +SPRITE/2 slack, so tall art sits flush.)
export function buildingAnchor(col, row, w = 2, h = 2) {
  const fb = cellCenter(col + w - 1, row + h - 1);
  return worldToScreen(fb.x, fb.y + HALF_H * 2); // drop a full tile-diamond height to plant the foot
}
// The four OUTER vertices of the footprint's surface diamond (world coords),
// for the bobbing hover ring. Caller applies worldToScreen + the bob lift.
export function buildingDiamondWorld(col, row, w = 2, h = 2) {
  const top = cellCenter(col, row);                        // top vertex of the rear cell
  const right = cellCenter(col + w - 1, row);              // right vertex of the E corner cell
  const bottom = cellCenter(col + w - 1, row + h - 1);     // bottom vertex of the front cell
  const left = cellCenter(col, row + h - 1);               // left vertex of the S corner cell
  return {
    top: { x: top.x, y: top.y - HALF_H },
    right: { x: right.x + HALF_W, y: right.y },
    bottom: { x: bottom.x, y: bottom.y + HALF_H },
    left: { x: left.x - HALF_W, y: left.y },
  };
}

export function fitView(overscan) {
  const corners = [
    cellCenter(0, 0), cellCenter(G.world.cols - 1, 0),
    cellCenter(0, G.world.rows - 1), cellCenter(G.world.cols - 1, G.world.rows - 1),
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of corners) {
    minX = Math.min(minX, p.x - HALF_W); maxX = Math.max(maxX, p.x + HALF_W);
    minY = Math.min(minY, p.y - SPRITE); maxY = Math.max(maxY, p.y + SPRITE / 2);
  }
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const fill = (overscan || 0.92);
  const z = Math.min(6, Math.max(minZoom(), Math.min(w / (maxX - minX), h / (maxY - minY)) * fill));
  G.cam.zoom = z;
  G.cam.x = w / 2 - ((minX + maxX) / 2) * z;
  G.cam.y = h / 2 - ((minY + maxY) / 2) * z;
}

// Center the camera on a cell at a given zoom (used for huge/infinite worlds,
// where fitting the whole world is meaningless). Zoom is clamped to [minZoom,6].
export function centerCameraOn(cell, zoom) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const z = Math.min(6, Math.max(minZoom(), zoom));
  const ctr = cellCenter(cell.c, cell.r);
  G.cam.zoom = z;
  G.cam.x = w / 2 - ctr.x * z;
  G.cam.y = h / 2 - ctr.y * z;
}
