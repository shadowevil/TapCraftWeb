// TapCraft - resources & harvesting: tools (durability), pops, drops, fx.
// Moved verbatim from the original game.js IIFE.
"use strict";

import {
  POP_MS, POP_AMOUNT,
  DROP_SCALE, FLY_MS,
  TOPBAR_H, SUBBAR_H,
  TOOL_SCALE, TOOL_SWING_DEG, TOOL_SWING_MS,
  HATCHET_PIVOT_X, HATCHET_PIVOT_Y, PICKAXE_PIVOT_X, PICKAXE_PIVOT_Y,
  HOE_PIVOT_X, HOE_PIVOT_Y, FARM_CURSOR_SCALE,
} from "./config.js";
import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { playSfx, playBuildingSfx } from "./sound.js";
import { fxctx } from "./dom.js";
import { resourceBarEl, resourceIconEl } from "./dom.js";
import { cellCenter, worldToScreen } from "./iso.js";
import { mineableAt, mineableStockOf, mineableToughnessOf, mineableOutputOf } from "./mineable.js";
import { stageAt, chopAt, setChop, mineableStockAt, setMineableStock, setRockRaw } from "./cells.js";
import { updateResourceUI, postEvent } from "./ui.js";
import { updateCraftedHud } from "./crafting.js";

// --- Resources & harvesting ------------------------------------------
// Coordinate string so it works unbounded / with negative coords (infinite worlds).
export function cellKey(c, r) { return c + "," + r; }

