// Isometric map editor for TapCraftWeb.
// Reachable only via direct navigation to /MapEditor.
(() => {
  "use strict";

  // --- Tile definitions -------------------------------------------------
  // "void" is the empty tile (no sprite, just grid). "grass" uses the
  // 32x32 isometric cube sprite whose top-face diamond is 32x16.
  const TILES = {
    void: { id: "void", name: "Void", src: null },
    grass: { id: "grass", name: "Grass", src: "/assets/tiles/grass.png" },
    dirt: { id: "dirt", name: "Dirt", src: "/assets/tiles/dirt.png" },
    sand: { id: "sand", name: "Sand", src: "/assets/tiles/sand.png" },
    sprout: { id: "sprout", name: "Sprout", src: "/assets/tiles/sprout.png" },
    water: { id: "water", name: "Water", src: "/assets/tiles/water.png" },
  };
  const DEFAULT_TILE = "grass";

  // Water shoreline sprites. These are NOT placeable in the palette; they are
  // auto-selected per cell from the surrounding tiles (see waterEdge()).
  const WATER_EDGES = {
    ne: "/assets/tiles/water_ne.png", // land on the NE edge
    se: "/assets/tiles/water_se.png", // land on the SE edge
    sw: "/assets/tiles/water_sw.png", // land on the SW edge
    nw: "/assets/tiles/water_nw.png", // land on the NW edge
    n: "/assets/tiles/water_n.png",   // land on NW + NE (top corner)
    e: "/assets/tiles/water_e.png",   // land on NE + SE (right corner)
    s: "/assets/tiles/water_s.png",   // land on SE + SW (bottom corner)
    w: "/assets/tiles/water_w.png",   // land on SW + NW (left corner)
    o: "/assets/tiles/water_o.png",   // land all around
  };

  // Game objects (props). These live on a SEPARATE layer that sits on top of
  // the tiles. Sprites may be larger than a tile (e.g. trees are 46x50) and
  // are bottom-anchored so they appear rooted on the cell (see drawAnchored).
  //
  // `placeOn` lists the tile ids an object may be placed on; placement on any
  // other tile (including "void") fails. Tweak per object as needed.
  const OBJECTS = {
    grass_flower_1: { id: "grass_flower_1", name: "Grass Flower 1", src: "/assets/objects/grass_flower_1.png", placeOn: ["grass"] },
    grass_flower_2: { id: "grass_flower_2", name: "Grass Flower 2", src: "/assets/objects/grass_flower_2.png", placeOn: ["grass"] },
    grass_patch_1: { id: "grass_patch_1", name: "Grass Patch 1", src: "/assets/objects/grass_patch_1.png", placeOn: ["grass"] },
    grass_flower_3: { id: "grass_flower_3", name: "Grass Flower 3", src: "/assets/objects/grass_flower_3.png", placeOn: ["grass"] },
    grass_patch_2: { id: "grass_patch_2", name: "Grass Patch 2", src: "/assets/objects/grass_patch_2.png", placeOn: ["grass"] },
    flower_1: { id: "flower_1", name: "Flower 1", src: "/assets/objects/flower_1.png", placeOn: ["grass"] },
    flower_2: { id: "flower_2", name: "Flower 2", src: "/assets/objects/flower_2.png", placeOn: ["grass"] },
    log_1: { id: "log_1", name: "Log 1", src: "/assets/objects/log_1.png", placeOn: ["grass", "dirt"] },
    logs: { id: "logs", name: "Logs", src: "/assets/objects/logs.png", placeOn: ["grass", "dirt"] },
    log_2: { id: "log_2", name: "Log 2", src: "/assets/objects/log_2.png", placeOn: ["grass", "dirt"] },
    log_3: { id: "log_3", name: "Log 3", src: "/assets/objects/log_3.png", placeOn: ["grass", "dirt"] },
    log_4: { id: "log_4", name: "Log 4", src: "/assets/objects/log_4.png", placeOn: ["grass", "dirt"] },
    tree_1: { id: "tree_1", name: "Tree 1", src: "/assets/objects/tree_1.png", placeOn: ["grass", "dirt"] },
    tree_2: { id: "tree_2", name: "Tree 2", src: "/assets/objects/tree_2.png", placeOn: ["grass", "dirt"] },
    sapling: { id: "sapling", name: "Sapling", src: "/assets/objects/sapling.png", placeOn: ["grass", "dirt"] },
    youngling: { id: "youngling", name: "Youngling", src: "/assets/objects/youngling.png", placeOn: ["grass", "dirt"] },
    adolescent: { id: "adolescent", name: "Adolescent", src: "/assets/objects/adolescent.png", placeOn: ["grass", "dirt"] },
  };

  // --- Isometric geometry (derived from the sprite) ---------------------
  const SPRITE = 32;          // sprite is 32x32 px
  const HALF_W = 16;          // surface diamond half-width
  const HALF_H = 8;           // surface diamond half-height
  // Upward screen-pixel nudge applied to every object so props sit centred on
  // the tile instead of on its front corner. Tiles are not affected.
  const OBJECT_LIFT = 16;
  const STORAGE_KEY = "tapcraft.mapeditor.v1";

  // --- DOM --------------------------------------------------------------
  const canvas = document.getElementById("me-canvas");
  const ctx = canvas.getContext("2d");
  const paletteEl = document.getElementById("me-palette");
  const objectsEl = document.getElementById("me-objects");
  const statusEl = document.getElementById("me-status");
  const colsInput = document.getElementById("me-cols");
  const rowsInput = document.getElementById("me-rows");
  const showGridInput = document.getElementById("me-show-grid");
  const dialog = document.getElementById("me-io-dialog");
  const dialogTitle = document.getElementById("me-io-title");
  const dialogText = document.getElementById("me-io-text");
  const dialogConfirm = document.getElementById("me-io-confirm");

  // --- State ------------------------------------------------------------
  const state = {
    cols: 16,
    rows: 16,
    tiles: [],            // tiles[row][col]   -> tile id string ("void" = empty)
    objects: [],          // objects[row][col] -> object id string or null
    selected: DEFAULT_TILE, // id of the active brush (a tile OR an object id)
    showGrid: true,
    cam: { x: 0, y: 0, zoom: 2 },
    hover: null,          // { col, row }
  };

  const images = {};        // tile id -> HTMLImageElement (loaded)
  const edgeImages = {};    // water edge key -> HTMLImageElement (loaded)
  const objectImages = {};  // object id -> HTMLImageElement (loaded)
  let dialogMode = null;    // "export" | "import"

  // Is the given brush/id an object (vs a tile)?
  function isObjectId(id) {
    return Object.prototype.hasOwnProperty.call(OBJECTS, id);
  }

  // Display name for any brush id (tile or object).
  function brushName(id) {
    if (TILES[id]) return TILES[id].name;
    if (OBJECTS[id]) return OBJECTS[id].name;
    return id;
  }

  // Can the given object be placed on top of the given tile id?
  function canPlaceObject(objId, tileId) {
    const def = OBJECTS[objId];
    return !!(def && Array.isArray(def.placeOn) && def.placeOn.includes(tileId));
  }

  // --- Map helpers ------------------------------------------------------
  function makeMap(cols, rows, fill = "void") {
    const m = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols).fill(fill);
      m.push(row);
    }
    return m;
  }

  function resizeMap(cols, rows) {
    const nextTiles = makeMap(cols, rows, "void");
    const nextObjects = makeMap(cols, rows, null);
    for (let r = 0; r < Math.min(rows, state.rows); r++) {
      for (let c = 0; c < Math.min(cols, state.cols); c++) {
        nextTiles[r][c] = state.tiles[r][c];
        nextObjects[r][c] = state.objects[r][c];
      }
    }
    state.cols = cols;
    state.rows = rows;
    state.tiles = nextTiles;
    state.objects = nextObjects;
  }

  function inBounds(col, row) {
    return col >= 0 && row >= 0 && col < state.cols && row < state.rows;
  }

  // --- Coordinate transforms -------------------------------------------
  // Cell center in world space (before camera).
  function cellCenter(col, row) {
    return {
      x: (col - row) * HALF_W,
      y: (col + row) * HALF_H,
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * state.cam.zoom + state.cam.x,
      y: wy * state.cam.zoom + state.cam.y,
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - state.cam.x) / state.cam.zoom,
      y: (sy - state.cam.y) / state.cam.zoom,
    };
  }

  // Pick the cell whose surface diamond contains the world point.
  function worldToCell(wx, wy) {
    const col = Math.round(wx / (HALF_W * 2) + wy / (HALF_H * 2));
    const row = Math.round(wy / (HALF_H * 2) - wx / (HALF_W * 2));
    return { col, row };
  }

  // Range of cells overlapping the viewport, with a margin for tall/lifted
  // objects spilling in from off-screen neighbours. Keeps big maps fast.
  function visibleCellBounds() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pts = [
      screenToWorld(0, 0), screenToWorld(w, 0),
      screenToWorld(0, h), screenToWorld(w, h),
    ];
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const p of pts) {
      const { col, row } = worldToCell(p.x, p.y);
      minC = Math.min(minC, col); maxC = Math.max(maxC, col);
      minR = Math.min(minR, row); maxR = Math.max(maxR, row);
    }
    const M = 4;
    return {
      c0: Math.max(0, Math.floor(minC) - M),
      c1: Math.min(state.cols - 1, Math.ceil(maxC) + M),
      r0: Math.max(0, Math.floor(minR) - M),
      r1: Math.min(state.rows - 1, Math.ceil(maxR) + M),
    };
  }

  // --- Water autotiling -------------------------------------------------
  // A cell counts as "land" (and so makes water foam against it) when it
  // holds a solid tile. Water itself and void/empty do not create a shore,
  // and the area outside the map is treated as open water (no foam).
  function isLand(col, row) {
    if (!inBounds(col, row)) return false;
    const id = state.tiles[row][col];
    return id !== "void" && id !== "water";
  }

  // Edge-adjacent neighbours of an isometric cell:
  //   NE = (col, row-1)   SE = (col+1, row)
  //   SW = (col, row+1)   NW = (col-1, row)
  // Returns a WATER_EDGES key, or null for open water (use the base sprite).
  function waterEdge(col, row) {
    const ne = isLand(col, row - 1);
    const se = isLand(col + 1, row);
    const sw = isLand(col, row + 1);
    const nw = isLand(col - 1, row);
    const mask = (ne ? 1 : 0) | (se ? 2 : 0) | (sw ? 4 : 0) | (nw ? 8 : 0);
    switch (mask) {
      case 0: return null;   // open water
      case 1: return "ne";
      case 2: return "se";
      case 4: return "sw";
      case 8: return "nw";
      case 9: return "n";    // nw + ne
      case 3: return "e";    // ne + se
      case 6: return "s";    // se + sw
      case 12: return "w";   // sw + nw
      default: return "o";   // surrounded, or a combo we have no sprite for
    }
  }

  // Resolve the sprite to draw for a cell, applying water autotiling.
  function spriteFor(id, col, row) {
    if (id === "water") {
      const key = waterEdge(col, row);
      return key ? edgeImages[key] : images.water;
    }
    const tile = TILES[id];
    if (!tile || !tile.src) return null;
    return images[id];
  }

  // --- Rendering --------------------------------------------------------
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  // Draw a sprite anchored on a cell. Sprites are bottom-anchored: their base
  // footprint centre is SPRITE/2 (16px) up from the bottom of the canvas, so
  // taller sprites (trees) rise above the tile while staying rooted on it.
  function drawAnchored(img, s, z, lift = 0) {
    const w = img.naturalWidth || SPRITE;
    const h = img.naturalHeight || SPRITE;
    ctx.drawImage(img, s.x - (w / 2) * z, s.y - (h - SPRITE / 2) * z - lift, w * z, h * z);
  }

  function diamondPath(centerScreen) {
    const z = state.cam.zoom;
    const hw = HALF_W * z;
    const hh = HALF_H * z;
    ctx.beginPath();
    ctx.moveTo(centerScreen.x, centerScreen.y - hh);
    ctx.lineTo(centerScreen.x + hw, centerScreen.y);
    ctx.lineTo(centerScreen.x, centerScreen.y + hh);
    ctx.lineTo(centerScreen.x - hw, centerScreen.y);
    ctx.closePath();
  }

  function render() {
    // Nearest-neighbor (crisp pixel-art) sprite scaling.
    ctx.imageSmoothingEnabled = false;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Only touch cells near the viewport (matters at 100x100).
    const z = state.cam.zoom;
    const b = visibleCellBounds();

    // Grid outlines (skipped when zoomed too far out to be legible/useful).
    if (state.showGrid && z >= 0.5) {
      ctx.strokeStyle = "rgba(120, 150, 200, 0.25)";
      ctx.lineWidth = 1;
      for (let r = b.r0; r <= b.r1; r++) {
        for (let c = b.c0; c <= b.c1; c++) {
          const center = cellCenter(c, r);
          diamondPath(worldToScreen(center.x, center.y));
          ctx.stroke();
        }
      }
    }

    // Sprites, painter's order (back to front). Tile then object per cell so a
    // tall object in a back cell is correctly overdrawn by nearer cells.
    for (let r = b.r0; r <= b.r1; r++) {
      for (let c = b.c0; c <= b.c1; c++) {
        const center = cellCenter(c, r);
        const s = worldToScreen(center.x, center.y);

        const tileImg = spriteFor(state.tiles[r][c], c, r);
        if (tileImg && tileImg.complete) drawAnchored(tileImg, s, z);

        const objId = state.objects[r][c];
        if (objId) {
          const objImg = objectImages[objId];
          if (objImg && objImg.complete) drawAnchored(objImg, s, z, OBJECT_LIFT);
        }
      }
    }

    // Hover highlight.
    if (state.hover && inBounds(state.hover.col, state.hover.row)) {
      const center = cellCenter(state.hover.col, state.hover.row);
      diamondPath(worldToScreen(center.x, center.y));
      ctx.fillStyle = "rgba(79, 140, 255, 0.30)";
      ctx.fill();
      ctx.strokeStyle = "rgba(140, 190, 255, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function updateStatus(extra) {
    const hover = state.hover ? `cell ${state.hover.col},${state.hover.row}` : "-";
    const zoom = `${Math.round(state.cam.zoom * 100)}%`;
    const brush = `${isObjectId(state.selected) ? "obj" : "tile"}: ${brushName(state.selected)}`;
    statusEl.textContent =
      `${state.cols}x${state.rows}  |  ${hover}  |  zoom ${zoom}  |  ${brush}` +
      (extra ? `  |  ${extra}` : "");
  }

  // --- Centering / view -------------------------------------------------
  function resetView() {
    // World bounding box of all cell centers.
    const corners = [
      cellCenter(0, 0),
      cellCenter(state.cols - 1, 0),
      cellCenter(0, state.rows - 1),
      cellCenter(state.cols - 1, state.rows - 1),
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of corners) {
      minX = Math.min(minX, p.x - HALF_W);
      maxX = Math.max(maxX, p.x + HALF_W);
      minY = Math.min(minY, p.y - SPRITE / 2);
      maxY = Math.max(maxY, p.y + SPRITE / 2);
    }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const mapW = Math.max(1, maxX - minX);
    const mapH = Math.max(1, maxY - minY);
    // Fit the whole map to the viewport (with a little margin).
    const z = Math.min(6, Math.max(0.1, Math.min(w / mapW, h / mapH) * 0.92));
    state.cam.zoom = z;
    state.cam.x = w / 2 - ((minX + maxX) / 2) * z;
    state.cam.y = h / 2 - ((minY + maxY) / 2) * z;
    render();
  }

  // --- Procedural generation -------------------------------------------
  // Deterministic per-cell hash in [0,1) (same seed+cell -> same value).
  function hash01(x, y, seed) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 362437);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }

  // Seeded fractal value-noise (fBm) in [0,1]; no external dependencies.
  function makeFbm(seed, octaves = 5) {
    const hash = (x, y) => {
      let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 362437);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967295;
    };
    const smooth = (t) => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    const value = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = smooth(xf), v = smooth(yf);
      return lerp(
        lerp(hash(xi, yi), hash(xi + 1, yi), u),
        lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), u),
        v
      );
    };
    return (x, y) => {
      let amp = 0.5, freq = 1, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * value(x * freq, y * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      return sum / norm;
    };
  }

  // Grass landmass with an organic coastline, framed by water on all sides.
  // `seed` makes generation reproducible; `landFraction` (0..1) sets roughly
  // how much of the map is land via a percentile cut on the island value.
  //
  // Organic shape comes from domain warping: the sample coordinates (and the
  // radial falloff) are displaced by two more noise fields, turning the smooth
  // circular blob into bays, peninsulas and the odd detached islet.
  function generateIsland(cols, rows, seed, landFraction) {
    resizeMap(cols, rows);
    const s = seed >>> 0;
    const base = makeFbm(s, 6);
    const warpXn = makeFbm((s ^ 0x9e3779b9) >>> 0, 4);
    const warpYn = makeFbm((s ^ 0x85ebca6b) >>> 0, 4);
    const baseScale = 0.045; // base noise frequency (smaller = bigger features)
    const warpScale = 0.08;  // warp noise frequency
    const warpAmt = 22;      // max coordinate displacement, in cells
    const contrast = 1.5;    // pushes noise away from the mean -> rougher coast
    const falloffExp = 2.4;  // radial falloff shape
    const falloffMul = 1.0;  // radial falloff strength
    const v = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = c + (warpXn(c * warpScale, r * warpScale) * 2 - 1) * warpAmt;
        const wy = r + (warpYn(c * warpScale, r * warpScale) * 2 - 1) * warpAmt;
        let e = base(wx * baseScale, wy * baseScale); // 0..1
        e = (e - 0.5) * contrast + 0.5;
        const nx = (wx / (cols - 1) - 0.5) * 2; // warped distance -> organic outline
        const ny = (wy / (rows - 1) - 0.5) * 2;
        const d = Math.min(1, Math.hypot(nx, ny));
        v[r * cols + c] = e - Math.pow(d, falloffExp) * falloffMul;
      }
    }
    // Percentile threshold: keep the highest `landFraction` of cells as land.
    const sorted = Float64Array.from(v).sort();
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - landFraction) * sorted.length)));
    const threshold = sorted[idx];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        state.tiles[r][c] = v[r * cols + c] >= threshold ? "grass" : "water";
      }
    }
    // Belt-and-braces: force a 2-cell water frame so land never touches an edge.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r < 2 || c < 2 || r >= rows - 2 || c >= cols - 2) {
          state.tiles[r][c] = "water";
        }
      }
    }

    // Beaches: chance of sand by distance (in cells) from the nearest water.
    // Index 1 = coastline (water-adjacent land); 0 chance beyond the array.
    const SAND_CHANCE = [0, 0.75, 0.25];
    const maxCoast = SAND_CHANCE.length - 1;
    // Multi-source BFS from every water cell over the 4 iso edge-neighbours.
    const dist = new Int32Array(cols * rows).fill(-1);
    const queue = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (state.tiles[r][c] === "water") {
          const i = r * cols + c;
          dist[i] = 0;
          queue.push(i);
        }
      }
    }
    const N4 = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // NE, SE, SW, NW
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi];
      if (dist[i] >= maxCoast) continue; // no need to explore deeper inland
      const cc = i % cols;
      const rr = (i - cc) / cols;
      for (const [dc, dr] of N4) {
        const nc = cc + dc, nr = rr + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (dist[ni] !== -1) continue;
        dist[ni] = dist[i] + 1;
        queue.push(ni);
      }
    }
    const sandSeed = (s ^ 0x27d4eb2f) >>> 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (state.tiles[r][c] !== "grass") continue;
        const d = dist[r * cols + c];
        const p = d >= 1 && d <= maxCoast ? SAND_CHANCE[d] : 0;
        if (p > 0 && hash01(c, r, sandSeed) < p) {
          state.tiles[r][c] = "sand";
        }
      }
    }
  }

  // --- Painting ---------------------------------------------------------
  // mode "paint": place the active brush into its own layer (tile or object).
  // mode "erase": remove the top-most thing in the cell (object first, else
  // clear the tile to "void").
  function applyAt(sx, sy, mode) {
    const world = screenToWorld(sx, sy);
    const { col, row } = worldToCell(world.x, world.y);
    if (!inBounds(col, row)) return false;

    if (mode === "erase") {
      if (state.objects[row][col] !== null) {
        state.objects[row][col] = null;
        return true;
      }
      if (state.tiles[row][col] !== "void") {
        state.tiles[row][col] = "void";
        return true;
      }
      return false;
    }

    // paint
    if (isObjectId(state.selected)) {
      if (!canPlaceObject(state.selected, state.tiles[row][col])) return false;
      if (state.objects[row][col] === state.selected) return false;
      state.objects[row][col] = state.selected;
      return true;
    }
    if (state.tiles[row][col] === state.selected) return false;
    state.tiles[row][col] = state.selected;
    return true;
  }

  function updateHover(sx, sy) {
    const world = screenToWorld(sx, sy);
    state.hover = worldToCell(world.x, world.y);
  }

  // Explain (once, on click) why an object placement did nothing.
  function hintBlockedPlacement(sx, sy) {
    if (!isObjectId(state.selected)) return;
    const world = screenToWorld(sx, sy);
    const { col, row } = worldToCell(world.x, world.y);
    if (!inBounds(col, row)) return;
    const under = state.tiles[row][col];
    if (!canPlaceObject(state.selected, under)) {
      updateStatus(`can't place ${brushName(state.selected)} on ${brushName(under)}`);
    }
  }

  // --- Palette UI -------------------------------------------------------
  function buildSwatch(def) {
    const el = document.createElement("div");
    el.className = "me-tile" + (def.id === state.selected ? " selected" : "");
    el.dataset.id = def.id;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", def.id === state.selected ? "true" : "false");

    const thumb = document.createElement("div");
    thumb.className = "me-tile-thumb" + (def.src ? "" : " void");
    if (def.src) {
      const img = document.createElement("img");
      img.src = def.src;
      img.alt = def.name;
      thumb.appendChild(img);
    }

    const name = document.createElement("div");
    name.className = "me-tile-name";
    name.textContent = def.name;

    el.appendChild(thumb);
    el.appendChild(name);
    el.addEventListener("click", () => selectBrush(def.id));
    return el;
  }

  function buildPalette() {
    paletteEl.innerHTML = "";
    for (const id of Object.keys(TILES)) paletteEl.appendChild(buildSwatch(TILES[id]));
    objectsEl.innerHTML = "";
    for (const id of Object.keys(OBJECTS)) objectsEl.appendChild(buildSwatch(OBJECTS[id]));
  }

  function selectBrush(id) {
    state.selected = id;
    for (const el of [...paletteEl.children, ...objectsEl.children]) {
      const on = el.dataset.id === id;
      el.classList.toggle("selected", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
    }
    updateStatus();
  }

  // --- Persistence ------------------------------------------------------
  function serialize() {
    return JSON.stringify({
      version: 2,
      cols: state.cols,
      rows: state.rows,
      tiles: state.tiles,
      objects: state.objects,
    });
  }

  function deserialize(json) {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.tiles)) throw new Error("Invalid map data");
    const cols = data.cols | 0;
    const rows = data.rows | 0;
    if (cols < 1 || rows < 1 || data.tiles.length !== rows) {
      throw new Error("Invalid dimensions");
    }
    const tiles = data.tiles.map((row) =>
      row.map((id) => (TILES[id] ? id : "void"))
    );
    // objects layer is optional (older saves) - default to empty.
    const rawObjects = Array.isArray(data.objects) ? data.objects : [];
    const objects = makeMap(cols, rows, null);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = rawObjects[r] ? rawObjects[r][c] : null;
        objects[r][c] = OBJECTS[id] ? id : null;
      }
    }
    state.cols = cols;
    state.rows = rows;
    state.tiles = tiles;
    state.objects = objects;
    colsInput.value = cols;
    rowsInput.value = rows;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, serialize());
      updateStatus("saved");
    } catch (e) {
      updateStatus("save failed");
    }
  }

  function load() {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) {
      updateStatus("nothing saved");
      return;
    }
    try {
      deserialize(json);
      resetView();
      updateStatus("loaded");
    } catch (e) {
      updateStatus("load failed");
    }
  }

  // --- Image loading ----------------------------------------------------
  function loadImages() {
    const pending = [];
    const queue = (store, key, src) => {
      const img = new Image();
      store[key] = img;
      pending.push(
        new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
          img.src = src;
        })
      );
    };
    for (const id of Object.keys(TILES)) {
      if (TILES[id].src) queue(images, id, TILES[id].src);
    }
    for (const key of Object.keys(WATER_EDGES)) {
      queue(edgeImages, key, WATER_EDGES[key]);
    }
    for (const id of Object.keys(OBJECTS)) {
      if (OBJECTS[id].src) queue(objectImages, id, OBJECTS[id].src);
    }
    return Promise.all(pending);
  }

  // --- Pointer interaction ---------------------------------------------
  let action = null;   // "paint" | "erase" | "pan"
  let spaceHeld = false;
  let panStart = null;

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = pointerPos(e);

    if (e.button === 1 || spaceHeld) {
      action = "pan";
      panStart = { x: e.clientX, y: e.clientY, camX: state.cam.x, camY: state.cam.y };
      canvas.classList.add("panning");
      return;
    }
    if (e.button === 0) {
      action = "paint";
      if (applyAt(p.x, p.y, "paint")) render();
      else hintBlockedPlacement(p.x, p.y);
    } else if (e.button === 2) {
      action = "erase";
      if (applyAt(p.x, p.y, "erase")) render();
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = pointerPos(e);

    if (action === "pan" && panStart) {
      state.cam.x = panStart.camX + (e.clientX - panStart.x);
      state.cam.y = panStart.camY + (e.clientY - panStart.y);
      render();
      return;
    }

    updateHover(p.x, p.y);
    if (action === "paint") applyAt(p.x, p.y, "paint");
    else if (action === "erase") applyAt(p.x, p.y, "erase");
    render();
    updateStatus();
  });

  function endAction(e) {
    if (e && e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    action = null;
    panStart = null;
    canvas.classList.remove("panning");
  }

  canvas.addEventListener("pointerup", endAction);
  canvas.addEventListener("pointercancel", endAction);
  canvas.addEventListener("pointerleave", () => {
    state.hover = null;
    render();
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = pointerPos(e);
    const before = screenToWorld(p.x, p.y);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    state.cam.zoom = Math.min(6, Math.max(0.1, state.cam.zoom * factor));
    // Keep the world point under the cursor fixed.
    state.cam.x = p.x - before.x * state.cam.zoom;
    state.cam.y = p.y - before.y * state.cam.zoom;
    render();
    updateStatus();
  }, { passive: false });

  // --- Keyboard ---------------------------------------------------------
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !isTyping(e)) {
      spaceHeld = true;
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") spaceHeld = false;
  });

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  }

  // --- Toolbar buttons --------------------------------------------------
  document.getElementById("me-resize").addEventListener("click", () => {
    const cols = clampInt(colsInput.value, 1, 512, state.cols);
    const rows = clampInt(rowsInput.value, 1, 512, state.rows);
    colsInput.value = cols;
    rowsInput.value = rows;
    resizeMap(cols, rows);
    resetView();
    updateStatus("resized");
  });

  document.getElementById("me-fill").addEventListener("click", () => {
    if (isObjectId(state.selected)) {
      updateStatus("select a tile to fill");
      return;
    }
    state.tiles = makeMap(state.cols, state.rows, state.selected);
    render();
    updateStatus(`filled with ${brushName(state.selected)}`);
  });

  document.getElementById("me-clear").addEventListener("click", () => {
    state.tiles = makeMap(state.cols, state.rows, "void");
    state.objects = makeMap(state.cols, state.rows, null);
    render();
    updateStatus("cleared");
  });

  document.getElementById("me-save").addEventListener("click", save);
  document.getElementById("me-load").addEventListener("click", load);
  document.getElementById("me-reset-view").addEventListener("click", resetView);

  const genW = document.getElementById("me-gen-w");
  const genH = document.getElementById("me-gen-h");
  const genSeed = document.getElementById("me-gen-seed");
  const genLand = document.getElementById("me-gen-land");
  const genLandVal = document.getElementById("me-gen-land-val");

  const randomSeed = () => Math.floor(Math.random() * 0xffffffff);

  genLand.addEventListener("input", () => {
    genLandVal.textContent = `${genLand.value}%`;
  });

  document.getElementById("me-gen-random").addEventListener("click", () => {
    genSeed.value = randomSeed();
  });

  document.getElementById("me-generate").addEventListener("click", () => {
    const w = clampInt(genW.value, 4, 512, 100);
    const h = clampInt(genH.value, 4, 512, 100);
    let seed = parseInt(genSeed.value, 10);
    if (!Number.isFinite(seed)) {
      seed = randomSeed();
      genSeed.value = seed;
    }
    const landPct = clampInt(genLand.value, 0, 100, 55);
    genW.value = w;
    genH.value = h;
    generateIsland(w, h, seed, landPct / 100);
    colsInput.value = state.cols;
    rowsInput.value = state.rows;
    resetView();
    updateStatus(`generated ${w}x${h} island - seed ${seed} - ${landPct}% land`);
  });

  showGridInput.addEventListener("change", () => {
    state.showGrid = showGridInput.checked;
    render();
  });

  document.getElementById("me-export").addEventListener("click", () => {
    dialogMode = "export";
    dialogTitle.textContent = "Export map (copy this JSON)";
    dialogText.value = JSON.stringify(JSON.parse(serialize()), null, 2);
    dialogText.readOnly = true;
    dialogConfirm.style.display = "none";
    dialog.showModal();
    dialogText.select();
  });

  document.getElementById("me-import").addEventListener("click", () => {
    dialogMode = "import";
    dialogTitle.textContent = "Import map (paste JSON, then OK)";
    dialogText.value = "";
    dialogText.readOnly = false;
    dialogConfirm.style.display = "";
    dialog.showModal();
    dialogText.focus();
  });

  dialog.addEventListener("close", () => {
    if (dialogMode === "import" && dialog.returnValue === "confirm") {
      try {
        deserialize(dialogText.value);
        resetView();
        updateStatus("imported");
      } catch (e) {
        updateStatus("import failed: " + e.message);
      }
    }
    dialogMode = null;
  });

  function clampInt(value, min, max, fallback) {
    let n = parseInt(value, 10);
    if (!Number.isFinite(n)) n = fallback;
    return Math.min(max, Math.max(min, n));
  }

  // --- Init -------------------------------------------------------------
  function init() {
    state.tiles = makeMap(state.cols, state.rows, "void");
    state.objects = makeMap(state.cols, state.rows, null);
    genSeed.value = randomSeed();
    buildPalette();
    window.addEventListener("resize", resizeCanvas);
    loadImages().then(() => {
      resizeCanvas();
      resetView();
      updateStatus("ready");
    });
  }

  init();
})();
