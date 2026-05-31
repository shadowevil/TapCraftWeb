// TapCraft - isometric coordinate transforms, culling and view fitting.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { HALF_W, HALF_H, SPRITE } from "./config.js";
import { G } from "./state.js";
import { canvas } from "./dom.js";

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
  return {
    c0: Math.max(0, Math.floor(minC) - M),
    c1: Math.min(G.world.cols - 1, Math.ceil(maxC) + M),
    r0: Math.max(0, Math.floor(minR) - M),
    r1: Math.min(G.world.rows - 1, Math.ceil(maxR) + M),
  };
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

// --- Buildings (2x2 footprint) ---------------------------------------
// A building's rear anchor is (col,row); it occupies that cell plus the three
// to the SE: (col+1,row), (col,row+1), (col+1,row+1). The "front" tile
// (col+1,row+1) has the largest r+c, so drawing the sprite there in the cell
// loop gives correct painter's-order occlusion.
export function buildingCells(col, row) {
  return [[col, row], [col + 1, row], [col, row + 1], [col + 1, row + 1]];
}
export function buildingFrontTile(col, row) {
  return { col: col + 1, row: row + 1 };
}
// Screen point where a bottom-center-anchored building sprite should plant:
// the front-bottom vertex of the 2x2 surface block. (Uses +HALF_H off the
// front cell center, not spriteRect's +SPRITE/2 slack, so tall art sits flush.)
export function buildingAnchor(col, row) {
  const fb = cellCenter(col + 1, row + 1);
  return worldToScreen(fb.x, fb.y + HALF_H * 2); // drop a full tile-diamond height to plant the foot
}
// The four OUTER vertices of the 2x2 block's surface diamond (world coords),
// for the bobbing hover ring. Caller applies worldToScreen + the bob lift.
export function buildingDiamondWorld(col, row) {
  const top = cellCenter(col, row);            // top vertex of the rear cell
  const right = cellCenter(col + 1, row);      // right vertex of the E cell
  const bottom = cellCenter(col + 1, row + 1); // bottom vertex of the front cell
  const left = cellCenter(col, row + 1);       // left vertex of the S cell
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
  const z = Math.min(6, Math.max(0.1, Math.min(w / (maxX - minX), h / (maxY - minY)) * fill));
  G.cam.zoom = z;
  G.cam.x = w / 2 - ((minX + maxX) / 2) * z;
  G.cam.y = h / 2 - ((minY + maxY) / 2) * z;
}
