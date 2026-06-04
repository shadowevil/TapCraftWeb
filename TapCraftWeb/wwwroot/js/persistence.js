// TapCraft - persistence (multiple worlds in localStorage) + save sanitizers.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { WORLDS_KEY, CURRENT_KEY, worldKey } from "./config.js";
import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { newTools, resetTransients } from "./worldgen.js";
import { initWorldGen, createMods, modsToEntries, modsFromEntries, modsSetCell, countTilled } from "./cells.js";
import { wetToEntries, wetFromEntries } from "./wetness.js";
import { updateResourceUI } from "./ui.js";
import { updateCraftedHud } from "./crafting.js";

// Restore saved tools/craft defensively (older saves won't have them).
export function sanitizeTools(saved) {
  const t = newTools();
  if (saved) {
    for (const k of Object.keys(t)) {
      const s = saved[k];
      if (s) { t[k].count = s.count | 0; t[k].dura = s.dura | 0; }
    }
  }
  return t;
}
export function sanitizeCraft(saved) {
  const out = {};
  if (saved) {
    for (const id of Object.keys(GD.crafting.recipes)) {
      const s = saved[id];
      if (s && (s.remaining | 0) > 0) out[id] = { remaining: s.remaining | 0, elapsed: +s.elapsed || 0, charged: !!s.charged };
    }
  }
  return out;
}
// Restore placed buildings defensively: drop unknown types, coerce fields,
// default facing/produced. Transient worker state is rebuilt lazily by the sim.
export function sanitizeBuildings(saved) {
  const out = [];
  if (Array.isArray(saved)) {
    for (const b of saved) {
      if (!b || !GD.buildings[b.type]) continue;
      const produced = {};
      if (b.produced && typeof b.produced === "object") {
        for (const k of Object.keys(b.produced)) produced[k] = b.produced[k] | 0;
      }
      const stored = {};
      if (b.stored && typeof b.stored === "object") {
        for (const k of Object.keys(b.stored)) stored[k] = b.stored[k] | 0;
      }
      const rec = {
        id: b.id || ("b_" + out.length),
        type: b.type,
        col: b.col | 0,
        row: b.row | 0,
        facing: b.facing === "SW" ? "SW" : "SE",
        produced,
        stored,
      };
      // What this building actually cost (scaled types refund off it; absent on
      // old saves -> demolish falls back to the base buildCost).
      if (b.paid && typeof b.paid === "object") {
        rec.paid = {};
        for (const k of Object.keys(b.paid)) rec.paid[k] = b.paid[k] | 0;
      }
      const cat = GD.buildings[b.type].category;
      if (cat === "harvester") {
        // Tool stock is a per-tool-id map { <id>: {count,dura} }. Tolerate the
        // OLD single-slot shape ({count,dura}) by mapping it onto the hut's kind.
        const tools = {};
        if (b.tools && typeof b.tools === "object") {
          if (typeof b.tools.count === "number") {
            // legacy single slot -> assign to the kind's tier-1 tool id if known
            const td = GD.objects[GD.buildings[b.type].targetKind];
            const kind = td ? td.tool : null;
            if (kind && b.tools.count > 0) tools[kind] = { count: b.tools.count | 0, dura: b.tools.dura | 0 || (GD.tools[kind] && GD.tools[kind].durability) || GD.harvest.toolDurability };
          } else {
            for (const id of Object.keys(b.tools)) {
              if (!GD.tools[id]) continue;
              const c = b.tools[id].count | 0;
              if (c > 0) tools[id] = { count: c, dura: Math.max(0, b.tools[id].dura | 0) || (GD.tools[id] && GD.tools[id].durability) || GD.harvest.toolDurability };
            }
          }
        }
        rec.tools = tools;
      } else if (cat === "smelter") {
        const oreStored = {}, ingots = {};
        if (b.oreStored && typeof b.oreStored === "object")
          for (const k of Object.keys(b.oreStored)) oreStored[k] = Math.max(0, b.oreStored[k] | 0);
        if (b.ingots && typeof b.ingots === "object")
          for (const k of Object.keys(b.ingots)) ingots[k] = Math.max(0, b.ingots[k] | 0);
        rec.oreStored = oreStored;
        rec.ingots = ingots;
        rec.fuel = Math.max(0, +b.fuel || 0);
        rec.smelt = null; // restart any in-progress job cleanly
      }
      out.push(rec);
    }
  }
  return out;
}

