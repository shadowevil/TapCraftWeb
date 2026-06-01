// TapCraft - world creation + transients reset.
//
// Terrain is no longer materialized into arrays here. A world is just a seed +
// settings; cells.js generates terrain per cell on demand and overlays a sparse
// map of modified cells (G.world.mods). `generate` resets that state and builds
// the procedural generator (noise closures + sampled land threshold + spawn).
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { initWorldGen } from "./cells.js";
import { updateResourceUI } from "./ui.js";
import { updateCraftedHud } from "./crafting.js";

// --- Generation -------------------------------------------------------
export function generate(cols, rows, seed, settings) {
  G.world.infinite = !!(settings && settings.infinite);
  G.world.cols = G.world.infinite ? 0 : cols; // 0 = unbounded sentinel
  G.world.rows = G.world.infinite ? 0 : rows;
  G.world.seed = seed >>> 0;
  G.world.settings = { ...settings };
  G.world.tick = 0;
  G.world.mods = new Map();
  G.world.wood = 0;
  G.world.stone = 0;
  G.world.iron = 0;
  G.world.gold = 0;
  G.world.iron_ingot = 0;
  G.world.gold_ingot = 0;
  G.world.tools = newTools();
  G.world.craft = {};
  G.world.day = 1; // new world starts on day 1
  G.world.buildings = [];
  resetTransients();
  initWorldGen(G.world.seed, G.world.settings); // noise closures + land threshold + spawn
  G.hasWorld = true;
  updateResourceUI();
  updateCraftedHud();
}

export function newTools() {
  const t = {};
  for (const k of Object.keys(GD.tools)) t[k] = { count: 0, dura: 0 };
  return t;
}

export function resetTransients() {
  G.pops.clear();
  G.chopResets.clear();
  G.drops = [];
  G.buildWork = {};       // per-building worker/sweep/rate runtime, rebuilt lazily
  G.selectedBuilding = null;
  G.hoverBuilding = null;
  G.buildMode = null;
}