// Per-resource-kind helpers, driven by the resource registry (wood, stone, ...).
export function dropImage(kind) { return G.resImages[kind]; }
export function resourceEl(kind) { return resourceBarEl(kind); }
export function iconScreenPos(kind) {
  const r = resourceIconEl(kind).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// --- Tools (durability) ----------------------------------------------
// A "tool stock" is { count, dura } where dura is the active/wearing tool's
// remaining durability and the other count-1 are full. The player's crafted
// pool (G.world.tools[type]) and each hut's own stock share this shape.
// A tool STOCK is a map { <toolId>: {count,dura} } - the player's crafted pool
// (G.world.tools) and each building's stock share this shape. Tools have a
// `kind` ("hatchet"/"pickaxe"); objects reference the KIND they need, and the
// best owned tier (highest sharpness) of that kind is used.
export function toolKind(toolId) { return GD.tools[toolId] ? (GD.tools[toolId].kind || toolId) : toolId; }
// A tool's MAX durability: its own `durability` (e.g. iron tools last 2x) or the
// shared default. One swing always costs 1, so this is also its "hits".
export function toolDurabilityFor(toolId) {
  const d = GD.tools[toolId] && GD.tools[toolId].durability;
  return d || GD.harvest.toolDurability;
}
export function hasTool(toolId) { return !!(G.world.tools[toolId] && G.world.tools[toolId].count > 0); }
// The best (highest-sharpness) owned tool id of a given kind in a stock, or null.
export function bestToolId(stock, kind) {
  let best = null, bestSharp = -1;
  for (const id of Object.keys(GD.tools)) {
    if ((GD.tools[id].kind || id) !== kind) continue;
    const s = stock[id];
    if (s && s.count > 0 && (GD.tools[id].sharpness || 0) > bestSharp) { best = id; bestSharp = GD.tools[id].sharpness || 0; }
  }
  return best;
}
// Spend one swing of durability on a stock's tool id; break it at 0 and promote
// the next one (if any) to a fresh full instance.
export function useToolStock(stock, toolId) {
  const t = stock[toolId];
  if (!t || t.count <= 0) return;
  t.dura -= 1;
  if (t.dura <= 0) { t.count -= 1; t.dura = t.count > 0 ? toolDurabilityFor(toolId) : 0; }
}
// Spend one durability on the PLAYER'S crafted tool id (and refresh its HUD).
export function useTool(toolId) {
  useToolStock(G.world.tools, toolId);
  updateCraftedHud();
}
export function addTool(toolId) {
  const t = G.world.tools[toolId] || (G.world.tools[toolId] = { count: 0, dura: 0 });
  t.count += 1;
  if (t.count === 1) t.dura = toolDurabilityFor(toolId); // first one becomes the active instance
  updateCraftedHud();
}

// Drop-chance multiplier from tool sharpness vs object toughness:
//   gap = toughness - sharpness
//   gap >= failGap (2+ under) -> 0     (too tough to harvest at all)
//   gap == 1        (1 under) -> underSharpMult (inefficient)
//   gap <= 0 (equal/over)     -> 1, or overSharpMult when strictly over
export function sharpnessMult(sharpness, toughness) {
  const h = GD.harvest;
  const gap = (toughness | 0) - (sharpness | 0);
  if (gap >= (h.failGap || 2)) return 0;
  if (gap === 1) return h.underSharpMult;
  if (gap < 0) return h.overSharpMult;
  return 1;
}

// Drop-chance multiplier for an actual swing, accounting for bare hands. A TOOL
// uses the normal sharpness-vs-toughness curve. BARE HANDS only work SOFT
// objects (toughness 0: small fieldstones, fallen logs) - anything tougher
// (trees, full rocks, ore veins) needs a real tool, stone tier up. Returns 0
// (fail) when hands face toughness 1+.
export function effectiveMult(toolId, sharpness, toughness) {
  const h = GD.harvest;
  if (!toolId) {
    if ((toughness | 0) > 0) return 0; // hands only gather soft (toughness 0) objects
    return sharpnessMult(h.baseSharpness | 0, toughness);
  }
  return sharpnessMult(sharpness, toughness);
}

// One harvest swing's yield for an object kind (pure: no durability side effect -
// the caller spends it). `toolId` is the specific tool used (null = bare hands).
// The chance is scaled by tool sharpness vs object toughness, and is zero when
// the object is too tough for the tool (2+ toughness gap). `ov` lets variant-
// aware callers override per swing: { toughness } (small soft rocks), and
// { chance, output } for sure-drop objects (fallen logs: chance 1, fixed yield)
// which replace the tool/hands roll entirely.
export function harvestRoll(objKind, toolId, sharpness, ov) {
  const h = GD.harvest;
  const toughness = (ov && ov.toughness != null) ? ov.toughness
    : (GD.objects[objKind].toughness != null) ? GD.objects[objKind].toughness : 1; // != null: toughness 0 = hand-gatherable

  const mult = effectiveMult(toolId, sharpness, toughness);
  if (mult <= 0) return 0; // too tough for this tool/hands
  if (ov && (ov.chance != null || ov.output != null)) {
    const c = Math.min(1, (ov.chance != null ? ov.chance : (toolId ? GD.tools[toolId].dropChance : h.baseDropChance)) * mult);
    const o = (ov.output != null) ? ov.output : (toolId ? GD.tools[toolId].output : h.baseOutput);
    return Math.random() < c ? o : 0;
  }
  if (toolId) {
    const tool = GD.tools[toolId];
    return Math.random() < tool.dropChance * mult ? tool.output : 0;
  }
  return Math.random() < h.baseDropChance * mult ? h.baseOutput : 0;
}

// Resolve tool use for a swing against a tool STOCK, picking the best owned tier
// of the object's needed KIND. Manual harvests use the player pool; building
// swings pass the hut's own stock. Returns { toolId, sharpness } (toolId null =
// bare hands). Spends one durability on the chosen tool.
function resolveTooled(objKind, opts) {
  const kind = GD.objects[objKind].tool; // the tool KIND this object needs
  const stock = (opts && opts.toolStock) ? opts.toolStock : G.world.tools;
  // opts.tooled:false forces bare hands (unused now, kept for safety).
  const allowTool = !(opts && opts.tooled === false);
  const toolId = allowTool ? bestToolId(stock, kind) : null;
  const sharpness = toolId ? (GD.tools[toolId].sharpness || 0) : (GD.harvest.baseSharpness | 0);
  if (toolId) {
    if (opts && opts.toolStock) useToolStock(stock, toolId); // hut stock: no player HUD refresh
    else useTool(toolId);                                    // player pool: refresh HUD
  }
  return { toolId, sharpness };
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
  if (stageAt(col, row) < GD.matureStage) return 0; // only fully-grown trees react
  const key = cellKey(col, row);
  flushPopDrop(key); // don't lose the pending drops from a still-running pop
  hitSound("hit_wood", opts);
  const { toolId, sharpness } = resolveTooled("tree", opts);
  // Bare hands cannot chop a tree any more (toughness 1 needs a real tool) -
  // tell the player why nothing is happening (manual swings only).
  if (!toolId && !(opts && opts.building)) {
    postEvent("You need a hatchet to chop trees.");
  }
  const dropCount = harvestRoll("tree", toolId, sharpness);
  // Felling only progresses on a SUCCESSFUL hit: a swing that yields no wood
  // still plays the hit/pop, but doesn't count toward chopping the tree down -
  // you can't fell a tree for nothing.
  // noDrops (building harvest): the tree still bounces + fells, but spawns no
  // physical drops - the caller accrues the returned yield into the building.
  const spawnCount = (opts && opts.noDrops) ? 0 : dropCount;
  const pop = { col, row, t0: G.animTime, drop: GD.objects.tree.drop, dropCount: spawnCount, dropped: false };
  if (dropCount > 0) {
    const nc = (chopAt(col, row) || 0) + 1;
    setChop(col, row, nc);
    if (nc >= GD.objects.tree.chopClicks && !G.chopResets.has(key)) {
      G.chopResets.set(key, G.animTime + POP_MS);
    }
  }
  G.pops.set(key, pop);
  return dropCount;
}

// Strike a mineable (rock / iron vein / gold vein): it "pops" and may drop its
// resource (chance scaled by tool sharpness vs the object's toughness). FINITE:
// each mineable holds a stock pool (data: def.stock, e.g. 1000); every yielded
// unit depletes it and at 0 the mineable is REMOVED for good (mined out - no
// respawn, no spreading). A too-tough strike still pops + clinks but yields
// nothing and costs no stock.
export function harvestMineable(col, row, opts) {
  const m = mineableAt(col, row);
  if (!m) return 0;
  const def = GD.objects[m.typeId];
  const key = cellKey(col, row);
  flushPopDrop(key);
  // Variant-aware stats: small surface rocks are SOFT (toughness 0 - bare hands
  // get the over-sharp bonus) but hold only a handful of stone; fallen logs are
  // sure-drop gathers (chance 1, fixed output - the pile variant yields 2).
  const tough = mineableToughnessOf(def, m.variant);
  // Hand-gathers (toughness 0) are QUIET pickups: no tool-hit clink/thunk (the
  // drop collect is the feedback) and NEVER a tool swing - a pickaxe on a small
  // fieldstone would burn durability for zero benefit.
  if (tough !== 0) hitSound(def.drop === "wood" ? "hit_wood" : "hit_stone", opts); // TODO: dedicated "too tough" clink when 0 yield
  const handOpts = (tough === 0) ? Object.assign({}, opts, { tooled: false }) : opts;
  const { toolId, sharpness } = resolveTooled(m.typeId, handOpts);
  // Too tough for the tool at all? Tell the player (manual strikes only, so a
  // mining hut on gold does not spam the event log).
  if (effectiveMult(toolId, sharpness, tough) <= 0
      && !(opts && opts.building)) {
    const what = GD.resources[def.drop] ? GD.resources[def.drop].name : def.drop;
    const need = (def.tool === "hatchet") ? "a hatchet" : "a pickaxe";
    postEvent(toolId ? ("Your tool is too weak to mine " + what + ".")
                     : ("You need " + need + " to gather " + what + "."));
  }
  let dropCount = harvestRoll(m.typeId, toolId, sharpness, {
    toughness: tough,
    chance: (def.dropChance != null) ? def.dropChance : undefined,
    output: mineableOutputOf(def, m.variant) != null ? mineableOutputOf(def, m.variant) : undefined,
  });
  // Deplete the stock: clamp this swing's yield to what is left, write the
  // remainder, and remove the mineable once it runs dry.
  if (dropCount > 0) {
    const fullStock = mineableStockOf(def, m.variant);
    const full = (fullStock != null) ? fullStock : Infinity;
    if (full !== Infinity) {
      const left = mineableStockAt(col, row, full);
      if (dropCount > left) dropCount = left;
      if (dropCount <= 0) return 0;
      const remain = left - dropCount;
      setMineableStock(col, row, remain);
      if (remain <= 0) {
        setRockRaw(col, row, -1); // mined out: gone for good
        const what = GD.resources[def.drop] ? GD.resources[def.drop].name : def.drop;
        if (!(opts && opts.building)) postEvent("The " + (def.name || what) + " is mined out.");
      }
    }
  }
  // noDrops (building harvest): bounce/sound only, no physical drops.
  const spawnCount = (opts && opts.noDrops) ? 0 : dropCount;
  G.pops.set(key, { col, row, t0: G.animTime, drop: def.drop, dropCount: spawnCount, dropped: false });
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
    if (!img || !img.complete || !img.naturalWidth) continue;
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

  // Tool cursor: pivots at the handle grip (pinned to the mouse) and oscillates.
  // Show the best owned tool of the kind (so an iron tool shows the iron cursor).
  let tool = null, pvx = 0, pvy = 0;
  if (G.showHatchet) { tool = G.toolImages[bestToolId(G.world.tools, "hatchet") || "hatchet"]; pvx = HATCHET_PIVOT_X; pvy = HATCHET_PIVOT_Y; }
  else if (G.showPickaxe) { tool = G.toolImages[bestToolId(G.world.tools, "pickaxe") || "pickaxe"]; pvx = PICKAXE_PIVOT_X; pvy = PICKAXE_PIVOT_Y; }
  else if (G.showHoe) { tool = G.toolImages[bestToolId(G.world.tools, "garden_hoe") || "garden_hoe"]; pvx = HOE_PIVOT_X; pvy = HOE_PIVOT_Y; }
  if (tool && tool.complete && tool.naturalWidth && G.mouse.on) {
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

  // Static farm cursor (no swing): the pour bucket over a waterable tile, the empty
  // bucket over water (fill), or a seed pouch over plantable soil. Drawn centred on
  // the pointer (the OS cursor is hidden while any of these are set).
  if (G.farmCursor && !tool && G.mouse.on) {
    let img = null;
    if (G.farmCursor === "pour") img = G.farmImages.pour;
    else if (G.farmCursor === "fill") img = G.toolImages.bucket;
    else if (G.farmCursor === "seeds") img = G.resImages.wheat_seeds;
    if (img && img.complete && img.naturalWidth) {
      const px = G.mouse.x, py = G.mouse.y + (TOPBAR_H + SUBBAR_H);
      const w = img.naturalWidth * FARM_CURSOR_SCALE, h = img.naturalHeight * FARM_CURSOR_SCALE;
      fxctx.drawImage(img, px - w / 2, py - h / 2, w, h);
    }
  }

  // Animated grab-hand cursor over hand-gatherable pickups (fallen logs, small
  // fieldstone): cycles GD.harvest.grabCursor.frames while hovering/holding.
  // Frames that failed to load are skipped, so a broken frame just shortens
  // the cycle instead of blinking the cursor out.
  if (G.showGrab && !tool && !G.farmCursor && G.mouse.on) {
    const frames = G.grabFrames.filter((f) => f && f.complete && f.naturalWidth);
    if (frames.length) {
      const ms = (GD.harvest.grabCursor && GD.harvest.grabCursor.frameMs) || 160;
      const img = frames[Math.floor(G.animTime / ms) % frames.length];
      const px = G.mouse.x, py = G.mouse.y + (TOPBAR_H + SUBBAR_H);
      const w = img.naturalWidth * FARM_CURSOR_SCALE, h = img.naturalHeight * FARM_CURSOR_SCALE;
      fxctx.drawImage(img, px - w / 2, py - h / 2, w, h);
    }
  }
}

// Harvest a specific object (dispatch by kind). opts forwards tool behavior
// (manual harvests omit it -> tool-aware; buildings pass {tooled:false}).
// Returns the swing's drop count.
export function doHarvest(obj, opts) {
  if (!obj) return 0;
  return obj.mineable
    ? harvestMineable(obj.col, obj.row, opts)
    : harvestTree(obj.col, obj.row, opts);
}

// The hold-harvest CATEGORY of a clickable object: "tree", "mine" (tool-worked
// mineables - drives the pickaxe cursor + cadence), or "hand" (toughness-0
// pickups: fallen logs, small fieldstone - no tool cursor, bare-hand cadence).
// Shared by input.js (click lock) and sim.js (hold re-target) so they agree.
export function harvestCategory(obj) {
  if (!obj.mineable) return "tree";
  const def = GD.objects[obj.kind];
  return (def && mineableToughnessOf(def, obj.variant) === 0) ? "hand" : "mine";
}
