// TapCraft - game runtime (home page).
// Self-contained for now; the isometric math, terrain generation and water
// autotiling mirror the map editor and can be unified into a shared core later.
(() => {
  "use strict";

  // --- Constants --------------------------------------------------------
  const SPRITE = 32;     // base tile sprite is 32x32
  const HALF_W = 16;     // surface diamond half-width
  const HALF_H = 8;      // surface diamond half-height
  const OBJECT_LIFT = 8; // upward nudge for tall sprites, in sprite px (scaled by zoom)

  const TPS = 20;                  // simulation ticks per second
  const TICK_MS = 1000 / TPS;
  const MAX_FPS = 60;
  const FRAME_MS = 1000 / MAX_FPS;

  // Growth: each tick a growing plant has a 50/50 chance to gain a random
  // GAIN_MIN..GAIN_MAX (scaled by growthRate); at STAGE_FULL it advances a
  // stage and the progress resets. STAGE_FULL=1000 with avg 3/heads => ~667
  // ticks/stage, so sapling(1)->tree(4) ~= 2000 ticks = 100s @ 20 TPS, 1.0x.
  const STAGE_FULL = 1000;
  const GAIN_MIN = 1;
  const GAIN_MAX = 5;
  const MATURE = 4; // fully grown tree (sprout 0 -> sapling 1 -> ... -> tree 4)

  // Weighted starting growth stages for a freshly seeded forest (index =
  // stage 0..MATURE). Biased young, but some begin partly or fully grown.
  const INITIAL_STAGE_WEIGHTS = [0.35, 0.25, 0.18, 0.12, 0.10];

  const WORLDS_KEY = "tapcraft.worlds";    // index: [{id, name, size, updatedAt}]
  const CURRENT_KEY = "tapcraft.current";  // last-opened world id
  const worldKey = (id) => "tapcraft.world." + id;
  const AUTOSAVE_MS = 5000;

  const MENU_SIZE = 32;   // background island size on the main menu
  const PARALLAX = 46;    // max menu parallax shift (px)

  // Harvest / resources
  const CHOP_CLICKS = 5;  // clicks to fell a mature tree (then it reverts to a sprout)
  const POP_MS = 280;     // tree click "pop" duration
  const POP_AMOUNT = 0.22; // peak extra scale on the pop
  const DROP_GRAVITY = 520; // px/s^2 for a bouncing resource drop
  const DROP_BOUNCE = 0.45; // velocity retained per bounce
  const DROP_REST_VZ = 26;  // below this upward speed on landing, the drop settles
  const DROP_SCALE = 0.7;   // ground drop render scale (relative to icon, x zoom)
  const FLY_MS = 420;       // drop fly-to-bar duration

  // Cast shadow: a black silhouette of each object, anchored at its base and
  // sheared + flattened so it lies down on the ground (down-left) like a real
  // shadow, rather than a floating offset copy.
  const SHADOW_ALPHA = 0.32;
  const SHADOW_SKEW = 0.7;     // horizontal lean per unit of sprite height (up-left)
  const SHADOW_SQUASH = 0.6;   // vertical rise of the cast (bigger = steeper toward top-left)
  const SHADOW_POOL_ALPHA = 0.3; // grounding pool darkness under the object foot
  const SHADOW_POOL_RATIO = 0.4; // pool ellipse height / width (lower = flatter)
  const WOOD_ICON_SRC = "/assets/icons/icon_small_wood.png";
  const STONE_ICON_SRC = "/assets/icons/icon_stone.png";   // tile_065 boulder (pickup + bar)
  const ROCK_SRC = ["/assets/objects/rock_1.png", "/assets/objects/rock_2.png"]; // map cluster variants

  // Stone clusters: clumpy noise field on grass, scattered within each clump.
  // The per-world `rockDensity`/`rockCluster` settings (0..1) drive these:
  //   density -> how much of the clumped area fills with rock (ROCK_FILL) and
  //              how large the clumped area is (lower threshold = more area);
  //   cluster -> clump size, by scaling the noise frequency (tight vs spread).
  const ROCK_FILL_MAX = 0.85;      // per-cell rock chance at a cluster core (density 1)
  const ROCK_SCALE_TIGHT = 0.16;   // clump-noise frequency at cluster 0 (many small clumps)
  const ROCK_SCALE_SPREAD = 0.05;  // clump-noise frequency at cluster 1 (few big clumps)
  const TOPBAR_H = 42;    // main top bar height (px)
  const SUBBAR_H = 32;    // secondary bar height (px); canvas fills below both

  // Tool cursors: shown over a harvestable object with the OS cursor hidden.
  // Each pivots at its handle grip (pinned to the mouse) and oscillates.
  const TOOL_SCALE = 1.5;        // render scale (sprites are 32x29)
  const TOOL_SWING_DEG = 60;     // oscillation arc
  const TOOL_SWING_MS = 520;     // full back-and-forth period
  const HATCHET_SRC = "/assets/icons/cursor_hatchet.png";  // trees
  const HATCHET_PIVOT_X = 27, HATCHET_PIVOT_Y = 28;        // bottom-right grip
  const PICKAXE_SRC = "/assets/icons/cursor_pickaxe.png";  // rocks
  const PICKAXE_PIVOT_X = 27, PICKAXE_PIVOT_Y = 28;        // bottom-right grip (handle end)

  // Hold-to-harvest: while the button is held, harvest the locked resource kind
  // under the cursor every HARVEST_INTERVAL_MS (the average click cadence).
  const HARVEST_INTERVAL_MS = 200;

  // Harvest yield: chance a swing drops resources, and how many. The matching
  // tool (hatchet for trees, pickaxe for rocks) raises the odds and doubles
  // output, and loses 1 durability per swing.
  const BASE_DROP_CHANCE = 0.25;
  const TOOL_DROP_CHANCE = 0.50;
  const BASE_OUTPUT = 1;
  const TOOL_OUTPUT = 2;
  const KIND_TOOL = { tree: "hatchet", rock: "pickaxe" };

  // Tools (crafted). Each instance has TOOL_DURABILITY swings before it breaks.
  const TOOL_DURABILITY = 50;
  const TOOLS = {
    hatchet: { name: "Stone Hatchet", icon: "/assets/icons/cursor_hatchet.png" },
    pickaxe: { name: "Stone Pickaxe", icon: "/assets/icons/cursor_pickaxe.png" },
  };

  // Crafting recipes. cost is per unit; CRAFT_MS is per unit (sequential batch).
  const CRAFT_MS = 3000;
  const CRAFT_MAX = 25;
  const CRAFTABLES = {
    stone_hatchet: { name: "Stone Hatchet", icon: "/assets/icons/cursor_hatchet.png", tool: "hatchet", cost: { wood: 10, stone: 5 } },
    stone_pickaxe: { name: "Stone Pickaxe", icon: "/assets/icons/cursor_pickaxe.png", tool: "pickaxe", cost: { wood: 10, stone: 3 } },
  };

  const TILE_SRC = {
    grass: "/assets/tiles/grass.png",
    dirt: "/assets/tiles/dirt.png",
    sand: "/assets/tiles/sand.png",
  };
  // Animated water: each variant has WATER_FRAMES frames (water_<key>_<n>.png),
  // cycled in sync. "center" = open water; the rest are the autotiled edges.
  const WATER_FRAMES = 10;
  const WATER_FRAME_MS = 120; // ~8 fps cycle
  const WATER_BASES = {
    center: "water",
    ne: "water_ne", se: "water_se", sw: "water_sw", nw: "water_nw",
    n: "water_n", e: "water_e", s: "water_s", w: "water_w", o: "water_o",
  };
  const STAGE_SRC = [
    "/assets/tiles/sprout.png",       // 0 sprout (flat 32x32)
    "/assets/objects/sapling.png",    // 1
    "/assets/objects/youngling.png",  // 2
    "/assets/objects/adolescent.png", // 3
  ];
  const TREE_SRC = ["/assets/objects/tree_1.png", "/assets/objects/tree_2.png"]; // stage 4

  // Object types and their flags. New object types default to targetable:false;
  // trees (all growth stages) and rocks are targetable/harvestable.
  const OBJECT_TYPES = {
    tree: { targetable: true },
    rock: { targetable: true },
  };

  // --- DOM --------------------------------------------------------------
  const canvas = document.getElementById("tc-canvas");
  const ctx = canvas.getContext("2d");
  const fxCanvas = document.getElementById("tc-fx");
  const fxctx = fxCanvas.getContext("2d");
  const el = (id) => document.getElementById(id);
  const woodIconEl = document.getElementById("tc-wood-icon");
  const woodCountEl = document.getElementById("tc-wood-count");
  const woodResourceEl = woodIconEl.parentElement;
  const stoneIconEl = document.getElementById("tc-stone-icon");
  const stoneCountEl = document.getElementById("tc-stone-count");
  const stoneResourceEl = stoneIconEl.parentElement;

  const menuBtn = el("tc-menu-btn");
  const craftBtn = el("tc-craft-btn");
  const craftedHud = el("tc-crafted");
  const craftPanel = el("tc-craft-panel");
  const craftTitlebar = el("tc-craft-titlebar");
  const craftCloseBtn = el("tc-craft-close");
  const craftListEl = el("tc-craft-list");
  const playBtn = el("tc-play");
  const pauseBtn = el("tc-pause");
  const menuModal = el("tc-menu");
  const mainMenuScreen = el("tc-mainmenu-screen");
  const worldListEl = el("tc-world-list");
  const newWorldModal = el("tc-newworld");
  const confirmModal = el("tc-confirm");
  const nameInput = el("tc-name");

  const ui = {
    size: el("tc-size"), sizeVal: el("tc-size-val"),
    land: el("tc-land"), landVal: el("tc-land-val"),
    growth: el("tc-growth"), growthVal: el("tc-growth-val"),
    density: el("tc-density"), densityVal: el("tc-density-val"),
    cluster: el("tc-cluster"), clusterVal: el("tc-cluster-val"),
    rockDensity: el("tc-rock-density"), rockDensityVal: el("tc-rock-density-val"),
    rockCluster: el("tc-rock-cluster"), rockClusterVal: el("tc-rock-cluster-val"),
    seed: el("tc-seed"),
  };

  // --- World state ------------------------------------------------------
  const world = {
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
    tick: 0,
  };

  const pops = new Map();        // cellKey -> { col, row, t0, drop, dropped }
  const chopResets = new Map();  // cellKey -> time at which a felled tree reverts
  let drops = [];                // resource pickups in flight (transient): { kind, ... }
  const woodImg = new Image();
  const stoneImg = new Image();
  const rockImages = [];         // map rock sprites (variants)
  const hatchetImg = new Image();
  const pickaxeImg = new Image();

  const cam = { x: 0, y: 0, zoom: 2 };
  let running = false;
  let hasWorld = false;
  let inMenu = false;
  let resumeRunning = false;       // running-state to restore after the menu modal
  let pendingDelete = null;        // world queued for delete confirmation
  let parallaxBase = { x: 0, y: 0 };
  const mouse = { x: 0, y: 0, on: false };
  let hover = null;                // targetable object { col, row, stage } under the cursor
  let hoverTile = null;            // ground tile { col, row } under the cursor
  let showHatchet = false;         // true while hovering a choppable (mature) tree
  let showPickaxe = false;         // true while hovering a rock
  let harvesting = false;          // true while the harvest button is held
  let harvestKind = null;          // locked resource kind for this hold ("tree"|"rock")
  let lastHarvestAt = 0;           // animTime of the last harvest tick

  const images = {};
  const waterImages = {}; // key -> array of WATER_FRAMES Images
  const stageImages = [];
  const treeImages = [];

  // --- Deterministic hash + noise --------------------------------------
  function hash01(x, y, seed) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 362437);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  // 50/50 coin, and on heads a random GAIN_MIN..GAIN_MAX. 0 on tails.
  function growthStep(c, r, tick, seed) {
    const ts = (seed ^ Math.imul(tick, 0x9e3779b1)) >>> 0;
    if (hash01(c, r, ts) >= 0.5) return 0;
    const u = hash01(c, r, (ts ^ 0x68e31da4) >>> 0);
    return GAIN_MIN + u * (GAIN_MAX - GAIN_MIN);
  }
  function makeFbm(seed, octaves = 5) {
    const smooth = (t) => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    const value = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = smooth(xf), v = smooth(yf);
      return lerp(
        lerp(hash01(xi, yi, seed), hash01(xi + 1, yi, seed), u),
        lerp(hash01(xi, yi + 1, seed), hash01(xi + 1, yi + 1, seed), u),
        v
      );
    };
    return (x, y) => {
      let amp = 0.5, freq = 1, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * value(x * freq, y * freq);
        norm += amp;
        amp *= 0.5; freq *= 2;
      }
      return sum / norm;
    };
  }

  // --- Map helpers ------------------------------------------------------
  function makeLayer(cols, rows, fill) {
    const m = new Array(rows);
    for (let r = 0; r < rows; r++) m[r] = new Array(cols).fill(fill);
    return m;
  }
  function inBounds(col, row) {
    return col >= 0 && row >= 0 && col < world.cols && row < world.rows;
  }

  // --- Generation -------------------------------------------------------
  function generate(cols, rows, seed, settings) {
    world.cols = cols;
    world.rows = rows;
    world.seed = seed >>> 0;
    world.settings = { ...settings };
    world.tick = 0;
    world.tiles = makeLayer(cols, rows, "water");
    world.stage = makeLayer(cols, rows, -1);
    world.progress = makeLayer(cols, rows, 0);
    world.chop = makeLayer(cols, rows, 0);
    world.rock = makeLayer(cols, rows, -1);
    world.wood = 0;
    world.stone = 0;
    world.tools = newTools();
    world.craft = {};
    resetTransients();
    generateTerrain();
    seedRocks();   // rocks first so the forest can avoid them
    seedForest();
    hasWorld = true;
    updateResourceUI();
    updateCraftedHud();
  }

  function newTools() {
    return { hatchet: { count: 0, dura: 0 }, pickaxe: { count: 0, dura: 0 } };
  }
  // Restore saved tools/craft defensively (older saves won't have them).
  function sanitizeTools(saved) {
    const t = newTools();
    if (saved) {
      for (const k of Object.keys(t)) {
        const s = saved[k];
        if (s) { t[k].count = s.count | 0; t[k].dura = s.dura | 0; }
      }
    }
    return t;
  }
  function sanitizeCraft(saved) {
    const out = {};
    if (saved) {
      for (const id of Object.keys(CRAFTABLES)) {
        const s = saved[id];
        if (s && (s.remaining | 0) > 0) out[id] = { remaining: s.remaining | 0, elapsed: +s.elapsed || 0, charged: !!s.charged };
      }
    }
    return out;
  }

  function resetTransients() {
    pops.clear();
    chopResets.clear();
    drops = [];
  }
  function updateResourceUI() {
    woodCountEl.textContent = world.wood | 0;
    stoneCountEl.textContent = world.stone | 0;
  }

  function generateTerrain() {
    const cols = world.cols, rows = world.rows, s = world.seed;
    const base = makeFbm(s, 6);
    const warpXn = makeFbm((s ^ 0x9e3779b9) >>> 0, 4);
    const warpYn = makeFbm((s ^ 0x85ebca6b) >>> 0, 4);
    const baseScale = 0.045, warpScale = 0.08, warpAmt = 22;
    const contrast = 1.5, falloffExp = 2.4, falloffMul = 1.0;
    const v = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = c + (warpXn(c * warpScale, r * warpScale) * 2 - 1) * warpAmt;
        const wy = r + (warpYn(c * warpScale, r * warpScale) * 2 - 1) * warpAmt;
        let e = base(wx * baseScale, wy * baseScale);
        e = (e - 0.5) * contrast + 0.5;
        const nx = (wx / (cols - 1) - 0.5) * 2;
        const ny = (wy / (rows - 1) - 0.5) * 2;
        const d = Math.min(1, Math.hypot(nx, ny));
        v[r * cols + c] = e - Math.pow(d, falloffExp) * falloffMul;
      }
    }
    const sorted = Float64Array.from(v).sort();
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - world.settings.landFraction) * sorted.length)));
    const threshold = sorted[idx];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        world.tiles[r][c] = v[r * cols + c] >= threshold ? "grass" : "water";
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r < 2 || c < 2 || r >= rows - 2 || c >= cols - 2) world.tiles[r][c] = "water";
      }
    }
    // Beaches: sand near the coast, fading inland.
    const SAND_CHANCE = [0, 0.75, 0.25];
    const maxCoast = SAND_CHANCE.length - 1;
    const dist = new Int32Array(cols * rows).fill(-1);
    const queue = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (world.tiles[r][c] === "water") { const i = r * cols + c; dist[i] = 0; queue.push(i); }
      }
    }
    const N4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi];
      if (dist[i] >= maxCoast) continue;
      const cc = i % cols, rr = (i - cc) / cols;
      for (const [dc, dr] of N4) {
        const nc = cc + dc, nr = rr + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (dist[ni] !== -1) continue;
        dist[ni] = dist[i] + 1; queue.push(ni);
      }
    }
    const sandSeed = (s ^ 0x27d4eb2f) >>> 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (world.tiles[r][c] !== "grass") continue;
        const d = dist[r * cols + c];
        const p = d >= 1 && d <= maxCoast ? SAND_CHANCE[d] : 0;
        if (p > 0 && hash01(c, r, sandSeed) < p) world.tiles[r][c] = "sand";
      }
    }
  }

  // True only when the 8 surrounding tiles are all grass (deep interior).
  function grassSurrounded(col, row) {
    if (world.tiles[row][col] !== "grass") return false;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nc = col + dc, nr = row + dr;
        if (!inBounds(nc, nr) || world.tiles[nr][nc] !== "grass") return false;
      }
    }
    return true;
  }

  // Weighted random starting stage for a newly seeded tree.
  function pickInitialStage(c, r, s) {
    const u = hash01(c, r, (s ^ 0x3c6ef35f) >>> 0);
    let acc = 0;
    for (let st = 0; st < INITIAL_STAGE_WEIGHTS.length; st++) {
      acc += INITIAL_STAGE_WEIGHTS[st];
      if (u < acc) return st;
    }
    return MATURE;
  }

  // Seed stone clusters on grass: a low-frequency clump field decides where
  // clusters are, then a per-cell roll (densest at a clump's core) scatters
  // individual rocks. Two sprite variants for variety. Grass-only.
  function seedRocks() {
    const cols = world.cols, rows = world.rows, s = world.seed;
    const density = world.settings.rockDensity;
    const cluster = world.settings.rockCluster;
    if (density <= 0) return;
    const clump = makeFbm((s ^ 0x51ed2701) >>> 0, 3);
    const rSeed = (s ^ 0x1f83d9ab) >>> 0;
    const vSeed = (s ^ 0x7f4a7c15) >>> 0;
    // Higher cluster -> lower frequency -> bigger, fewer clumps.
    const scale = ROCK_SCALE_TIGHT + (ROCK_SCALE_SPREAD - ROCK_SCALE_TIGHT) * cluster;
    // Higher density -> lower threshold (more clumped area) + higher core fill.
    const threshold = 0.72 - 0.42 * density;
    const fill = ROCK_FILL_MAX * density;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (world.tiles[r][c] !== "grass") continue;
        const field = clump(c * scale, r * scale);
        if (field <= threshold) continue;
        const local = (field - threshold) / (1 - threshold);
        if (hash01(c, r, rSeed) < fill * local) {
          world.rock[r][c] = hash01(c, r, vSeed) < 0.5 ? 0 : 1;
        }
      }
    }
  }

  // Seed forests on eligible grass; trees start at varied stages/progress.
  function seedForest() {
    const cols = world.cols, rows = world.rows, s = world.seed;
    const density = world.settings.forestDensity;
    const cluster = world.settings.cluster;
    if (density <= 0) return;
    const fNoise = makeFbm((s ^ 0x1b56c4e9) >>> 0, 4);
    const fSeed = (s ^ 0x632be59b) >>> 0;
    const fScale = 0.14;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (world.rock[r][c] >= 0) continue; // no tree where a rock sits
        if (!grassSurrounded(c, r)) continue;
        const rnd = hash01(c, r, fSeed);
        const noise = fNoise(c * fScale, r * fScale);
        const score = rnd * (1 - cluster) + noise * cluster;
        if (score > 1 - density) {
          const st = pickInitialStage(c, r, s);
          world.stage[r][c] = st;
          world.progress[r][c] = st >= MATURE ? 0 : hash01(c, r, (s ^ 0x2545f491) >>> 0) * STAGE_FULL;
        }
      }
    }
  }

  // --- Simulation -------------------------------------------------------
  function tick() {
    world.tick++;
    const g = world.settings.growthRate;
    const seed = world.seed;
    const t = world.tick;
    const rows = world.rows, cols = world.cols;
    for (let r = 0; r < rows; r++) {
      const stRow = world.stage[r];
      const pRow = world.progress[r];
      for (let c = 0; c < cols; c++) {
        const st = stRow[c];
        if (st < 0 || st >= MATURE) continue;
        const gain = growthStep(c, r, t, seed);
        if (gain <= 0) continue;
        pRow[c] += gain * g;
        if (pRow[c] >= STAGE_FULL) { stRow[c] = st + 1; pRow[c] = 0; }
      }
    }
  }

  // --- Coordinate transforms / culling ---------------------------------
  function cellCenter(col, row) {
    return { x: (col - row) * HALF_W, y: (col + row) * HALF_H };
  }
  function worldToScreen(wx, wy) {
    return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
  }
  function worldToCell(wx, wy) {
    return {
      col: Math.round(wx / (HALF_W * 2) + wy / (HALF_H * 2)),
      row: Math.round(wy / (HALF_H * 2) - wx / (HALF_W * 2)),
    };
  }
  function visibleCellBounds() {
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
      c1: Math.min(world.cols - 1, Math.ceil(maxC) + M),
      r0: Math.max(0, Math.floor(minR) - M),
      r1: Math.min(world.rows - 1, Math.ceil(maxR) + M),
    };
  }

  // --- Water autotiling -------------------------------------------------
  function isLand(col, row) {
    if (!inBounds(col, row)) return false;
    return world.tiles[row][col] !== "water";
  }
  // Indexed by the 4-bit land mask (ne=1, se=2, sw=4, nw=8): single edges, the
  // four two-edge corners, and "o" for any other multi-land combo. null = open.
  const WATER_EDGE_BY_MASK = [
    null, "ne", "se", "e", "sw", "o", "s", "o",
    "nw", "n", "o", "o", "w", "o", "o", "o",
  ];
  function waterEdge(col, row) {
    const mask = (isLand(col, row - 1) ? 1 : 0) | (isLand(col + 1, row) ? 2 : 0) |
                 (isLand(col, row + 1) ? 4 : 0) | (isLand(col - 1, row) ? 8 : 0);
    return WATER_EDGE_BY_MASK[mask];
  }
  function waterFrameIndex() {
    return Math.floor(animTime / WATER_FRAME_MS) % WATER_FRAMES;
  }
  // `frame` is computed once per render() and passed in (it's identical for
  // every water cell in a frame), so the floor/mod isn't repeated per cell.
  function tileSprite(id, col, row, frame) {
    if (id === "water") {
      const key = waterEdge(col, row) || "center";
      const frames = waterImages[key];
      return frames ? frames[frame] : null;
    }
    return images[id] || null;
  }
  function plantSprite(stage, col, row) {
    if (stage < 0) return null;
    if (stage >= MATURE) {
      const variant = hash01(col, row, (world.seed ^ 0x5bd1e995) >>> 0) < 0.5 ? 0 : 1;
      return treeImages[variant];
    }
    return stageImages[stage];
  }

  // Sprite + placement for a plant cell (shared by render and hit-testing so
  // they always agree on size/lift/flip).
  function plantDrawParams(stage, c, r) {
    const img = plantSprite(stage, c, r);
    if (!img) return null;
    if (stage === 0) return { img, lift: 0, sc: 1, flip: false };
    const flip = hash01(c, r, (world.seed ^ 0x000000a1) >>> 0) < 0.5;
    const sc = 0.9 + hash01(c, r, (world.seed ^ 0x000000b2) >>> 0) * 0.2;
    return { img, lift: OBJECT_LIFT, sc, flip };
  }

  // The object occupying a cell (rock takes precedence; a cell never has both),
  // with the draw params render and hit-testing share. null if the cell is bare.
  function cellObject(c, r) {
    const rk = world.rock[r][c];
    if (rk >= 0) {
      const img = rockImages[rk];
      if (!img) return null;
      return { kind: "rock", img, lift: 0, sc: 1, flip: false, variant: rk };
    }
    const st = world.stage[r][c];
    if (st >= 0) {
      const dp = plantDrawParams(st, c, r);
      if (!dp) return null;
      return { kind: "tree", img: dp.img, lift: dp.lift, sc: dp.sc, flip: dp.flip, stage: st };
    }
    return null;
  }

  // Pixel-perfect hit test: the front-most targetable object whose opaque
  // pixels are under the screen point (px, py), or null. Tests the un-popped
  // sprite so the hitbox stays stable during the click "pop".
  function objectAt(px, py) {
    if (!hasWorld) return null;
    const z = cam.zoom;
    const b = visibleCellBounds();
    for (let r = b.r1; r >= b.r0; r--) {      // front-to-back (reverse paint order)
      for (let c = b.c1; c >= b.c0; c--) {
        const obj = cellObject(c, r);
        if (!obj || !obj.img.complete) continue;
        const t = OBJECT_TYPES[obj.kind];
        if (!t || !t.targetable) continue;
        const img = obj.img;
        const w = img.naturalWidth || SPRITE, h = img.naturalHeight || SPRITE;
        const center = cellCenter(c, r);
        const s = worldToScreen(center.x, center.y);
        const dw = w * z * obj.sc, dh = h * z * obj.sc;
        const tx = s.x - dw / 2;
        const ty = s.y - obj.lift * z + (SPRITE / 2) * z - dh; // lift scales with zoom
        if (px < tx || px >= tx + dw || py < ty || py >= ty + dh) continue;
        let sx = (px - tx) / (z * obj.sc);
        const sy = (py - ty) / (z * obj.sc);
        if (obj.flip) sx = w - sx;
        const ix = Math.floor(sx), iy = Math.floor(sy);
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
        const mask = img._mask;
        if (!mask || mask.a[iy * w + ix] > 16) {
          return { col: c, row: r, kind: obj.kind, stage: obj.stage, variant: obj.variant };
        }
      }
    }
    return null;
  }

  // Alpha masks for targetable sprites, for pixel-perfect hit testing.
  function buildMask(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const oc = document.createElement("canvas");
    oc.width = w; oc.height = h;
    const octx = oc.getContext("2d");
    octx.drawImage(img, 0, 0);
    let data;
    try { data = octx.getImageData(0, 0, w, h).data; }
    catch (e) { return null; }
    const a = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = data[i * 4 + 3];
    return { w, h, a };
  }
  function buildMasks() {
    for (const img of [...stageImages, ...treeImages, ...rockImages]) {
      if (img && img.complete && img.naturalWidth) img._mask = buildMask(img);
    }
  }

  // A solid-black, alpha-preserving copy of a sprite, used as its drop shadow.
  // We also cache the opaque foot geometry (oc._sb) so the grounding pool can be
  // centred under where the object actually meets the ground, not the raw image
  // centre (matters for off-centre art like the rocks).
  function buildShadow(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const oc = document.createElement("canvas");
    oc.width = w; oc.height = h;
    const octx = oc.getContext("2d");
    octx.drawImage(img, 0, 0);
    const data = octx.getImageData(0, 0, w, h).data; // alpha read before recolour
    octx.globalCompositeOperation = "source-in"; // keep alpha, replace color
    octx.fillStyle = "#000";
    octx.fillRect(0, 0, w, h);
    let minx = w, maxx = -1, maxy = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) {
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y > maxy) maxy = y;
        }
      }
    }
    // foot centre = mean x over the bottom few opaque rows (the ground contact)
    let fsum = 0, fcount = 0;
    for (let y = Math.max(0, maxy - 5); y <= maxy && maxy >= 0; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) { fsum += x; fcount++; }
      }
    }
    oc._sb = {
      footX: fcount ? fsum / fcount : w / 2,
      maxy: maxy < 0 ? h - 1 : maxy,
      w: (maxx >= minx) ? (maxx - minx + 1) : w,
    };
    return oc;
  }
  // A radial black->transparent disc, baked once and reused as the soft
  // grounding pool under every object (cheaper than a per-frame gradient).
  let poolSprite = null;
  function buildPool() {
    const S = 128;
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const cx = c.getContext("2d");
    const g = cx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(0.55, "rgba(0,0,0,0.5)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    cx.fillStyle = g;
    cx.fillRect(0, 0, S, S);
    return c;
  }
  function buildShadows() {
    poolSprite = buildPool();
    for (const img of [...stageImages, ...treeImages, ...rockImages, woodImg, stoneImg]) {
      if (img && img.complete && img.naturalWidth) img._shadow = buildShadow(img);
    }
  }

  // --- Resources & harvesting ------------------------------------------
  function cellKey(c, r) { return r * world.cols + c; }

  // Per-resource-kind helpers (wood | stone).
  function dropImage(kind) { return kind === "stone" ? stoneImg : woodImg; }
  function resourceEl(kind) { return kind === "stone" ? stoneResourceEl : woodResourceEl; }
  function iconScreenPos(kind) {
    const r = (kind === "stone" ? stoneIconEl : woodIconEl).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // --- Tools (durability) ----------------------------------------------
  function hasTool(toolType) { return world.tools[toolType].count > 0; }
  // Spend one swing of durability on the active tool; break it when it hits 0
  // and promote the next one (if any) to a fresh full instance.
  function useTool(toolType) {
    const t = world.tools[toolType];
    if (t.count <= 0) return;
    t.dura -= 1;
    if (t.dura <= 0) { t.count -= 1; t.dura = t.count > 0 ? TOOL_DURABILITY : 0; }
    updateCraftedHud();
  }
  function addTool(toolType) {
    const t = world.tools[toolType];
    t.count += 1;
    if (t.count === 1) t.dura = TOOL_DURABILITY; // first one becomes the active instance
    updateCraftedHud();
  }

  // One harvest swing's yield. The matching tool raises the drop chance and
  // doubles output; using it costs 1 durability whether or not it pays out.
  function harvestRoll(kind) {
    const toolType = KIND_TOOL[kind];
    const tooled = hasTool(toolType);
    if (tooled) useTool(toolType);
    const chance = tooled ? TOOL_DROP_CHANCE : BASE_DROP_CHANCE;
    return Math.random() < chance ? (tooled ? TOOL_OUTPUT : BASE_OUTPUT) : 0;
  }

  // Emit a pop's pending drops now if not yet emitted (so they aren't lost when
  // the pop is replaced by a new click or removed by felling).
  function flushPopDrop(key) {
    const p = pops.get(key);
    if (p && !p.dropped) {
      p.dropped = true;
      for (let i = 0; i < p.dropCount; i++) spawnDrop(p.col, p.row, p.drop);
    }
  }

  // Click a tree: it "pops" every swing. Mature trees may drop wood (chance per
  // swing) and count toward felling; after CHOP_CLICKS it reverts to a sprout.
  function harvestTree(col, row) {
    if (world.stage[row][col] < MATURE) return; // only fully-grown trees react
    const key = cellKey(col, row);
    flushPopDrop(key); // don't lose the pending drops from a still-running pop
    world.chop[row][col] = (world.chop[row][col] || 0) + 1;
    pops.set(key, { col, row, t0: animTime, drop: "wood", dropCount: harvestRoll("tree"), dropped: false });
    // Schedule felling on its own timer; fast re-clicks must NOT postpone it.
    if (world.chop[row][col] >= CHOP_CLICKS && !chopResets.has(key)) {
      chopResets.set(key, animTime + POP_MS);
    }
  }

  // Click a rock: it "pops" and may drop stone (chance per swing). Infinite.
  function harvestRock(col, row) {
    if (world.rock[row][col] < 0) return;
    const key = cellKey(col, row);
    flushPopDrop(key);
    pops.set(key, { col, row, t0: animTime, drop: "stone", dropCount: harvestRoll("rock"), dropped: false });
  }

  function spawnDrop(col, row, kind) {
    const c = cellCenter(col, row);
    const ang = Math.random() * Math.PI * 2;
    const spd = 18 + Math.random() * 26;
    drops.push({
      kind,
      gx: c.x, gy: c.y,                    // world ground position
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      z: 34, vz: 70 + Math.random() * 30,  // height (world px) + upward velocity
      phase: "air",
    });
  }

  // --- Crafting ---------------------------------------------------------
  function craftCost(id, amount) {
    const c = CRAFTABLES[id].cost;
    return { wood: c.wood * amount, stone: c.stone * amount };
  }
  function canAfford(id, amount) {
    const cost = craftCost(id, amount);
    return world.wood >= cost.wood && world.stone >= cost.stone;
  }
  // Resources already spoken for by queued-but-not-yet-charged units across all
  // jobs (the currently-crafting unit of each job is already charged/deducted).
  function reservedCost() {
    let wood = 0, stone = 0;
    if (world.craft) {
      for (const id in world.craft) {
        const job = world.craft[id];
        const uncharged = job.remaining - (job.charged ? 1 : 0);
        const c = CRAFTABLES[id].cost;
        wood += c.wood * uncharged;
        stone += c.stone * uncharged;
      }
    }
    return { wood, stone };
  }
  // What can still be committed to NEW queue entries right now.
  function spendable() {
    const r = reservedCost();
    return { wood: world.wood - r.wood, stone: world.stone - r.stone };
  }

  // Queue crafting (deferred charge): enqueue up to `amount`, but only as many
  // as currently-uncommitted resources can cover. Nothing is charged here; each
  // unit is paid for when it actually starts crafting (see advanceCrafting).
  function startCraft(id, amount) {
    amount = Math.max(1, Math.min(CRAFT_MAX, amount | 0));
    const c = CRAFTABLES[id].cost;
    const sp = spendable();
    let add = 0;
    while (add < amount && sp.wood >= c.wood && sp.stone >= c.stone) {
      sp.wood -= c.wood; sp.stone -= c.stone; add++;
    }
    if (add <= 0) return;
    const job = world.craft[id] || (world.craft[id] = { remaining: 0, elapsed: 0, charged: false });
    job.remaining += add;
    updateCraftPanel();
  }

  // Cancel a queue: keep the in-progress unit (it finishes), drop all pending.
  function cancelCraft(id) {
    const job = world.craft[id];
    if (!job) return;
    if (job.charged) job.remaining = 1; // the active unit was paid for; let it finish
    else delete world.craft[id];
    updateCraftPanel();
  }

  // The single job currently crafting: the first queued one (insertion order).
  function firstCraftId() {
    for (const id in world.craft) {
      if (world.craft[id].remaining > 0) return id;
    }
    return null;
  }

  // Only ONE item crafts at a time (globally). Charge + produce one unit per
  // CRAFT_MS for the active job; every other queued job just waits its turn.
  function advanceCrafting(dtMs) {
    for (const id in world.craft) {           // sweep any emptied jobs
      if (world.craft[id].remaining <= 0) delete world.craft[id];
    }
    const id = firstCraftId();
    if (id) {
      const job = world.craft[id];
      if (!job.charged) {
        if (!canAfford(id, 1)) { delete world.craft[id]; } // safety net
        else {
          const c = CRAFTABLES[id].cost;
          world.wood -= c.wood; world.stone -= c.stone;
          job.charged = true;
          updateResourceUI();
        }
      }
      if (job.charged) {
        job.elapsed += dtMs;
        if (job.elapsed >= CRAFT_MS) {
          job.elapsed -= CRAFT_MS;
          job.remaining -= 1;
          job.charged = false;
          addTool(CRAFTABLES[id].tool);
          if (job.remaining <= 0) delete world.craft[id];
        }
      }
    }
    if (!craftPanel.classList.contains("hidden")) updateCraftPanel();
  }

  // Extra scale applied to a tree mid-pop (eases up then back down).
  function popFactor(col, row) {
    if (pops.size === 0) return 1; // fast path: no active pops (the common case)
    const p = pops.get(cellKey(col, row));
    if (!p) return 1;
    const prog = (animTime - p.t0) / POP_MS;
    if (prog <= 0 || prog >= 1) return 1;
    return 1 + POP_AMOUNT * Math.sin(prog * Math.PI);
  }

  // Ground point of a drop in main-canvas coords (height lifts it up).
  function dropScreen(d) {
    const s = worldToScreen(d.gx, d.gy);
    return { x: s.x, y: s.y - d.z * cam.zoom };
  }
  function dropHovered(d) {
    const sp = dropScreen(d);
    const img = dropImage(d.kind);
    const w = (img.naturalWidth || 32) * cam.zoom * DROP_SCALE;
    const h = (img.naturalHeight || 23) * cam.zoom * DROP_SCALE;
    return mouse.x >= sp.x - w / 2 && mouse.x <= sp.x + w / 2 && mouse.y >= sp.y - h && mouse.y <= sp.y;
  }
  function collectDrop(kind) {
    if (kind === "stone") world.stone = (world.stone | 0) + 1;
    else world.wood = (world.wood | 0) + 1;
    updateResourceUI();
    const el = resourceEl(kind);
    el.classList.add("tc-pop");
    setTimeout(() => el.classList.remove("tc-pop"), 130);
  }

  // Advance pops + drop physics (visual only; real dt, runs even while paused).
  function updateAnimations(dtMs) {
    const dt = Math.min(0.05, dtMs / 1000);

    // Hold-to-harvest: every HARVEST_INTERVAL_MS, harvest the object under the
    // cursor IF it matches the kind locked in when the hold began. Other kinds
    // (and empty cells) are ignored, so a drag sweeps one resource type.
    if (harvesting && mouse.on && !inMenu && animTime - lastHarvestAt >= HARVEST_INTERVAL_MS) {
      const obj = objectAt(mouse.x, mouse.y);
      if (obj && obj.kind === harvestKind) doHarvest(obj);
      lastHarvestAt = animTime;
    }

    for (const [key, p] of pops) {
      const prog = (animTime - p.t0) / POP_MS;
      if (prog >= 0.5 && !p.dropped) {
        p.dropped = true;
        for (let i = 0; i < p.dropCount; i++) spawnDrop(p.col, p.row, p.drop);
      }
      if (prog >= 1) pops.delete(key);
    }

    // Crafting: advance each in-progress batch; produce one finished tool every
    // CRAFT_MS (sequential). Runs even while paused / panel closed.
    advanceCrafting(dtMs);
    // Felling timer: reliably reverts a chopped tree to a sprout, independent
    // of the pop animation (which fast clicking would otherwise keep restarting).
    for (const [key, t] of chopResets) {
      if (animTime < t) continue;
      flushPopDrop(key); // make sure the felling click's drop still emits
      const col = key % world.cols, row = (key - col) / world.cols;
      world.stage[row][col] = 0;
      world.progress[row][col] = 0;
      world.chop[row][col] = 0;
      chopResets.delete(key);
      pops.delete(key);
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      if (d.phase === "fly") {
        if ((animTime - d.flyT0) / FLY_MS >= 1) { collectDrop(d.kind); drops.splice(i, 1); }
        continue;
      }
      d.gx += d.vx * dt;
      d.gy += d.vy * dt;
      d.vz -= DROP_GRAVITY * dt;
      d.z += d.vz * dt;
      if (d.z <= 0) {
        d.z = 0;
        if (d.vz < -DROP_REST_VZ) {
          d.vz = -d.vz * DROP_BOUNCE;
          d.vx *= 0.6; d.vy *= 0.6;
        } else {
          d.vz = 0; d.vx = 0; d.vy = 0; d.phase = "rest";
        }
      }
      if (d.phase === "rest" && !inMenu && mouse.on && dropHovered(d)) {
        const sp = dropScreen(d);
        d.phase = "fly";
        d.flyT0 = animTime;
        d.fromX = sp.x;                          // canvas coords ->
        d.fromY = sp.y + (TOPBAR_H + SUBBAR_H);  // full-screen coords
      }
    }
  }

  // Flying drops are drawn on the full-screen overlay so they reach the bar.
  function renderFx() {
    fxctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (inMenu) return;
    fxctx.imageSmoothingEnabled = false;
    for (const d of drops) {
      if (d.phase !== "fly") continue;
      const img = dropImage(d.kind);
      if (!img.complete) continue;
      const icon = iconScreenPos(d.kind);
      let fp = (animTime - d.flyT0) / FLY_MS;
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
    if (showHatchet) { tool = hatchetImg; pvx = HATCHET_PIVOT_X; pvy = HATCHET_PIVOT_Y; }
    else if (showPickaxe) { tool = pickaxeImg; pvx = PICKAXE_PIVOT_X; pvy = PICKAXE_PIVOT_Y; }
    if (tool && tool.complete && mouse.on) {
      const px = mouse.x;                          // canvas coords ->
      const py = mouse.y + (TOPBAR_H + SUBBAR_H);  // full-screen coords
      const w = (tool.naturalWidth || 32) * TOOL_SCALE;
      const h = (tool.naturalHeight || 29) * TOOL_SCALE;
      const phase = (1 - Math.cos(animTime * (Math.PI * 2 / TOOL_SWING_MS))) / 2; // 0..1
      const angle = phase * TOOL_SWING_DEG * Math.PI / 180; // clockwise from rest
      fxctx.save();
      fxctx.translate(px, py);
      fxctx.rotate(angle);
      fxctx.drawImage(tool, -pvx * TOOL_SCALE, -pvy * TOOL_SCALE, w, h);
      fxctx.restore();
    }
  }

  // Harvest a specific object (dispatch by kind).
  function doHarvest(obj) {
    if (!obj) return;
    if (obj.kind === "rock") harvestRock(obj.col, obj.row);
    else harvestTree(obj.col, obj.row);
  }

  // --- Rendering --------------------------------------------------------
  // Top-left of a sprite drawn on cell-anchor `s` (shared by sprite + shadow).
  function spriteRect(img, s, z, lift, sc) {
    const w = img.naturalWidth || img.width || SPRITE;
    const h = img.naturalHeight || img.height || SPRITE;
    const dw = w * z * sc, dh = h * z * sc;
    return { dw, dh, tx: s.x - dw / 2, ty: s.y - lift * z + (SPRITE / 2) * z - dh };
  }
  function blitImage(img, tx, ty, dw, dh, flip) {
    if (flip) {
      ctx.save();
      ctx.translate(tx + dw, ty);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(img, tx, ty, dw, dh);
    }
  }
  function drawSprite(img, s, z, lift, sc, flip) {
    const r = spriteRect(img, s, z, lift, sc);
    blitImage(img, r.tx, r.ty, r.dw, r.dh, flip);
  }
  // Cast a sprite's pre-built black silhouette so it lies on the ground: pin it
  // at the sprite's base (the cell anchor) and shear + squash it, so taller
  // parts of the sprite project further down-left like a real shadow.
  function drawShadow(img, s, z, lift, sc, flip) {
    const sh = img._shadow;
    if (!sh) return;
    const r = spriteRect(img, s, z, lift, sc);
    const meta = sh._sb;
    // Pin to the true opaque foot, not the image's bottom edge: saplings, rocks
    // etc. have transparent padding below the art, so anchoring to the image
    // edge would float the pool/cast below where the object actually stands.
    const footRows = meta ? (meta.maxy + 1) : (img.naturalHeight || SPRITE);
    const groundY = r.ty + footRows * z * sc;     // screen y of the foot
    // 1) Grounding pool: a soft ellipse under the foot so the shadow reads as
    //    anchored/centred instead of hanging off to one side.
    if (poolSprite && meta) {
      const fx = r.tx + meta.footX * z * sc;       // screen x of the foot
      const pw = meta.w * 0.9 * z * sc;            // pool width ~ footprint
      const ph = pw * SHADOW_POOL_RATIO;
      ctx.globalAlpha = SHADOW_POOL_ALPHA;
      ctx.drawImage(poolSprite, fx - pw / 2, groundY - ph / 2, pw, ph);
      ctx.globalAlpha = 1;
    }
    // 2) Directional cast: the silhouette sheared up-left and squashed flat,
    //    with the opaque foot row pinned to groundY (so it meets the pool).
    //    a=x-scale (flip), b=0, c=horizontal shear, d=vertical squash. Columns
    //    higher up the sprite (more negative local y) lean further left.
    ctx.save();
    ctx.globalAlpha = SHADOW_ALPHA;
    ctx.translate(s.x, groundY);
    ctx.transform(flip ? -1 : 1, 0, SHADOW_SKEW, SHADOW_SQUASH, 0, 0);
    ctx.drawImage(sh, -r.dw / 2, -footRows * z * sc, r.dw, r.dh);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Floating top-face diamond for the active cell. Drawn in two halves so the
  // object can sit between them: back (upper) edges behind it, front (lower)
  // edges in front - the ring wraps around the object.
  function tileDiamond(s, z) {
    const lift = 8 + Math.sin(animTime * 0.004) * 3; // hover ~8px up, bob +-3px
    const cy = s.y - lift;
    const hw = HALF_W * z, hh = HALF_H * z;
    return {
      top: { x: s.x, y: cy - hh },
      right: { x: s.x + hw, y: cy },
      bottom: { x: s.x, y: cy + hh },
      left: { x: s.x - hw, y: cy },
    };
  }
  function strokeDiamondHalf(d, part) {
    ctx.beginPath();
    if (part === "back") {
      ctx.moveTo(d.left.x, d.left.y);
      ctx.lineTo(d.top.x, d.top.y);
      ctx.lineTo(d.right.x, d.right.y);
    } else {
      ctx.moveTo(d.right.x, d.right.y);
      ctx.lineTo(d.bottom.x, d.bottom.y);
      ctx.lineTo(d.left.x, d.left.y);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.stroke();
  }

  function render() {
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (!hasWorld) { hover = null; hoverTile = null; showHatchet = false; showPickaxe = false; canvas.style.cursor = "default"; return; }
    const active = !inMenu && mouse.on;
    hover = active ? objectAt(mouse.x, mouse.y) : null;
    if (active) {
      const wpt = screenToWorld(mouse.x, mouse.y);
      const cell = worldToCell(wpt.x, wpt.y);
      hoverTile = inBounds(cell.col, cell.row) ? cell : null;
    } else {
      hoverTile = null;
    }
    // Tool cursor (OS cursor hidden): hatchet over a choppable tree, pickaxe
    // over a rock. While holding to harvest, lock the tool to the held kind.
    if (harvesting) {
      showHatchet = harvestKind === "tree";
      showPickaxe = harvestKind === "rock";
    } else {
      showHatchet = !!(hover && hover.kind === "tree" && hover.stage >= MATURE);
      showPickaxe = !!(hover && hover.kind === "rock");
    }
    const wantCursor = (showHatchet || showPickaxe) ? "none" : "default";
    if (canvas.style.cursor !== wantCursor) canvas.style.cursor = wantCursor;
    const z = cam.zoom;
    const b = visibleCellBounds();
    const waterFrame = waterFrameIndex(); // same for all water cells this frame
    // The active cell is the hovered tree's cell (if any), else the ground tile.
    const activeCell = hover || hoverTile;
    for (let r = b.r0; r <= b.r1; r++) {
      for (let c = b.c0; c <= b.c1; c++) {
        const center = cellCenter(c, r);
        const s = worldToScreen(center.x, center.y);
        const tImg = tileSprite(world.tiles[r][c], c, r, waterFrame);
        if (tImg && tImg.complete) drawSprite(tImg, s, z, 0, 1, false);
        // Active outline in two halves: back edges behind the object, front
        // edges in front, so the ring wraps around the object on this cell.
        const isActive = activeCell && activeCell.col === c && activeCell.row === r;
        const diamond = isActive ? tileDiamond(s, z) : null;
        if (diamond) strokeDiamondHalf(diamond, "back");
        // The cell's object (rock or tree), with the click-pop scale applied.
        const obj = cellObject(c, r);
        if (obj && obj.img.complete) {
          const sc = obj.sc * popFactor(c, r);
          drawShadow(obj.img, s, z, obj.lift, sc, obj.flip); // cast before the sprite
          const hl = hover && hover.col === c && hover.row === r;
          if (hl) ctx.filter = "brightness(1.6)";
          drawSprite(obj.img, s, z, obj.lift, sc, obj.flip);
          if (hl) ctx.filter = "none";
        }
        if (diamond) strokeDiamondHalf(diamond, "front");
      }
    }

    // Ground drops (resource pickups) drawn on top of the world, each with a
    // matching cast shadow sheared along the ground.
    for (const d of drops) {
      if (d.phase === "fly") continue;
      const img = dropImage(d.kind);
      if (!img.complete) continue;
      const lw = (img.naturalWidth || 32) * z * DROP_SCALE;
      const lh = (img.naturalHeight || 23) * z * DROP_SCALE;
      const sp = dropScreen(d);
      if (img._shadow) {
        ctx.save();
        ctx.globalAlpha = SHADOW_ALPHA;
        ctx.translate(sp.x, sp.y); // base of the drop
        ctx.transform(1, 0, SHADOW_SKEW, SHADOW_SQUASH, 0, 0);
        ctx.drawImage(img._shadow, -lw / 2, -lh, lw, lh);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(img, sp.x - lw / 2, sp.y - lh, lw, lh);
    }
  }

  function fitView(overscan) {
    const corners = [
      cellCenter(0, 0), cellCenter(world.cols - 1, 0),
      cellCenter(0, world.rows - 1), cellCenter(world.cols - 1, world.rows - 1),
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of corners) {
      minX = Math.min(minX, p.x - HALF_W); maxX = Math.max(maxX, p.x + HALF_W);
      minY = Math.min(minY, p.y - SPRITE); maxY = Math.max(maxY, p.y + SPRITE / 2);
    }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const fill = (overscan || 0.92);
    const z = Math.min(6, Math.max(0.1, Math.min(w / (maxX - minX), h / (maxY - minY)) * fill));
    cam.zoom = z;
    cam.x = w / 2 - ((minX + maxX) / 2) * z;
    cam.y = h / 2 - ((minY + maxY) / 2) * z;
  }

  function resizeCanvas() {
    // <canvas> is a replaced element, so its CSS box must be sized explicitly
    // (insets alone won't stretch it). It fills the viewport below the top bar
    // in-game, or the whole viewport on the main menu.
    const dpr = window.devicePixelRatio || 1;
    const barH = inMenu ? 0 : TOPBAR_H + SUBBAR_H;
    const cssW = window.innerWidth;
    const cssH = Math.max(1, window.innerHeight - barH);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // FX overlay spans the whole window (so drops can fly onto the bar).
    fxCanvas.style.width = window.innerWidth + "px";
    fxCanvas.style.height = window.innerHeight + "px";
    fxCanvas.width = Math.round(window.innerWidth * dpr);
    fxCanvas.height = Math.round(window.innerHeight * dpr);
    fxctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- Persistence (multiple worlds) -----------------------------------
  function readWorldsIndex() {
    try { const a = JSON.parse(localStorage.getItem(WORLDS_KEY)); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function writeWorldsIndex(list) {
    try { localStorage.setItem(WORLDS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }
  function saveWorld() {
    if (!hasWorld || !world.id) return; // menu background has no id -> not saved
    try {
      localStorage.setItem(worldKey(world.id), JSON.stringify({
        version: 5, id: world.id, name: world.name,
        cols: world.cols, rows: world.rows, seed: world.seed,
        settings: world.settings, tiles: world.tiles,
        stage: world.stage, progress: world.progress,
        chop: world.chop, rock: world.rock,
        wood: world.wood, stone: world.stone,
        tools: world.tools, craft: world.craft,
        drops: drops.filter((d) => d.phase === "rest").map((d) => ({ kind: d.kind, gx: d.gx, gy: d.gy })),
        tick: world.tick, running,
      }));
      localStorage.setItem(CURRENT_KEY, world.id);
      const list = readWorldsIndex();
      const entry = { id: world.id, name: world.name, size: world.cols, updatedAt: Date.now() };
      const i = list.findIndex((w) => w.id === world.id);
      if (i >= 0) list[i] = entry; else list.push(entry);
      writeWorldsIndex(list);
    } catch (e) { /* storage full / unavailable */ }
  }
  function loadWorld(id) {
    const json = localStorage.getItem(worldKey(id));
    if (!json) return false;
    try {
      const d = JSON.parse(json);
      if (!d || !Array.isArray(d.tiles)) return false;
      world.id = d.id || id;
      world.name = d.name || "World";
      world.cols = d.cols; world.rows = d.rows; world.seed = d.seed >>> 0;
      world.settings = Object.assign({ rockDensity: 0.4, rockCluster: 0.6 }, d.settings);
      world.tiles = d.tiles; world.stage = d.stage; world.progress = d.progress;
      world.chop = Array.isArray(d.chop) ? d.chop : makeLayer(d.cols, d.rows, 0);
      world.rock = Array.isArray(d.rock) ? d.rock : makeLayer(d.cols, d.rows, -1);
      world.wood = d.wood | 0;
      world.stone = d.stone | 0;
      world.tools = sanitizeTools(d.tools);
      world.craft = sanitizeCraft(d.craft);
      world.tick = d.tick || 0;
      resetTransients();
      const savedDrops = Array.isArray(d.drops) ? d.drops : (Array.isArray(d.logs) ? d.logs.map((p) => ({ kind: "wood", gx: p.gx, gy: p.gy })) : []);
      drops = savedDrops.map((p) => ({ kind: p.kind || "wood", gx: p.gx, gy: p.gy, vx: 0, vy: 0, z: 0, vz: 0, phase: "rest" }));
      hasWorld = true;
      running = d.running !== false;
      localStorage.setItem(CURRENT_KEY, world.id);
      updateResourceUI();
      updateCraftedHud();
      return true;
    } catch (e) { return false; }
  }
  function deleteWorld(id) {
    localStorage.removeItem(worldKey(id));
    writeWorldsIndex(readWorldsIndex().filter((w) => w.id !== id));
    if (localStorage.getItem(CURRENT_KEY) === id) localStorage.removeItem(CURRENT_KEY);
  }
  function newWorldId() {
    return "w_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // --- Loop (20 TPS sim, <=60 FPS render) -------------------------------
  let lastTime = 0, acc = 0, lastRender = 0, animTime = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    animTime = t;
    if (lastTime === 0) lastTime = t;
    let dt = t - lastTime;
    lastTime = t;
    if (dt > 250) dt = 250;
    if (running && hasWorld) {
      acc += dt;
      let steps = 0;
      while (acc >= TICK_MS && steps < 240) { tick(); acc -= TICK_MS; steps++; }
    } else {
      acc = 0;
    }
    if (hasWorld) updateAnimations(dt); // pops/drops animate even while paused
    if (t - lastRender >= FRAME_MS - 0.5) { lastRender = t; render(); renderFx(); }
  }

  function setRunning(on) {
    running = on;
    updatePlayPause();
    saveWorld();
  }
  function updatePlayPause() {
    playBtn.disabled = running;
    pauseBtn.disabled = !running;
  }

  // --- Camera input (in-game only; menu overlay blocks the canvas) ------
  let panning = false, panStart = null;
  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (inMenu || e.button !== 0) return; // left button only
    canvas.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    mouse.x = p.x; mouse.y = p.y; mouse.on = true;
    // Pressing a harvestable object starts a harvest-hold (locked to its kind);
    // pressing empty ground/water pans the camera instead.
    const obj = objectAt(p.x, p.y);
    if (obj) {
      harvesting = true;
      harvestKind = obj.kind;
      doHarvest(obj);              // first harvest is immediate
      lastHarvestAt = animTime;
    } else {
      panning = true;
      panStart = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y };
      canvas.classList.add("dragging");
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointerPos(e);
    mouse.x = p.x; mouse.y = p.y; mouse.on = true;
    if (!panning) return;
    cam.x = panStart.camX + (e.clientX - panStart.x);
    cam.y = panStart.camY + (e.clientY - panStart.y);
  });
  canvas.addEventListener("pointerleave", () => { mouse.on = false; });
  const endPan = (e) => {
    if (e && e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    panning = false;
    harvesting = false;
    harvestKind = null;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);
  canvas.addEventListener("wheel", (e) => {
    if (inMenu) return;
    e.preventDefault();
    const p = pointerPos(e);
    const before = screenToWorld(p.x, p.y);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    cam.zoom = Math.min(6, Math.max(0.1, cam.zoom * factor));
    cam.x = p.x - before.x * cam.zoom;
    cam.y = p.y - before.y * cam.zoom;
  }, { passive: false });

  // Parallax: drift the menu island opposite the mouse.
  window.addEventListener("mousemove", (e) => {
    if (!inMenu) return;
    const dx = e.clientX / window.innerWidth - 0.5;
    const dy = e.clientY / window.innerHeight - 0.5;
    cam.x = parallaxBase.x - dx * PARALLAX;
    cam.y = parallaxBase.y - dy * PARALLAX;
  });

  // --- UI: menus & flow -------------------------------------------------
  const randomSeed = () => Math.floor(Math.random() * 0xffffffff);

  function hideOverlays() {
    menuModal.classList.add("hidden");
    mainMenuScreen.classList.add("hidden");
    newWorldModal.classList.add("hidden");
    confirmModal.classList.add("hidden");
  }

  function startGame() {
    inMenu = false;
    document.body.classList.remove("tc-menu-mode");
    hideOverlays();
    resizeCanvas();
    fitView();
    updatePlayPause();
  }

  function generateMenuWorld() {
    world.id = null;
    world.name = "";
    generate(MENU_SIZE, MENU_SIZE, randomSeed(), {
      landFraction: 0.55, growthRate: 1.0, forestDensity: 0.5, cluster: 0.6,
      rockDensity: 0.4, rockCluster: 0.6,
    });
    fitMenu();
  }

  // Fit the menu island with a little overscan so parallax never reveals edges.
  function fitMenu() {
    fitView(0.92);
    const w = canvas.clientWidth, h = canvas.clientHeight, k = 1.3;
    cam.x = w / 2 - (w / 2 - cam.x) * k;
    cam.y = h / 2 - (h / 2 - cam.y) * k;
    cam.zoom *= k;
    parallaxBase = { x: cam.x, y: cam.y };
  }

  function showMainMenu() {
    if (world.id) saveWorld();        // persist the real world before leaving it
    inMenu = true;
    running = true;                   // animate the background island
    document.body.classList.add("tc-menu-mode");
    menuModal.classList.add("hidden");
    newWorldModal.classList.add("hidden");
    confirmModal.classList.add("hidden");
    craftPanel.classList.add("hidden");
    resizeCanvas();
    generateMenuWorld();
    renderWorldList();
    mainMenuScreen.classList.remove("hidden");
  }

  function suggestWorldName() {
    return "World " + (readWorldsIndex().length + 1);
  }

  function renderWorldList() {
    const list = readWorldsIndex().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    worldListEl.innerHTML = "";
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "tc-empty";
      p.textContent = "No worlds yet - create one to begin.";
      worldListEl.appendChild(p);
      return;
    }
    for (const w of list) {
      const row = document.createElement("div");
      row.className = "tc-world-btn";

      const play = document.createElement("button");
      play.type = "button";
      play.className = "tc-world-play";
      const ico = document.createElement("span");
      ico.className = "tc-play-ico";
      const label = document.createElement("span");
      label.className = "tc-world-name";
      label.textContent = w.size ? `${w.name}  -  ${w.size}x${w.size}` : w.name;
      play.append(ico, label);
      play.addEventListener("click", () => { if (loadWorld(w.id)) startGame(); });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "tc-world-del";
      del.textContent = "X";
      del.setAttribute("aria-label", "Delete " + w.name);
      del.addEventListener("click", () => askDelete(w));

      row.append(play, del);
      worldListEl.appendChild(row);
    }
  }

  function askDelete(w) {
    pendingDelete = w;
    el("tc-confirm-text").textContent = `"${w.name}" will be permanently deleted. This can't be undone.`;
    confirmModal.classList.remove("hidden");
  }

  function openNewWorld() {
    nameInput.value = suggestWorldName();
    ui.seed.value = randomSeed();
    mainMenuScreen.classList.add("hidden");
    newWorldModal.classList.remove("hidden");
  }

  function createWorld() {
    const size = clampInt(ui.size.value, 16, 64, 48);
    let seed = parseInt(ui.seed.value, 10);
    if (!Number.isFinite(seed)) { seed = randomSeed(); ui.seed.value = seed; }
    const settings = {
      landFraction: clampInt(ui.land.value, 0, 100, 55) / 100,
      growthRate: Math.min(10, Math.max(0.1, Number(ui.growth.value) || 1)),
      forestDensity: clampInt(ui.density.value, 0, 100, 40) / 100,
      cluster: clampInt(ui.cluster.value, 0, 100, 60) / 100,
      rockDensity: clampInt(ui.rockDensity.value, 0, 100, 40) / 100,
      rockCluster: clampInt(ui.rockCluster.value, 0, 100, 60) / 100,
    };
    world.id = newWorldId();
    world.name = (nameInput.value || suggestWorldName()).trim() || suggestWorldName();
    generate(size, size, seed >>> 0, settings);
    startGame();
    setRunning(true); // start running + persist the new world
  }

  function bindSlider(input, valEl, fmt) {
    const update = () => { valEl.textContent = fmt(input.value); };
    input.addEventListener("input", update);
    update();
  }

  function wireUi() {
    bindSlider(ui.size, ui.sizeVal, (v) => `${v}x${v}`);
    bindSlider(ui.land, ui.landVal, (v) => `${v}% land`);
    bindSlider(ui.growth, ui.growthVal, (v) => `${Number(v).toFixed(1)}x`);
    bindSlider(ui.density, ui.densityVal, (v) => `${v}%`);
    bindSlider(ui.cluster, ui.clusterVal, (v) => `${v}%`);
    bindSlider(ui.rockDensity, ui.rockDensityVal, (v) => `${v}%`);
    bindSlider(ui.rockCluster, ui.rockClusterVal, (v) => `${v}%`);

    el("tc-seed-random").addEventListener("click", () => { ui.seed.value = randomSeed(); });
    el("tc-generate").addEventListener("click", createWorld);
    el("tc-newworld-cancel").addEventListener("click", () => {
      newWorldModal.classList.add("hidden");
      mainMenuScreen.classList.remove("hidden");
    });
    el("tc-newworld-btn").addEventListener("click", openNewWorld);

    el("tc-confirm-cancel").addEventListener("click", () => {
      pendingDelete = null;
      confirmModal.classList.add("hidden");
    });
    el("tc-confirm-delete").addEventListener("click", () => {
      if (pendingDelete) {
        deleteWorld(pendingDelete.id);
        if (world.id === pendingDelete.id) world.id = null;
        pendingDelete = null;
        renderWorldList();
      }
      confirmModal.classList.add("hidden");
    });

    playBtn.addEventListener("click", () => setRunning(true));
    pauseBtn.addEventListener("click", () => setRunning(false));

    menuBtn.addEventListener("click", () => {
      resumeRunning = running;
      setRunning(false);
      menuModal.classList.remove("hidden");
    });
    el("tc-resume").addEventListener("click", () => {
      menuModal.classList.add("hidden");
      setRunning(resumeRunning);
    });
    el("tc-save").addEventListener("click", () => { saveWorld(); flashSaved(); });
    el("tc-mainmenu").addEventListener("click", () => { menuModal.classList.add("hidden"); showMainMenu(); });

    buildCraftPanel();
    craftBtn.addEventListener("click", toggleCraftPanel);
    craftCloseBtn.addEventListener("click", () => craftPanel.classList.add("hidden"));
    makeDraggable(craftPanel, craftTitlebar);
  }

  // --- Crafting panel & crafted HUD ------------------------------------
  const craftEntries = {}; // id -> { slider, costWood, costStone, button }
  const queueItems = {};   // id -> { el, count, fill }  (live queue rows)
  let craftQueueEl = null, craftQueueHead = null;

  function buildCraftPanel() {
    craftListEl.innerHTML = "";
    for (const id of Object.keys(CRAFTABLES)) {
      const def = CRAFTABLES[id];
      const entry = document.createElement("div");
      entry.className = "tc-craft-entry";

      const main = document.createElement("div");
      main.className = "tc-craft-main";

      const icon = document.createElement("img");
      icon.className = "tc-craft-icon";
      icon.src = def.icon; icon.alt = def.name;

      const mid = document.createElement("div");
      mid.className = "tc-craft-mid";
      const name = document.createElement("div");
      name.className = "tc-craft-name";
      name.textContent = def.name;
      const slider = document.createElement("input");
      slider.type = "range"; slider.min = "1"; slider.max = String(CRAFT_MAX); slider.value = "1";
      slider.className = "tc-craft-slider";
      const cost = document.createElement("div");
      cost.className = "tc-craft-cost";
      const woodC = costSpan(WOOD_ICON_SRC);
      const stoneC = costSpan(STONE_ICON_SRC);
      cost.append(woodC.wrap, stoneC.wrap);
      mid.append(name, slider, cost);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "tc-craft-do";

      main.append(icon, mid, button);
      entry.append(main);
      craftListEl.appendChild(entry);

      craftEntries[id] = { slider, costWood: woodC.val, costStone: stoneC.val, button };
      slider.addEventListener("input", updateCraftPanel);
      button.addEventListener("click", () => startCraft(id, +slider.value));
    }

    // Queue list: stacked-by-type, each row shows count + progress; hover to
    // cancel the pending units (the in-progress one always finishes).
    craftQueueHead = document.createElement("div");
    craftQueueHead.className = "tc-queue-head";
    craftQueueHead.textContent = "Queue";
    craftQueueEl = document.createElement("div");
    craftQueueEl.className = "tc-craft-queue";
    craftListEl.append(craftQueueHead, craftQueueEl);

    updateCraftPanel();
  }

  function costSpan(iconSrc) {
    const wrap = document.createElement("span");
    wrap.className = "tc-cost-item";
    const img = document.createElement("img");
    img.src = iconSrc;
    const val = document.createElement("span");
    wrap.append(img, val);
    return { wrap, val };
  }

  function createQueueItem(id) {
    const def = CRAFTABLES[id];
    const el = document.createElement("div");
    el.className = "tc-queue-item";
    el.title = "Cancel pending " + def.name;

    const img = document.createElement("img");
    img.src = def.icon; img.alt = def.name;
    const count = document.createElement("span");
    count.className = "tc-queue-count";
    const prog = document.createElement("div");
    prog.className = "tc-queue-progress";
    const fill = document.createElement("div");
    fill.className = "tc-queue-progress-fill";
    prog.appendChild(fill);
    const cancel = document.createElement("div");
    cancel.className = "tc-queue-cancel";
    cancel.textContent = "X";

    el.append(img, count, prog, cancel);
    el.addEventListener("click", () => cancelCraft(id));
    return { el, count, fill };
  }

  function updateCraftPanel() {
    const sp = spendable();
    for (const id of Object.keys(craftEntries)) {
      const e = craftEntries[id];
      const amount = +e.slider.value;
      const cost = craftCost(id, amount);
      const unit = CRAFTABLES[id].cost;
      e.costWood.textContent = cost.wood;
      e.costStone.textContent = cost.stone;
      // Red when the (uncommitted) resources can't cover the requested batch.
      e.costWood.classList.toggle("tc-short", sp.wood < cost.wood);
      e.costStone.classList.toggle("tc-short", sp.stone < cost.stone);
      e.button.textContent = "Craft x" + amount;
      // Enabled when at least one more unit can be queued (the rest cap at what
      // is affordable). Disabled outside an active world.
      e.button.disabled = !hasWorld || sp.wood < unit.wood || sp.stone < unit.stone;
    }
    updateCraftQueue();
  }

  // Diff the queue rows against world.craft: create/remove on change, update
  // count + progress in place every frame so hover/cancel stays stable.
  function updateCraftQueue() {
    if (!craftQueueEl) return;
    let any = false;
    for (const id of Object.keys(CRAFTABLES)) {
      const job = world.craft && world.craft[id];
      let qi = queueItems[id];
      if (job && job.remaining > 0) {
        any = true;
        if (!qi) { qi = createQueueItem(id); queueItems[id] = qi; craftQueueEl.appendChild(qi.el); }
        qi.count.textContent = "x" + job.remaining;
        qi.fill.style.width = (job.charged ? Math.min(1, job.elapsed / CRAFT_MS) : 0) * 100 + "%";
      } else if (qi) {
        qi.el.remove();
        delete queueItems[id];
      }
    }
    craftQueueHead.style.display = any ? "" : "none";
  }

  function updateCraftedHud() {
    craftedHud.innerHTML = "";
    if (!world.tools) return;
    for (const toolType of Object.keys(TOOLS)) {
      const t = world.tools[toolType];
      if (!t || t.count <= 0) continue;
      const item = document.createElement("div");
      item.className = "tc-crafted-item";
      const img = document.createElement("img");
      img.src = TOOLS[toolType].icon; img.alt = TOOLS[toolType].name; img.title = TOOLS[toolType].name;
      const count = document.createElement("span");
      count.className = "tc-crafted-count";
      count.textContent = t.count;
      const dura = document.createElement("div");
      dura.className = "tc-crafted-dura";
      const df = document.createElement("div");
      df.className = "tc-crafted-dura-fill";
      df.style.width = (t.dura / TOOL_DURABILITY) * 100 + "%";
      dura.appendChild(df);
      item.append(img, count, dura);
      craftedHud.appendChild(item);
    }
  }

  function toggleCraftPanel() {
    craftPanel.classList.toggle("hidden");
    if (!craftPanel.classList.contains("hidden")) updateCraftPanel();
  }

  // Drag a fixed-position panel by a handle, clamped to the viewport.
  function makeDraggable(panel, handle) {
    let start = null;
    handle.addEventListener("pointerdown", (e) => {
      const r = panel.getBoundingClientRect();
      start = { mx: e.clientX, my: e.clientY, left: r.left, top: r.top };
      handle.setPointerCapture(e.pointerId);
      panel.classList.add("tc-dragging");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start) return;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const left = Math.max(0, Math.min(window.innerWidth - w, start.left + e.clientX - start.mx));
      const top = Math.max(0, Math.min(window.innerHeight - h, start.top + e.clientY - start.my));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
    });
    const end = (e) => {
      if (start && e.pointerId !== undefined && handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      start = null;
      panel.classList.remove("tc-dragging");
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function flashSaved() {
    const b = el("tc-save");
    const prev = b.textContent;
    b.textContent = "Saved";
    b.disabled = true;
    setTimeout(() => { b.textContent = prev; b.disabled = false; }, 900);
  }

  function clampInt(value, min, max, fallback) {
    let n = parseInt(value, 10);
    if (!Number.isFinite(n)) n = fallback;
    return Math.min(max, Math.max(min, n));
  }

  // --- Image loading ----------------------------------------------------
  function loadImages() {
    const pending = [];
    const queue = (store, key, src) => {
      const img = new Image();
      store[key] = img;
      pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = src; }));
    };
    for (const id of Object.keys(TILE_SRC)) queue(images, id, TILE_SRC[id]);
    for (const key of Object.keys(WATER_BASES)) {
      const arr = (waterImages[key] = []);
      for (let f = 1; f <= WATER_FRAMES; f++) {
        const img = new Image();
        arr.push(img);
        pending.push(new Promise((res) => { img.onload = res; img.onerror = res; img.src = `/assets/tiles/${WATER_BASES[key]}_${f}.png`; }));
      }
    }
    STAGE_SRC.forEach((src, i) => queue(stageImages, i, src));
    TREE_SRC.forEach((src, i) => queue(treeImages, i, src));
    ROCK_SRC.forEach((src, i) => queue(rockImages, i, src));
    pending.push(new Promise((res) => { woodImg.onload = res; woodImg.onerror = res; woodImg.src = WOOD_ICON_SRC; }));
    pending.push(new Promise((res) => { stoneImg.onload = res; stoneImg.onerror = res; stoneImg.src = STONE_ICON_SRC; }));
    pending.push(new Promise((res) => { hatchetImg.onload = res; hatchetImg.onerror = res; hatchetImg.src = HATCHET_SRC; }));
    pending.push(new Promise((res) => { pickaxeImg.onload = res; pickaxeImg.onerror = res; pickaxeImg.src = PICKAXE_SRC; }));
    return Promise.all(pending);
  }

  // --- Init -------------------------------------------------------------
  function init() {
    wireUi();
    resizeCanvas();
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("resize", () => { resizeCanvas(); if (inMenu) fitMenu(); });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { saveWorld(); lastTime = 0; acc = 0; }
    });
    window.addEventListener("beforeunload", saveWorld);
    setInterval(saveWorld, AUTOSAVE_MS);

    loadImages().then(() => {
      buildMasks();
      buildShadows();
      showMainMenu();
      requestAnimationFrame(frame);
    });
  }

  init();
})();
