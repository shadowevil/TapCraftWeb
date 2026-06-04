// TapCraft - shared mutable runtime state.
// In the original single IIFE these were `let`/`const` locals reassigned and
// read throughout. Across ES modules an exported `let` would NOT propagate its
// reassignment to importers, so every piece of MUTABLE runtime state lives on
// this single object `G`. Read `G.x`; write `G.x = ...`. Objects mutated in
// place (world/cam/mouse) live here too for consistency.
"use strict";

export const G = {
  // --- World state ----------------------------------------------------
  world: {
    id: null,
    name: "",
    cols: 0,
    rows: 0,
    seed: 0,
    settings: { landFraction: 0.55, growthRate: 1.0, forestDensity: 0.4, cluster: 0.6, rockDensity: 0.4, rockCluster: 0.6 },
    // Terrain is generated per-cell on demand from the seed (see cells.js); only
    // MODIFIED cells are stored here, so worlds can be arbitrarily large / infinite.
    infinite: false,     // true = unbounded world (no cols/rows edge); false = finite cols x rows
    wrapX: false,        // true = columns wrap (east-west). Globe/torus.
    wrapY: false,        // true = rows wrap (north-south). Globe is a TORUS: wrapX && wrapY (loops every direction)
    hydro: null,         // globe hydrology overlay (rivers/lakes), built at creation (cells.js); null otherwise
    mods: new Map(),     // nested Map<col, Map<row, { t?, st?, pr?, ch?, rk? }>> delta overlay (cells.js)
    wet: new Map(),      // nested Map<col, Map<row, 0..1>> sparse ground-wetness overlay (wetness.js)
    landThreshold: 0,    // elevation cutoff for land/water (sampled at creation)
    spawn: { c: 0, r: 0 }, // initial camera-center land cell
    wood: 0,       // collected wood
    stone: 0,      // collected stone
    iron: 0,       // collected iron ore
    gold: 0,       // collected gold ore
    iron_ingot: 0, // smelted iron ingots
    gold_ingot: 0, // smelted gold ingots
    gold_coin: 0,  // minted gold coins (Coinery; no functional use yet)
    wheat_seeds: 0, // foraged/returned wheat seeds (planted on tilled soil)
    wheat: 0,       // harvested wheat
    tilled: 0,      // live count of tilled tiles (transient; recomputed on load, drives wet-floor refreshes)
    tools: null,   // { hatchet:{count,dura}, pickaxe:{count,dura} } (dura = active instance)
    craft: null,   // { <craftableId>: { remaining, elapsed } } in-progress batches
    buildings: [], // [{ id, type, col, row, facing, produced:{<res>:n} }] placed buildings
    timeOfDay: 0.3, // day/night phase: 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
    day: 1,         // in-game day counter (increments each full day/night loop; new world = 1)
    tick: 0,
  },

  pops: new Map(),        // cellKey -> { col, row, t0, drop, dropped }
  chopResets: new Map(),  // cellKey -> time at which a felled tree reverts
  drops: [],              // resource pickups in flight (transient): { kind, ... }
  resImages: {},          // resource id -> pickup icon Image (wood, stone, ...)
  toolImages: {},         // tool id -> cursor sprite Image (hatchet, pickaxe, ...)
  buildingImages: {},     // building id -> { SE: Image, SW: Image }
  smokeImages: {},        // building id -> [frame Images] (animated effect, e.g. forge smoke)
  lightFrames: {},        // building id -> [frame Images] (lit-state base sprite, e.g. torch flame)
  brokenIcons: {},        // tool id -> broken-tool Image (floats over an idle hut)
  oreImages: {},          // mineable typeId -> [variant Images] (rock/iron_vein/gold_vein)

  cam: { x: 0, y: 0, zoom: 2 },
  camGlide: null,             // in-flight camera tween { x0,y0,x1,y1,t0,ms } (Town Hall travel); null = none
  viewSnow: 0,                // 0..1 how snowy the current view is (smoothed); fades birds/ambience -> wind + rain -> snow near the frozen biome (globe)
  viewDesert: 0,              // 0..1 how desert the current view is (smoothed); thins rainfall in the hot/dry biome (globe)
  camRestored: false,         // true when loadWorld restored a saved camera (skip fit/spawn)
  pendingPanels: null,        // saved craft/build panel layout from loadWorld, applied in startGame
  running: false,
  hasWorld: false,
  inMenu: false,
  resumeRunning: false,       // running-state to restore after the menu modal
  pendingDelete: null,        // world queued for delete confirmation
  parallaxBase: { x: 0, y: 0 },
  mouse: { x: 0, y: 0, on: false },
  hover: null,                // targetable object { col, row, stage } under the cursor
  hoverTile: null,            // ground tile { col, row } under the cursor
  showHatchet: false,         // true while hovering a choppable (mature) tree
  showPickaxe: false,         // true while hovering a rock
  showGrab: false,            // true while hovering/holding a hand-gatherable pickup (logs, small fieldstone)
  showHoe: false,             // true while Shift-hovering tillable ground with a garden hoe owned
  farmCursor: null,           // static farm cursor over the hovered cell: "pour" | "fill" | "seeds" | null
  shiftDown: false,           // live Shift key state (tilling modifier)
  harvesting: false,          // true while the harvest button is held
  harvestKind: null,          // locked resource kind for this hold ("tree"|"rock")
  lastHarvestAt: 0,           // animTime of the last harvest tick
  floorEpoch: 0,              // bumped when tile art/tint changes at runtime (till/revert/wetness); cached floors re-emit on change

  // --- Buildings ------------------------------------------------------
  buildMode: null,            // { type, facing } while placing a new building (else null)
  selectedBuilding: null,     // id of the building whose panel is open (else null)
  hoverBuilding: null,        // id of the building under the cursor (drives the 2x2 ring)
  buildWork: {},              // transient per-building runtime: id -> { workers:[{target,nextAt}], nextSweepAt, rate:[] }

  // --- Developer console (see console.js) -----------------------------
  consoleOpen: false,         // true while the dev console overlay is open
  consoleLog: [],             // [{ text, error }] output lines (oldest first)
  consoleHistory: [],         // entered command strings, for up/down recall
  debugOverlay: false,        // dev: draw a live info overlay for the hovered cell

  // --- Audio (see sound.js; built lazily on first user gesture) --------
  audio: {
    ctx: null,                // AudioContext (null until initAudio)
    resumed: false,           // true once resumed on a user gesture
    masterGain: null,         // master gain node (all channels route through it)
    channels: {},             // channel id -> GainNode (music/ambience/effects/building)
    buffers: {},              // url -> decoded AudioBuffer
    settings: null,           // { <channel>: { vol 0..1, mute bool } } (from localStorage or data)
    ambience: null,           // ambience crossfade controller state
    windTimer: null,          // pending wind-overlay timeout id
    overlays: {},             // active overlay id -> { source, gain }
    lastBuildingSfxAt: 0,     // perf-clock ms of the last building-caused SFX (global rate cap)
    worldPaused: false,       // game paused -> world/ambient channels ducked to silent (music stays)
  },

  images: {},
  waterImages: {}, // key -> array of WATER_FRAMES Images
  stageImages: [],
  treeImages: [],
  wheatImages: [],    // wheat crop stage sprites (farming; index = wheat stage, last = mature)
  farmImages: {},     // farming cursor icons: { pour } (fill/seeds reuse toolImages/resImages)
  grabFrames: [],     // animated grab-hand cursor frames (hand-gatherable pickups)
  grassVariants: [],  // grass tile sprite variants (index 0 = base grass.png), picked per-cell by biome
  decorImages: [],    // cosmetic ground-cover sprites (flowers/grass patches), drawn as objects

  // A radial black->transparent disc, baked once and reused as the soft
  // grounding pool under every object (cheaper than a per-frame gradient).
  poolSprite: null,

  // --- Loop (20 TPS sim, <=60 FPS render) -----------------------------
  lastTime: 0,
  acc: 0,
  lastRender: 0,
  animTime: 0,

  // --- Camera input ---------------------------------------------------
  panning: false,
  panStart: null,

  // --- Crafting panel & crafted HUD -----------------------------------
  craftEntries: {}, // id -> { slider, costWood, costStone, button }
  queueItems: {},   // id -> { el, count, fill }  (live queue rows)
  craftQueueEl: null,
  craftQueueHead: null,
};
