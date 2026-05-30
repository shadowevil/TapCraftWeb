// TapCraft - resources & harvesting: tools (durability), pops, drops, fx.
// Moved verbatim from the original game.js IIFE.
"use strict";

import {
  POP_MS, POP_AMOUNT,
  DROP_SCALE, FLY_MS,
  TOPBAR_H, SUBBAR_H,
  TOOL_SCALE, TOOL_SWING_DEG, TOOL_SWING_MS,
  HATCHET_PIVOT_X, HATCHET_PIVOT_Y, PICKAXE_PIVOT_X, PICKAXE_PIVOT_Y,
} from "./config.js";
import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { playSfx, playBuildingSfx } from "./sound.js";
import { fxctx } from "./dom.js";
import { resourceBarEl, resourceIconEl } from "./dom.js";
import { cellCenter, worldToScreen } from "./iso.js";
import { updateResourceUI } from "./ui.js";
import { updateCraftedHud } from "./crafting.js";

// --- Resources & harvesting ------------------------------------------
export function cellKey(c, r) { return r * G.world.cols + c; }

// Per-resource-kind helpers, driven by the resource registry (wood, stone, ...).
export function dropImage(kind) { return G.resImages[kind]; }
export function resourceEl(kind) { return resourceBarEl(kind); }
export function iconScreenPos(kind) {
  const r = resourceIconEl(kind).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// --- Tools (durability) ----------------------------------------------
export function hasTool(toolType) { return G.world.tools[toolType].count > 0; }
// Spend one swing of durability on the active tool; break it when it hits 0
// and promote the next one (if any) to a fresh full instance.
export function useTool(toolType) {
  const t = G.world.tools[toolType];
  if (t.count <= 0) return;
  t.dura -= 1;
  if (t.dura <= 0) { t.count -= 1; t.dura = t.count > 0 ? GD.harvest.toolDurability : 0; }
  updateCraftedHud();
}
export function addTool(toolType) {
  const t = G.world.tools[toolType];
  t.count += 1;
  if (t.count === 1) t.dura = GD.harvest.toolDurability; // first one becomes the active instance
  updateCraftedHud();
}

// One harvest swing's yield for an object kind, given whether a matching tool
// was used (pure: no durability side effect - the caller spends it). The tool
// raises the drop chance and doubles output.
export function harvestRoll(objKind, tooled) {
  const h = GD.harvest;
  const chance = tooled ? h.toolDropChance : h.baseDropChance;
  return Math.random() < chance ? (tooled ? h.toolOutput : h.baseOutput) : 0;
}

// Resolve tool use for a swing: manual harvests (opts omitted) use the player's
// crafted tool if any (spending durability); building swings pass {tooled:false}
// so they never consume the player's tools.
function resolveTooled(objKind, opts) {
  const toolType = GD.objects[objKind].tool;
  const tooled = (opts && opts.tooled !== undefined) ? opts.tooled : hasTool(toolType);
  if (tooled) useTool(toolType);
  return tooled;
}

// Play the hit sound for a harvest swing. Manual swings (no opts.building) go
// to the Effects channel; building-caused swings go to the reduced, globally
// rate-capped Building channel so many huts stay an ambient texture.
function hitSound(group, opts) {
  if (opts && opts.building) playBuildingSfx(group);
  else playSfx(group, "effects");
}

// Emit a pop's pending drops now if not yet emitted (so they aren't lost when
// the pop is replaced by a new click or removed by felling).
export function flushPopDrop(key) {
  const p = G.pops.get(key);
  if (p && !p.dropped) {
    p.dropped = true;
    for (let i = 0; i < p.dropCount; i++) spawnDrop(p.col, p.row, p.drop);
  }
}

// Click a tree: it "pops" every swing. Mature trees may drop wood (chance per
// swing) and count toward felling; after CHOP_CLICKS it reverts to a sprout.
export function harvestTree(col, row, opts) {
  if (G.world.stage[row][col] < GD.matureStage) return 0; // only fully-grown trees react
  const key = cellKey(col, row);
  flushPopDrop(key); // don't lose the pending drops from a still-running pop
  hitSound("hit_wood", opts);
  const tooled = resolveTooled("tree", opts);
  const dropCount = harvestRoll("tree", tooled);
  G.world.chop[row][col] = (G.world.chop[row][col] || 0) + 1;
  G.pops.set(key, { col, row, t0: G.animTime, drop: GD.objects.tree.drop, dropCount, dropped: false });
  // Schedule felling on its own timer; fast re-clicks must NOT postpone it.
  if (G.world.chop[row][col] >= GD.objects.tree.chopClicks && !G.chopResets.has(key)) {
    G.chopResets.set(key, G.animTime + POP_MS);
  }
  return dropCount;
}

// Click a rock: it "pops" and may drop stone (chance per swing). Infinite.
export function harvestRock(col, row, opts) {
  if (G.world.rock[row][col] < 0) return 0;
  const key = cellKey(col, row);
  flushPopDrop(key);
  hitSound("hit_stone", opts);
  const tooled = resolveTooled("rock", opts);
  const dropCount = harvestRoll("rock", tooled);
  G.pops.set(key, { col, row, t0: G.animTime, drop: GD.objects.rock.drop, dropCount, dropped: false });
  return dropCount;
}

export function spawnDrop(col, row, kind) {
  const c = cellCenter(col, row);
  const ang = Math.random() * Math.PI * 2;
  const spd = 18 + Math.random() * 26;
  G.drops.push({
    kind,
    gx: c.x, gy: c.y,                    // world ground position
    vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
    z: 34, vz: 70 + Math.random() * 30,  // height (world px) + upward velocity
    phase: "air",
  });
}

// Extra scale applied to a tree mid-pop (eases up then back down).
export function popFactor(col, row) {
  if (G.pops.size === 0) return 1; // fast path: no active pops (the common case)
  const p = G.pops.get(cellKey(col, row));
  if (!p) return 1;
  const prog = (G.animTime - p.t0) / POP_MS;
  if (prog <= 0 || prog >= 1) return 1;
  return 1 + POP_AMOUNT * Math.sin(prog * Math.PI);
}

// Ground point of a drop in main-canvas coords (height lifts it up).
export function dropScreen(d) {
  const s = worldToScreen(d.gx, d.gy);
  return { x: s.x, y: s.y - d.z * G.cam.zoom };
}
// Send a resting drop flying to its resource bar icon. Used by both the manual
// mouse-hover pickup and a building's auto-sweep. The fly start is captured in
// full-screen coords (canvas + the two top bars) so it lands on the bar.
export function startDropFly(d) {
  if (d.phase !== "rest") return;
  const sp = dropScreen(d);
  d.phase = "fly";
  d.flyT0 = G.animTime;
  d.fromX = sp.x;
  d.fromY = sp.y + (TOPBAR_H + SUBBAR_H);
}
export function dropHovered(d) {
  const img = dropImage(d.kind);
  if (!img) return false;
  const sp = dropScreen(d);
  const w = (img.naturalWidth || 32) * G.cam.zoom * DROP_SCALE;
  const h = (img.naturalHeight || 23) * G.cam.zoom * DROP_SCALE;
  return G.mouse.x >= sp.x - w / 2 && G.mouse.x <= sp.x + w / 2 && G.mouse.y >= sp.y - h && G.mouse.y <= sp.y;
}
export function collectDrop(kind) {
  G.world[kind] = (G.world[kind] | 0) + 1;
  updateResourceUI();
  const el = resourceEl(kind);
  if (el) {
    el.classList.add("tc-pop");
    setTimeout(() => el.classList.remove("tc-pop"), 130);
  }
}

// Flying drops are drawn on the full-screen overlay so they reach the bar.
export function renderFx() {
  fxctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (G.inMenu) return;
  fxctx.imageSmoothingEnabled = false;
  // Cache each resource's bar-icon position once per frame: iconScreenPos forces
  // a layout (getBoundingClientRect), so calling it per flying drop thrashes
  // layout when many drops fly at once. The bar icons don't move mid-frame.
  const iconCache = {};
  const iconPos = (kind) => iconCache[kind] || (iconCache[kind] = iconScreenPos(kind));
  for (const d of G.drops) {
    if (d.phase !== "fly") continue;
    const img = dropImage(d.kind);
    if (!img || !img.complete) continue;
    const icon = iconPos(d.kind);
    let fp = (G.animTime - d.flyT0) / FLY_MS;
    if (fp > 1) fp = 1;
    const e = fp < 0.5 ? 2 * fp * fp : 1 - Math.pow(-2 * fp + 2, 2) / 2;
    const x = d.fromX + (icon.x - d.fromX) * e;
    const y = d.fromY + (icon.y - d.fromY) * e;
    const scl = 1 - 0.45 * fp;
    const w = (img.naturalWidth || 32) * scl;
    const h = (img.naturalHeight || 23) * scl;
    fxctx.drawImage(img, x - w / 2, y - h / 2, w, h);
  }

  // Tool cursor: pivots at the handle grip (pinned to the mouse) and
  // oscillates back and forth across TOOL_SWING_DEG. Hatchet for trees,
  // pickaxe for rocks.
  let tool = null, pvx = 0, pvy = 0;
  if (G.showHatchet) { tool = G.toolImages.hatchet; pvx = HATCHET_PIVOT_X; pvy = HATCHET_PIVOT_Y; }
  else if (G.showPickaxe) { tool = G.toolImages.pickaxe; pvx = PICKAXE_PIVOT_X; pvy = PICKAXE_PIVOT_Y; }
  if (tool && tool.complete && G.mouse.on) {
    const px = G.mouse.x;                          // canvas coords ->
    const py = G.mouse.y + (TOPBAR_H + SUBBAR_H);  // full-screen coords
    const w = (tool.naturalWidth || 32) * TOOL_SCALE;
    const h = (tool.naturalHeight || 29) * TOOL_SCALE;
    const phase = (1 - Math.cos(G.animTime * (Math.PI * 2 / TOOL_SWING_MS))) / 2; // 0..1
    const angle = phase * TOOL_SWING_DEG * Math.PI / 180; // clockwise from rest
    fxctx.save();
    fxctx.translate(px, py);
    fxctx.rotate(angle);
    fxctx.drawImage(tool, -pvx * TOOL_SCALE, -pvy * TOOL_SCALE, w, h);
    fxctx.restore();
  }
}

// Harvest a specific object (dispatch by kind). opts forwards tool behavior
// (manual harvests omit it -> tool-aware; buildings pass {tooled:false}).
// Returns the swing's drop count.
export function doHarvest(obj, opts) {
  if (!obj) return 0;
  return obj.kind === "rock"
    ? harvestRock(obj.col, obj.row, opts)
    : harvestTree(obj.col, obj.row, opts);
}