// --- Panel layout (craft/build draggable panels) ---------------------
// makeDraggable() writes panel.style.left/top (px) as the player drags; open/
// closed is the .hidden class. We snapshot both per panel so the layout is
// restored on reload (see applyPanels). The DOM is read by id directly to avoid
// importing dom.js (which would add an import edge); a missing panel yields null.
const PANEL_IDS = { craft: "tc-craft-panel", build: "tc-build-panel" };
function panelPos(elm) {
  if (!elm) return null;
  // style.left/top are only set once the panel has been dragged; fall back to
  // null (CSS default position) otherwise so we never pin an undragged panel to 0,0.
  const left = elm.style.left, top = elm.style.top;
  return {
    left: left || null,
    top: top || null,
    open: !elm.classList.contains("hidden"),
  };
}
function capturePanels() {
  const out = {};
  for (const key of Object.keys(PANEL_IDS)) out[key] = panelPos(document.getElementById(PANEL_IDS[key]));
  return out;
}
// Restore saved panel positions + open state. Robust to missing panels/values:
// only a real px string is applied, and open state is only honored if present.
export function applyPanels(saved) {
  if (!saved || typeof saved !== "object") return;
  for (const key of Object.keys(PANEL_IDS)) {
    const s = saved[key];
    const elm = document.getElementById(PANEL_IDS[key]);
    if (!elm || !s) continue;
    if (typeof s.left === "string" && s.left) { elm.style.left = s.left; elm.style.right = "auto"; }
    if (typeof s.top === "string" && s.top) elm.style.top = s.top;
    if (typeof s.open === "boolean") elm.classList.toggle("hidden", !s.open);
  }
}

