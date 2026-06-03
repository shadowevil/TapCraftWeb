// TapCraft - world creation + transients reset.
//
// Terrain is no longer materialized into arrays here. A world is just a seed +
// settings; cells.js generates terrain per cell on demand and overlays a sparse
// map of modified cells (G.world.mods). `generate` resets that state and builds
// the procedural generator (noise closures + sampled land threshold + spawn).
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { initWorldGen, createMods } from "./cells.js";
import { updateResourceUI } from "./ui.js";
import { updateCraftedHud } from "./crafting.js";

// --- Generation -------------------------------------------------------
export function generate(cols, rows, seed, settings) {
  const st = settings || {};
  // World TYPE: "globe" (cylindrical - wraps east-west, real poles), "infinite"
  // (endless per-cell), or "flat" (finite, non-wrapping island/map). Old saves
  // predate worldType, so derive it from the legacy `infinite` flag to keep their
  // exact shape. The globe is the default for brand-new worlds (set by createWorld).
  const worldType = st.worldType || (st.infinite ? "infinite" : "flat");
  G.world.infinite = (worldType === "infinite");
  // Globe is a TORUS: both axes wrap, so it loops in every direction (no edges, no poles).
  G.world.wrapX = (worldType === "globe");
  G.world.wrapY = (worldType === "globe");
  if (worldType === "globe") {
    // Globe size is a CIRCUMFERENCE (tiles around the world); height = half the
    // width (equirectangular 2:1). It sets how many continents fit + the loop
    // distance, and is the single number the size slider drives.
    const sc = (GD.sliders && GD.sliders.circumference) || { min: 1000, max: 100000, default: 2000 };
    let w = st.circumference | 0; if (!w) w = sc.default;
    w = Math.max(sc.min, Math.min(sc.max, w));
    G.world.cols = w;
    G.world.rows = Math.max(2, Math.round(w / 2));
  } else {
    G.world.cols = G.world.infinite ? 0 : cols; // 0 = unbounded sentinel
    G.world.rows = G.world.infinite ? 0 : rows;
  }
  G.world.seed = seed >>> 0;
  G.world.settings = { ...settings };
  G.world.tick = 0;
  G.world.mods = createMods();
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
