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
    tiles: [],
    stage: [],     // [r][c] -1 none, 0..MATURE  (trees)
    progress: [],  // [r][c] growth toward next stage
    chop: [],      // [r][c] clicks landed on a mature tree
    rock: [],      // [r][c] -1 none, else rock variant index (stone, infinite)
    wood: 0,       // collected wood
    stone: 0,      // collected stone
    tools: null,   // { hatchet:{count,dura}, pickaxe:{count,dura} } (dura = active instance)
    craft: null,   // { <craftableId>: { remaining, elapsed } } in-progress batches
    buildings: [], // [{ id, type, col, row, facing, produced:{<res>:n} }] placed buildings
    tick: 0,
  },

  pops: new Map(),        // cellKey -> { col, row, t0, drop, dropped }
  chopResets: new Map(),  // cellKey -> time at which a felled tree reverts
  drops: [],              // resource pickups in flight (transient): { kind, ... }
  resImages: {},          // resource id -> pickup icon Image (wood, stone, ...)
  toolImages: {},         // tool id -> cursor sprite Image (hatchet, pickaxe, ...)
  buildingImages: {},     // building id -> { SE: Image, SW: Image }
  rockImages: [],         // map rock sprites (variants)

  cam: { x: 0, y: 0, zoom: 2 },
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
  harvesting: false,          // true while the harvest button is held
  harvestKind: null,          // locked resource kind for this hold ("tree"|"rock")
  lastHarvestAt: 0,           // animTime of the last harvest tick

  // --- Buildings ------------------------------------------------------
  buildMode: null,            // { type, facing } while placing a new building (else null)
  selectedBuilding: null,     // id of the building whose panel is open (else null)
  hoverBuilding: null,        // id of the building under the cursor (drives the 2x2 ring)
  buildWork: {},              // transient per-building runtime: id -> { workers:[{target,nextAt}], nextSweepAt, rate:[] }

  // --- Developer console (see console.js) -----------------------------
  consoleOpen: false,         // true while the dev console overlay is open
  consoleLog: [],             // [{ text, error }] output lines (oldest first)
  consoleHistory: [],         // entered command strings, for up/down recall

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
  },

  images: {},
  waterImages: {}, // key -> array of WATER_FRAMES Images
  stageImages: [],
  treeImages: [],

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