// --- Persistence (multiple worlds) -----------------------------------
export function readWorldsIndex() {
  try { const a = JSON.parse(localStorage.getItem(WORLDS_KEY)); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
export function writeWorldsIndex(list) {
  try { localStorage.setItem(WORLDS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
// --- Save scheduling ---------------------------------------------------------
// saveWorld() is fired liberally (every craft unit, deposit/withdraw click, build,
// pause, the 5s autosave). Each call used to do a FULL world JSON.stringify +
// synchronous localStorage write, so a burst (bulk craft, +/- spamming) stuttered
// the main thread. Now the hot callers COALESCE: mark dirty + schedule one trailing
// flush. The durability guarantee (incl. the craft data-loss fix) is preserved by
// flushing SYNCHRONOUSLY via saveWorldNow() on every context-leaving path - tab
// hide / unload (main.js) and returning to the menu / explicit Save (ui.js) - so a
// charged unit always reaches disk before the world is left or the page goes away.
let saveTimer = 0, saveDirty = false;
const SAVE_DEBOUNCE_MS = 700;
export function saveWorld() {
  if (!G.hasWorld || !G.world.id) return; // menu background has no id -> not saved
  saveDirty = true;
  if (!saveTimer) saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}
function flushSave() {
  saveTimer = 0;
  if (!saveDirty) return;
  saveDirty = false;
  doSave();
}
// Immediate, synchronous write. A pending debounced flush would never run once the
// page is unloading or G.world is about to be swapped, so these paths call this.
export function saveWorldNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
  saveDirty = false;
  doSave();
}
function doSave() {
  if (!G.hasWorld || !G.world.id) return; // menu background has no id -> not saved
  try {
    // Terrain is procedural - we save the seed + settings, NOT the cells. Only the
    // sparse map of modified cells (G.world.mods) is persisted, so even an infinite
    // world's save stays small (it grows only with what the player changes).
    localStorage.setItem(worldKey(G.world.id), JSON.stringify({
      version: 15, id: G.world.id, name: G.world.name,
      infinite: G.world.infinite, cols: G.world.cols, rows: G.world.rows, seed: G.world.seed,
      settings: G.world.settings,
      landThreshold: G.world.landThreshold, spawn: G.world.spawn,
      cam: { x: G.cam.x, y: G.cam.y, zoom: G.cam.zoom },
      mods: modsToEntries(G.world.mods),
      wet: wetToEntries(G.world.wet),
      wood: G.world.wood, stone: G.world.stone, iron: G.world.iron, gold: G.world.gold,
      iron_ingot: G.world.iron_ingot, gold_ingot: G.world.gold_ingot, gold_coin: G.world.gold_coin,
      wheat_seeds: G.world.wheat_seeds, wheat: G.world.wheat,
      tools: G.world.tools, craft: G.world.craft,
      buildings: G.world.buildings.map((b) => ({ id: b.id, type: b.type, col: b.col, row: b.row, facing: b.facing, paid: b.paid,
        produced: b.produced, stored: b.stored, tools: b.tools, oreStored: b.oreStored, ingots: b.ingots, fuel: b.fuel })),
      drops: G.drops.filter((d) => d.phase === "rest").map((d) => ({ kind: d.kind, gx: d.gx, gy: d.gy })),
      timeOfDay: G.world.timeOfDay, day: G.world.day | 0, tick: G.world.tick, running: G.running,
      // Per-world UI layout: the draggable craft/build panels' last position + open
      // state, so they reappear where the player left them (see capturePanels/ui.js).
      panels: capturePanels(),
    }));
    localStorage.setItem(CURRENT_KEY, G.world.id);
    const list = readWorldsIndex();
    const entry = { id: G.world.id, name: G.world.name, size: G.world.cols, updatedAt: Date.now() };
    const i = list.findIndex((w) => w.id === G.world.id);
    if (i >= 0) list[i] = entry; else list.push(entry);
    writeWorldsIndex(list);
  } catch (e) { /* storage full / unavailable */ }
}
export function loadWorld(id) {
  // Drop any pending debounced flush: it would target the world we are about to
  // replace (the caller saved it synchronously via showMainMenu first).
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
  saveDirty = false;
  const json = localStorage.getItem(worldKey(id));
  if (!json) return false;
  try {
    const d = JSON.parse(json);
    if (!d) return false;
    G.world.id = d.id || id;
    G.world.name = d.name || "World";
    G.world.infinite = !!d.infinite;
    G.world.cols = d.cols | 0; G.world.rows = d.rows | 0; G.world.seed = d.seed >>> 0;
    G.world.settings = Object.assign({}, GD.defaults.worldSettings, d.settings);
    // Rebuild the procedural generator (noise closures); it also (re)derives the
    // land threshold + spawn deterministically from the seed.
    initWorldGen(G.world.seed, G.world.settings);
    if ((d.version | 0) >= 11) {
      if (typeof d.landThreshold === "number") G.world.landThreshold = d.landThreshold;
      if (d.spawn) G.world.spawn = d.spawn;
      G.world.mods = modsFromEntries(d.mods);
    } else {
      // Pre-procedural saves (always small) stored full cell arrays; import every
      // cell as an explicit delta so the world renders exactly as it was saved.
      G.world.mods = createMods();
      migrateLegacyArrays(d);
    }
    // Ground wetness overlay (added v13); absent on older saves -> starts dry.
    G.world.wet = wetFromEntries(d.wet);
    // Farmland (added v14): the live tilled-tile counter is rebuilt from the loaded
    // mods (it is transient); old saves have no tilled cells or farm resources.
    G.world.tilled = countTilled(G.world.mods);
    G.world.wood = d.wood | 0;
    G.world.stone = d.stone | 0;
    G.world.iron = d.iron | 0;
    G.world.gold = d.gold | 0;
    G.world.iron_ingot = d.iron_ingot | 0;
    G.world.gold_ingot = d.gold_ingot | 0;
    G.world.gold_coin = d.gold_coin | 0;
    G.world.wheat_seeds = d.wheat_seeds | 0;
    G.world.wheat = d.wheat | 0;
    G.world.tools = sanitizeTools(d.tools);
    // v14 migration: filled-ness used to be a single bucketWater flag on the whole
    // stack. Move ONE bucket (the active one, carrying its uses) onto the filled
    // stack; v15+ saves persist the two stacks directly inside `tools`.
    if (d.bucketWater) {
      const e = G.world.tools.bucket, f = G.world.tools.bucket_water;
      if (e && e.count > 0 && f && f.count === 0) {
        f.count = 1; f.dura = e.dura;
        e.count -= 1; e.dura = e.count > 0 ? (GD.tools.bucket.durability || GD.harvest.toolDurability) : 0;
      }
    }
    // Craft data-loss fix. ROOT CAUSE: in-progress crafts were saved, but the only
    // saves happened on explicit pause/play, deposits, etc - NOT when a craft was
    // queued or charged. So queueing a craft deducted resources in memory only;
    // leaving via a path that did not save (tab close, reload) then restored the
    // PRE-craft save, and the half-done unit (already charged in the lost session)
    // never finished -> the player saw resources spent with no tool delivered.
    // FIX: (1) always normalize the loaded craft to a valid per-recipe map here
    // (sanitizeCraft never returns null and keeps each job's `charged`+`elapsed`,
    // so advanceCrafting RESUMES a half-done unit without re-charging and delivers
    // the tool on completion); (2) save at craft state-changes + a beforeunload
    // autosave (crafting.js / main.js) so the charged unit always reaches disk.
    G.world.craft = sanitizeCraft(d.craft);
    G.world.buildings = sanitizeBuildings(d.buildings);
    G.world.tick = d.tick || 0;
    G.world.timeOfDay = (typeof d.timeOfDay === "number") ? d.timeOfDay : 0.3;
    // Day counter: default 1 so pre-v12 saves (no `day`) start on day 1.
    G.world.day = (d.day | 0) > 0 ? (d.day | 0) : 1;
    resetTransients(); // also clears building worker/selection transients
    const savedDrops = Array.isArray(d.drops) ? d.drops : (Array.isArray(d.logs) ? d.logs.map((p) => ({ kind: "wood", gx: p.gx, gy: p.gy })) : []);
    G.drops = savedDrops.map((p) => ({ kind: p.kind || "wood", gx: p.gx, gy: p.gy, vx: 0, vy: 0, z: 0, vz: 0, phase: "rest" }));
    G.hasWorld = true;
    G.running = d.running !== false;
    if (d.cam && typeof d.cam.zoom === "number") {
      G.cam.x = d.cam.x; G.cam.y = d.cam.y; G.cam.zoom = d.cam.zoom; G.camRestored = true;
    }
    // Stash saved panel layout; startGame() applies it after the panels exist.
    G.pendingPanels = d.panels || null;
    localStorage.setItem(CURRENT_KEY, G.world.id);
    updateResourceUI();
    updateCraftedHud();
    return true;
  } catch (e) { return false; }
}

// Import a pre-procedural (version <= 10) save's full cell arrays into the sparse
// delta map. Old worlds are small (<= 64x64), so this is a few thousand entries.
function migrateLegacyArrays(d) {
  const rows = d.rows | 0, cols = d.cols | 0;
  const hasT = Array.isArray(d.tiles), hasS = Array.isArray(d.stage),
    hasP = Array.isArray(d.progress), hasC = Array.isArray(d.chop), hasR = Array.isArray(d.rock);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const e = {};
      if (hasT && d.tiles[r]) e.t = d.tiles[r][c];
      if (hasS && d.stage[r]) e.st = d.stage[r][c];
      if (hasP && d.progress[r]) e.pr = d.progress[r][c];
      if (hasC && d.chop[r]) e.ch = d.chop[r][c] | 0;
      if (hasR && d.rock[r]) e.rk = d.rock[r][c];
      modsSetCell(G.world.mods, c, r, e);
    }
  }
}
export function deleteWorld(id) {
  localStorage.removeItem(worldKey(id));
  writeWorldsIndex(readWorldsIndex().filter((w) => w.id !== id));
  if (localStorage.getItem(CURRENT_KEY) === id) localStorage.removeItem(CURRENT_KEY);
}
export function newWorldId() {
  return "w_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
