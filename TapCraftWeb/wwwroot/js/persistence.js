// TapCraft - persistence (multiple worlds in localStorage) + save sanitizers.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { WORLDS_KEY, CURRENT_KEY, worldKey } from "./config.js";
import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { makeLayer } from "./rng.js";
import { newTools, resetTransients } from "./worldgen.js";
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

// --- Persistence (multiple worlds) -----------------------------------
export function readWorldsIndex() {
  try { const a = JSON.parse(localStorage.getItem(WORLDS_KEY)); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
export function writeWorldsIndex(list) {
  try { localStorage.setItem(WORLDS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
export function saveWorld() {
  if (!G.hasWorld || !G.world.id) return; // menu background has no id -> not saved
  try {
    localStorage.setItem(worldKey(G.world.id), JSON.stringify({
      version: 10, id: G.world.id, name: G.world.name,
      cols: G.world.cols, rows: G.world.rows, seed: G.world.seed,
      settings: G.world.settings, tiles: G.world.tiles,
      stage: G.world.stage, progress: G.world.progress,
      chop: G.world.chop, rock: G.world.rock,
      wood: G.world.wood, stone: G.world.stone, iron: G.world.iron, gold: G.world.gold,
      iron_ingot: G.world.iron_ingot, gold_ingot: G.world.gold_ingot,
      tools: G.world.tools, craft: G.world.craft,
      buildings: G.world.buildings.map((b) => ({ id: b.id, type: b.type, col: b.col, row: b.row, facing: b.facing,
        produced: b.produced, stored: b.stored, tools: b.tools, oreStored: b.oreStored, ingots: b.ingots, fuel: b.fuel })),
      drops: G.drops.filter((d) => d.phase === "rest").map((d) => ({ kind: d.kind, gx: d.gx, gy: d.gy })),
      tick: G.world.tick, running: G.running,
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
  const json = localStorage.getItem(worldKey(id));
  if (!json) return false;
  try {
    const d = JSON.parse(json);
    if (!d || !Array.isArray(d.tiles)) return false;
    G.world.id = d.id || id;
    G.world.name = d.name || "World";
    G.world.cols = d.cols; G.world.rows = d.rows; G.world.seed = d.seed >>> 0;
    G.world.settings = Object.assign({}, GD.defaults.worldSettings, d.settings);
    G.world.tiles = d.tiles; G.world.stage = d.stage; G.world.progress = d.progress;
    G.world.chop = Array.isArray(d.chop) ? d.chop : makeLayer(d.cols, d.rows, 0);
    G.world.rock = Array.isArray(d.rock) ? d.rock : makeLayer(d.cols, d.rows, -1);
    G.world.wood = d.wood | 0;
    G.world.stone = d.stone | 0;
    G.world.iron = d.iron | 0;
    G.world.gold = d.gold | 0;
    G.world.iron_ingot = d.iron_ingot | 0;
    G.world.gold_ingot = d.gold_ingot | 0;
    G.world.tools = sanitizeTools(d.tools);
    G.world.craft = sanitizeCraft(d.craft);
    G.world.buildings = sanitizeBuildings(d.buildings);
    G.world.tick = d.tick || 0;
    resetTransients(); // also clears building worker/selection transients
    const savedDrops = Array.isArray(d.drops) ? d.drops : (Array.isArray(d.logs) ? d.logs.map((p) => ({ kind: "wood", gx: p.gx, gy: p.gy })) : []);
    G.drops = savedDrops.map((p) => ({ kind: p.kind || "wood", gx: p.gx, gy: p.gy, vx: 0, vy: 0, z: 0, vz: 0, phase: "rest" }));
    G.hasWorld = true;
    G.running = d.running !== false;
    localStorage.setItem(CURRENT_KEY, G.world.id);
    updateResourceUI();
    updateCraftedHud();
    return true;
  } catch (e) { return false; }
}
export function deleteWorld(id) {
  localStorage.removeItem(worldKey(id));
  writeWorldsIndex(readWorldsIndex().filter((w) => w.id !== id));
  if (localStorage.getItem(CURRENT_KEY) === id) localStorage.removeItem(CURRENT_KEY);
}
export function newWorldId() {
  return "w_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
