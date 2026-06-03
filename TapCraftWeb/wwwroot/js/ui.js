// TapCraft - UI: resource counters, canvas sizing, menus and flow wiring.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { MENU_SIZE, TOPBAR_H, SUBBAR_H } from "./config.js";
import { G } from "./state.js";
import { GD } from "./gamedata.js";
import {
  el, canvas, ctx, fxCanvas, fxctx, glCanvas,
  resourceCountEl,
  menuBtn, craftBtn, craftPanel, craftTitlebar, craftCloseBtn,
  playBtn, pauseBtn, menuModal, mainMenuScreen, worldListEl,
  newWorldModal, confirmModal, nameInput, ui,
  buildBtn, buildHint, buildPanel, buildTitlebar, buildCloseBtn, buildListEl, buildingPanel,
  optionsModal, audioRowsEl, eventsEl, dayCounterEl,
} from "./dom.js";
import { resizeGL } from "./gl/glrender.js";
import { fitView, buildingAnchor, centerCameraOn, minZoom, visibleCellBounds } from "./iso.js";
import { generate } from "./worldgen.js";
import {
  readWorldsIndex, saveWorld, saveWorldNow, loadWorld, deleteWorld, newWorldId, applyPanels,
} from "./persistence.js";
import { setRunning, updatePlayPause } from "./sim.js";
import { buildCraftPanel, toggleCraftPanel } from "./crafting.js";
import {
  findBuilding, demolishBuilding, buildingTargets,
  producedTotal, productionPerMin, canAffordBuilding,
  storedTotal, receiveResources,
  hutToolKind, hutToolCount, effectiveMaxTargets, effectiveSpeedMs,
  hutMovable, poolMovableForHut, depositTool, withdrawTool,
  forgeOreTypes, forgeFreeOre, depositOre, withdrawOre, depositFuel,
} from "./buildings.js";
import {
  playSfx, getAudioSettings, setChannelVolume, setChannelMute, setWorldAudioPaused,
} from "./sound.js";

// The counter elements are static (built once from Index.cshtml) and this runs on
// every harvest tick, craft, and deposit. Cache the element refs (avoids a
// getElementById per resource per call) and the last value written (skips the DOM
// write when a counter is unchanged - this function only ever writes these nodes,
// so the cache stays in sync with what's on screen across world switches).
let resCountEls = null, resKinds = null;
const resLastShown = {};
export function updateResourceUI() {
  if (!resCountEls) {
    resCountEls = {};
    resKinds = Object.keys(GD.resources);
    for (const kind of resKinds) resCountEls[kind] = resourceCountEl(kind);
  }
  for (const kind of resKinds) {
    const elCount = resCountEls[kind];
    if (!elCount) continue;
    const v = G.world[kind] | 0;
    if (resLastShown[kind] === v) continue;
    resLastShown[kind] = v;
    elCount.textContent = v;
  }
}

export function resizeCanvas() {
  // <canvas> is a replaced element, so its CSS box must be sized explicitly
  // (insets alone won't stretch it). It fills the viewport below the top bar
  // in-game, or the whole viewport on the main menu.
  const dpr = window.devicePixelRatio || 1;
  const barH = G.inMenu ? 0 : TOPBAR_H + SUBBAR_H;
  const cssW = window.innerWidth;
  const cssH = Math.max(1, window.innerHeight - barH);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // WebGL world canvas: mirror the main canvas exactly (CSS rect + device backing) so the
  // GL viewport and the 2D overlay stay pixel-aligned (CSS positioning matches via game.css).
  if (glCanvas) {
    glCanvas.style.width = cssW + "px";
    glCanvas.style.height = cssH + "px";
    glCanvas.width = Math.round(cssW * dpr);
    glCanvas.height = Math.round(cssH * dpr);
    resizeGL(cssW, cssH);
  }
  // FX overlay spans the whole window (so drops can fly onto the bar).
  fxCanvas.style.width = window.innerWidth + "px";
  fxCanvas.style.height = window.innerHeight + "px";
  fxCanvas.width = Math.round(window.innerWidth * dpr);
  fxCanvas.height = Math.round(window.innerHeight * dpr);
  fxctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// --- UI: menus & flow -------------------------------------------------
export const randomSeed = () => Math.floor(Math.random() * 0xffffffff);

export function hideOverlays() {
  menuModal.classList.add("hidden");
  mainMenuScreen.classList.add("hidden");
  newWorldModal.classList.add("hidden");
  confirmModal.classList.add("hidden");
}

export function startGame() {
  G.inMenu = false;
  document.body.classList.remove("tc-menu-mode");
  hideOverlays();
  resizeCanvas();
  // Camera: a freshly loaded world restored its saved view; an infinite or large
  // world centers on its spawn (fitting the whole world is meaningless); small
  // finite worlds fit-to-view as before.
  if (G.camRestored) {
    G.camRestored = false;
    // A camera saved before the zoom cap (or on a larger screen) may be zoomed out
    // past what renders smoothly here - pull it back to the current min zoom.
    if (G.cam.zoom < minZoom()) centerCameraOn(G.world.spawn || { c: 0, r: 0 }, minZoom());
  } else if (G.world.infinite || G.world.cols > (GD.worldgen.islandMaxSize || 128)) {
    centerCameraOn(G.world.spawn || { c: 0, r: 0 }, 2);
  } else {
    fitView();
  }
  updatePlayPause();
  setWorldAudioPaused(!G.running); // match the world/ambient audio duck to the loaded running state
  // Restore the draggable craft/build panel positions + open state saved with this
  // world (no-op for a fresh world / when nothing was saved). Done here, after the
  // panels exist and the world is shown, so the layout reappears as the player left it.
  if (G.pendingPanels) { applyPanels(G.pendingPanels); G.pendingPanels = null; }
  updateDayCounter();
}

// Update the "Day N" HUD counter from G.world.day. Reads state directly (no
// cross-module import) so render.js / startGame can call it cheaply each frame.
let lastDayShown = -1;
export function updateDayCounter() {
  if (!dayCounterEl) return;
  const d = G.world.day | 0 || 1;
  if (d === lastDayShown) return; // only touch the DOM when the day actually changes
  lastDayShown = d;
  dayCounterEl.textContent = "Day " + d;
}

export function generateMenuWorld() {
  G.world.id = null;
  G.world.name = "";
  // Same defaults as a new world, but the menu island uses a denser forest. Stamp
  // the current genVersion so the menu island showcases the richer generation (it is
  // a small falloff world, so continent shaping stays off -> single island preserved).
  const settings = { ...GD.defaults.worldSettings, forestDensity: GD.defaults.menuForestDensity, genVersion: GD.worldgen.genVersion };
  generate(MENU_SIZE, MENU_SIZE, randomSeed(), settings);
  fitMenu();
}

// Fit the menu island with a little overscan so parallax never reveals edges.
export function fitMenu() {
  fitView(0.92);
  const w = canvas.clientWidth, h = canvas.clientHeight, k = 1.3;
  G.cam.x = w / 2 - (w / 2 - G.cam.x) * k;
  G.cam.y = h / 2 - (h / 2 - G.cam.y) * k;
  G.cam.zoom *= k;
  G.parallaxBase = { x: G.cam.x, y: G.cam.y };
}

export function showMainMenu() {
  if (G.world.id) saveWorldNow();     // sync: persist the real world before the menu preview replaces it
  G.inMenu = true;
  G.running = true;                   // animate the background island
  setWorldAudioPaused(false);         // menu preview runs -> world/ambient audio audible
  document.body.classList.add("tc-menu-mode");
  menuModal.classList.add("hidden");
  newWorldModal.classList.add("hidden");
  confirmModal.classList.add("hidden");
  craftPanel.classList.add("hidden");
  // Leaving for the menu clears any in-progress build placement / selection.
  G.buildMode = null;
  G.selectedBuilding = null;
  buildPanel.classList.add("hidden");
  hideBuildingPanel();
  resizeCanvas();
  generateMenuWorld();
  renderWorldList();
  mainMenuScreen.classList.remove("hidden");
}

export function suggestWorldName() {
  return "World " + (readWorldsIndex().length + 1);
}

export function renderWorldList() {
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
    const sizeLabel = w.size === 0 ? "Infinite" : (w.size ? `${w.size}x${w.size}` : "");
    label.textContent = sizeLabel ? `${w.name}  -  ${sizeLabel}` : w.name;
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

export function askDelete(w) {
  G.pendingDelete = w;
  el("tc-confirm-text").textContent = `"${w.name}" will be permanently deleted. This can't be undone.`;
  confirmModal.classList.remove("hidden");
}

// Switch the New World modal to a tab by name (a button's data-tab matches a
// panel's data-panel). Pure DOM toggle; safe to call before the modal is shown.
function showNewWorldTab(name) {
  document.querySelectorAll("#tc-newworld .tc-tab").forEach((t) =>
    t.classList.toggle("tc-tab-active", t.dataset.tab === name));
  document.querySelectorAll("#tc-newworld .tc-tabpanel").forEach((p) =>
    p.classList.toggle("tc-tabpanel-active", p.dataset.panel === name));
}

export function openNewWorld() {
  nameInput.value = suggestWorldName();
  ui.seed.value = randomSeed();
  showNewWorldTab("world");          // always reopen on the first tab
  mainMenuScreen.classList.add("hidden");
  newWorldModal.classList.remove("hidden");
}

export function createWorld() {
  const sl = GD.sliders;
  // Clamp each slider to its data-defined [min,max]/default. Percentage sliders
  // are authored 0..100 and scaled to 0..1 fractions; growth is a raw float.
  const pct = (s, key) => clampInt(s.value, sl[key].min, sl[key].max, sl[key].default) / 100;
  // Integer slider value clamped to its data-defined [min,max]/default.
  const intOf = (s, key) => clampInt(s.value, sl[key].min, sl[key].max, sl[key].default);
  // Float slider value clamped to its data-defined [min,max]/default.
  const floatOf = (s, key) => {
    let n = Number(s.value);
    if (!Number.isFinite(n)) n = sl[key].default;
    return Math.min(sl[key].max, Math.max(sl[key].min, n));
  };
  // World TYPE: globe (cylindrical, wraps E-W - the default), flat (finite island),
  // or infinite (endless). Globe size is a circumference; flat uses the map-size
  // slider; infinite uses neither. `infinite` is kept in settings for back-compat.
  const worldType = (ui.worldType && ui.worldType.value) || "globe";
  const infinite = worldType === "infinite";
  const size = (worldType === "flat") ? clampInt(ui.size.value, sl.size.min, sl.size.max, sl.size.default) : 0;
  const circumference = clampInt(ui.circ.value, sl.circumference.min, sl.circumference.max, sl.circumference.default);
  let seed = parseInt(ui.seed.value, 10);
  if (!Number.isFinite(seed)) { seed = randomSeed(); ui.seed.value = seed; }
  const settings = {
    worldType,
    infinite,
    circumference,
    landFraction: pct(ui.land, "land"),
    growthRate: Math.min(sl.growth.max, Math.max(sl.growth.min, Number(ui.growth.value) || sl.growth.default)),
    forestDensity: pct(ui.density, "density"),
    cluster: pct(ui.cluster, "cluster"),
    rockDensity: pct(ui.rockDensity, "rockDensity"),
    rockCluster: pct(ui.rockCluster, "rockCluster"),
    mineral: pct(ui.mineral, "mineral"),
    // Procedural generation version, stamped on NEW worlds so they get the richer
    // terrain (continents, highland stone/dirt, slope beaches, biome forests). Old
    // saves lack this field and read as legacy v1 in cells.js, preserving their
    // exact terrain shape + tile classes. Never default this in defaults.worldSettings.
    genVersion: GD.worldgen.genVersion,
    // Biomes + decoration. Size/density/clustering are 0..1 fractions; biome weights
    // are integers partitioning the land (highland by elevation, the rest by moisture).
    biomeSize: pct(ui.biomeSize, "biomeSize"),
    decorDensity: pct(ui.decorDensity, "decorDensity"),
    decorCluster: pct(ui.decorCluster, "decorCluster"),
    biomeWeights: {
      dry: intOf(ui.weightDry, "weightDry"),
      plains: intOf(ui.weightPlains, "weightPlains"),
      meadow: intOf(ui.weightMeadow, "weightMeadow"),
      forest: intOf(ui.weightForest, "weightForest"),
      jungle: intOf(ui.weightJungle, "weightJungle"),
      highland: intOf(ui.weightHighland, "weightHighland"),
    },
    // Ambient + weather (per-world, persisted in G.world.settings; consumers read
    // these with a GD fallback so old saves and the menu preview still work).
    bugs: intOf(ui.bugs, "bugs"),
    birds: intOf(ui.birds, "birds"),
    cloudCount: intOf(ui.clouds, "clouds"),
    weatherFreq: floatOf(ui.weatherFreq, "weatherFreq"),
    dayMinutes: intOf(ui.dayMinutes, "dayMinutes"),
    nightMinutes: intOf(ui.nightMinutes, "nightMinutes"),
    rainIntensity: floatOf(ui.rainIntensity, "rainIntensity"),
    weights: {
      clear: intOf(ui.weightClear, "weightClear"),
      cloudy: intOf(ui.weightCloudy, "weightCloudy"),
      rain: intOf(ui.weightRain, "weightRain"),
      storm: intOf(ui.weightStorm, "weightStorm"),
    },
  };
  G.world.id = newWorldId();
  G.world.name = (nameInput.value || suggestWorldName()).trim() || suggestWorldName();
  generate(size, size, seed >>> 0, settings);
  startGame();
  setRunning(true); // start running + persist the new world
}

export function bindSlider(input, valEl, fmt) {
  const update = () => { valEl.textContent = fmt(input.value); };
  input.addEventListener("input", update);
  update();
}

// Drive a slider's bounds + initial value from GD.sliders[key] (content pack =
// single source of truth), leaving the HTML attrs as fallbacks. No-op if the
// element or the data entry is missing.
export function applySliderAttrs(input, key) {
  const s = GD.sliders && GD.sliders[key];
  if (!input || !s) return;
  if (s.min != null) input.min = String(s.min);
  if (s.max != null) input.max = String(s.max);
  if (s.step != null) input.step = String(s.step);
  if (s.default != null) input.value = String(s.default);
}

export function wireUi() {
  // The size slider's bounds come from the content pack (single source of truth),
  // not the hardcoded HTML attributes - so raising the cap is a data change.
  ui.size.min = String(GD.sliders.size.min);
  ui.size.max = String(GD.sliders.size.max);
  ui.size.step = String(GD.sliders.size.step || 1);
  // World type drives which size control applies: globe -> circumference, flat -> map
  // size, infinite -> neither. Grey out the irrelevant rows as the type changes.
  applySliderAttrs(ui.circ, "circumference");
  if (ui.worldType) {
    const sizeRow = el("tc-size-row"), circRow = el("tc-circ-row");
    const sync = () => {
      const t = ui.worldType.value;
      if (sizeRow) sizeRow.classList.toggle("tc-disabled", t !== "flat");
      if (circRow) circRow.classList.toggle("tc-disabled", t !== "globe");
    };
    ui.worldType.addEventListener("change", sync);
    sync();
  }
  // New World: tab strip - clicking a tab shows its panel and hides the others.
  document.querySelectorAll("#tc-newworld .tc-tab").forEach((t) =>
    t.addEventListener("click", () => showNewWorldTab(t.dataset.tab)));
  bindSlider(ui.size, ui.sizeVal, (v) => `${v}x${v}`);
  // Globe-size readout: dimensions, loop distance, and river detail (the hydrology grid
  // is capped, so rivers coarsen once the circumference passes worldgen.globe.hydroMax).
  bindSlider(ui.circ, ui.circVal, (v) => {
    const w = Number(v) | 0, h = Math.round(w / 2);
    const hMax = (GD.worldgen.globe && GD.worldgen.globe.hydroMax) || 512;
    return `${w}x${h} - loops every ${w} - ${w <= hMax ? "crisp" : "coarse"} rivers`;
  });
  bindSlider(ui.land, ui.landVal, (v) => `${v}% land`);
  bindSlider(ui.growth, ui.growthVal, (v) => `${Number(v).toFixed(1)}x`);
  bindSlider(ui.density, ui.densityVal, (v) => `${v}%`);
  bindSlider(ui.cluster, ui.clusterVal, (v) => `${v}%`);
  bindSlider(ui.rockDensity, ui.rockDensityVal, (v) => `${v}%`);
  bindSlider(ui.rockCluster, ui.rockClusterVal, (v) => `${v}%`);
  bindSlider(ui.mineral, ui.mineralVal, (v) => `${v}%`);

  // Biome + decoration sliders (bounds/defaults from GD.sliders, same as above).
  applySliderAttrs(ui.biomeSize, "biomeSize");
  applySliderAttrs(ui.decorDensity, "decorDensity");
  applySliderAttrs(ui.decorCluster, "decorCluster");
  applySliderAttrs(ui.weightMeadow, "weightMeadow");
  applySliderAttrs(ui.weightPlains, "weightPlains");
  applySliderAttrs(ui.weightDry, "weightDry");
  applySliderAttrs(ui.weightForest, "weightForest");
  applySliderAttrs(ui.weightJungle, "weightJungle");
  applySliderAttrs(ui.weightHighland, "weightHighland");
  bindSlider(ui.biomeSize, ui.biomeSizeVal, (v) => `${v}%`);
  bindSlider(ui.decorDensity, ui.decorDensityVal, (v) => `${v}%`);
  bindSlider(ui.decorCluster, ui.decorClusterVal, (v) => `${v}%`);
  bindSlider(ui.weightMeadow, ui.weightMeadowVal, (v) => `${v}`);
  bindSlider(ui.weightPlains, ui.weightPlainsVal, (v) => `${v}`);
  bindSlider(ui.weightDry, ui.weightDryVal, (v) => `${v}`);
  bindSlider(ui.weightForest, ui.weightForestVal, (v) => `${v}`);
  bindSlider(ui.weightJungle, ui.weightJungleVal, (v) => `${v}`);
  bindSlider(ui.weightHighland, ui.weightHighlandVal, (v) => `${v}`);

  // Ambient and weather sliders: pull their min/max/step/value from GD.sliders
  // (single source of truth, same as the size slider above) then bind the live
  // value label. Old HTML attrs are sensible fallbacks if a key is missing.
  applySliderAttrs(ui.bugs, "bugs");
  applySliderAttrs(ui.birds, "birds");
  applySliderAttrs(ui.clouds, "clouds");
  applySliderAttrs(ui.weatherFreq, "weatherFreq");
  applySliderAttrs(ui.dayMinutes, "dayMinutes");
  applySliderAttrs(ui.nightMinutes, "nightMinutes");
  applySliderAttrs(ui.rainIntensity, "rainIntensity");
  applySliderAttrs(ui.weightClear, "weightClear");
  applySliderAttrs(ui.weightCloudy, "weightCloudy");
  applySliderAttrs(ui.weightRain, "weightRain");
  applySliderAttrs(ui.weightStorm, "weightStorm");
  bindSlider(ui.bugs, ui.bugsVal, (v) => `${v}`);
  bindSlider(ui.birds, ui.birdsVal, (v) => `${v}`);
  bindSlider(ui.clouds, ui.cloudsVal, (v) => `${v}`);
  bindSlider(ui.weatherFreq, ui.weatherFreqVal, (v) => `${Number(v).toFixed(1)} min`);
  bindSlider(ui.dayMinutes, ui.dayMinutesVal, (v) => `${v} min`);
  bindSlider(ui.nightMinutes, ui.nightMinutesVal, (v) => `${v} min`);
  bindSlider(ui.rainIntensity, ui.rainIntensityVal, (v) => `${Number(v).toFixed(1)}x`);
  bindSlider(ui.weightClear, ui.weightClearVal, (v) => `${v}`);
  bindSlider(ui.weightCloudy, ui.weightCloudyVal, (v) => `${v}`);
  bindSlider(ui.weightRain, ui.weightRainVal, (v) => `${v}`);
  bindSlider(ui.weightStorm, ui.weightStormVal, (v) => `${v}`);

  el("tc-seed-random").addEventListener("click", () => { ui.seed.value = randomSeed(); });
  el("tc-generate").addEventListener("click", createWorld);
  el("tc-newworld-cancel").addEventListener("click", () => {
    newWorldModal.classList.add("hidden");
    mainMenuScreen.classList.remove("hidden");
  });
  el("tc-newworld-btn").addEventListener("click", openNewWorld);

  el("tc-confirm-cancel").addEventListener("click", () => {
    G.pendingDelete = null;
    confirmModal.classList.add("hidden");
  });
  el("tc-confirm-delete").addEventListener("click", () => {
    if (G.pendingDelete) {
      deleteWorld(G.pendingDelete.id);
      if (G.world.id === G.pendingDelete.id) G.world.id = null;
      G.pendingDelete = null;
      renderWorldList();
    }
    confirmModal.classList.add("hidden");
  });

  playBtn.addEventListener("click", () => setRunning(true));
  pauseBtn.addEventListener("click", () => setRunning(false));

  menuBtn.addEventListener("click", () => {
    G.resumeRunning = G.running;
    setRunning(false);
    menuModal.classList.remove("hidden");
  });
  el("tc-resume").addEventListener("click", () => {
    menuModal.classList.add("hidden");
    setRunning(G.resumeRunning);
  });
  el("tc-options").addEventListener("click", openOptions);
  el("tc-options-back").addEventListener("click", closeOptions);
  el("tc-save").addEventListener("click", () => { saveWorldNow(); flashSaved(); }); // explicit: write now so "Saved" is truthful
  el("tc-mainmenu").addEventListener("click", () => { menuModal.classList.add("hidden"); showMainMenu(); });

  buildCraftPanel();
  craftBtn.addEventListener("click", toggleCraftPanel);
  craftCloseBtn.addEventListener("click", () => craftPanel.classList.add("hidden"));
  makeDraggable(craftPanel, craftTitlebar);

  // Build UI: a floating, draggable panel mirroring the craft panel.
  buildBtn.addEventListener("click", toggleBuildPanel);
  buildBuildPanel(); // pre-populate now (mirrors buildCraftPanel above) so a restored-open build panel has content; reads only static GD.buildings, safe before a world exists. Root cause of the "build loads empty until reopened" bug: content was only built inside toggleBuildPanel, which applyPanels(restore) never calls.
  buildCloseBtn.addEventListener("click", () => buildPanel.classList.add("hidden"));
  makeDraggable(buildPanel, buildTitlebar);
  el("tc-bpanel-receive").addEventListener("click", () => {
    if (G.selectedBuilding && receiveResources(G.selectedBuilding) > 0) { panelState.stored = -1; saveWorld(); }
  });
  // Deposit/Withdraw: the slider sets the requested amount; depositTool/
  // withdrawTool clamp to each side's movable count. Slider input updates its
  // live value label; a move re-syncs the slider range next frame.
  const toolQty = () => { const n = parseInt(el("tc-bpanel-qty").value, 10); return Number.isFinite(n) && n > 0 ? n : 1; };
  el("tc-bpanel-qty").addEventListener("input", () => { el("tc-bpanel-qty-val").textContent = el("tc-bpanel-qty").value; });
  el("tc-bpanel-deposit").addEventListener("click", () => {
    if (G.selectedBuilding && depositTool(G.selectedBuilding, toolQty()) > 0) { panelState.tools = -1; panelState.qtyMax = -1; saveWorld(); }
  });
  el("tc-bpanel-withdraw").addEventListener("click", () => {
    if (G.selectedBuilding && withdrawTool(G.selectedBuilding, toolQty()) > 0) { panelState.tools = -1; panelState.qtyMax = -1; saveWorld(); }
  });
  el("tc-bpanel-demolish").addEventListener("click", () => {
    if (G.selectedBuilding) { demolishBuilding(G.selectedBuilding); hideBuildingPanel(); saveWorld(); }
  });
}

// Drag a fixed-position panel by a handle, clamped to the viewport.
export function makeDraggable(panel, handle) {
  let start = null;
  handle.addEventListener("pointerdown", (e) => {
    // Let buttons in the titlebar (e.g. the X close) receive their click
    // instead of starting a drag + capturing the pointer.
    if (e.target.closest("button")) return;
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

export function flashSaved() {
  const b = el("tc-save");
  const prev = b.textContent;
  b.textContent = "Saved";
  b.disabled = true;
  setTimeout(() => { b.textContent = prev; b.disabled = false; }, 900);
}

export function clampInt(value, min, max, fallback) {
  let n = parseInt(value, 10);
  if (!Number.isFinite(n)) n = fallback;
  return Math.min(max, Math.max(min, n));
}

// --- Build UI: picker, placement, and the world-anchored info panel --------
export function buildBuildPanel() {
  buildListEl.innerHTML = "";
  for (const id of Object.keys(GD.buildings)) {
    const def = GD.buildings[id];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tc-build-entry";

    const img = document.createElement("img");
    img.className = "tc-build-icon";
    img.src = def.sprites.SE; img.alt = def.name;

    const mid = document.createElement("div");
    mid.className = "tc-build-mid";
    const name = document.createElement("div");
    name.className = "tc-build-name";
    name.textContent = def.name;
    const cost = document.createElement("div");
    cost.className = "tc-build-cost";
    cost.innerHTML =
      `<span class="tc-cost-item"><img src="${GD.resources.wood.icon}" /><span>${def.buildCost.wood}</span></span>` +
      `<span class="tc-cost-item"><img src="${GD.resources.stone.icon}" /><span>${def.buildCost.stone}</span></span>`;
    mid.append(name, cost);

    row.append(img, mid);
    // Picking a building arms placement mode; the panel STAYS OPEN (like the
    // craft panel) so you can pick another or close it with X.
    row.addEventListener("click", () => {
      G.selectedBuilding = null;
      hideBuildingPanel();
      G.buildMode = { type: id, facing: "SE" };
      markAffordability();
    });
    buildListEl.appendChild(row);
  }
  markAffordability();
}
// Grey entries you cannot afford (non-blocking; placement still validates cost).
function markAffordability() {
  const rows = buildListEl.children;
  let i = 0;
  for (const id of Object.keys(GD.buildings)) {
    if (rows[i]) rows[i].classList.toggle("tc-unaffordable", !canAffordBuilding(id));
    i++;
  }
}
export function toggleBuildPanel() {
  buildPanel.classList.toggle("hidden");
  if (!buildPanel.classList.contains("hidden")) buildBuildPanel();
}
// Live affordability refresh, mirroring how the craft panel re-runs updateCraftPanel
// each frame while open: entries brighten (lose tc-unaffordable) the moment you can
// afford them. Called per frame from render.js; cheap (a handful of buildings).
// Affordability only changes when a build-cost resource changes (or the panel is
// rebuilt, which force-marks via markAffordability directly). Gate the per-frame
// re-mark on an actual change so an open build panel isn't re-scanned every frame.
let affordKinds = null, affordLast = null;
function affordabilityChanged() {
  if (!affordKinds) {
    const set = new Set();
    for (const id of Object.keys(GD.buildings)) {
      for (const k of Object.keys(GD.buildings[id].buildCost || {})) set.add(k);
    }
    affordKinds = Array.from(set);
    affordLast = {};
  }
  let changed = false;
  for (const k of affordKinds) {
    const v = G.world[k] | 0;
    if (affordLast[k] !== v) { affordLast[k] = v; changed = true; }
  }
  return changed;
}
export function updateBuildPanel() {
  if (buildPanel.classList.contains("hidden")) return;
  if (!affordabilityChanged()) return;
  markAffordability();
}

// --- Options modal: sound channels -----------------------------------
const AUDIO_CHANNELS = [
  { id: "master", label: "Master" },
  { id: "music", label: "Music" },
  { id: "ambience", label: "Ambience" },
  { id: "effects", label: "Effects" },
  { id: "building", label: "Building Sounds" },
];
let audioRowsBuilt = false;
function buildAudioRows() {
  if (audioRowsBuilt) return;
  audioRowsBuilt = true;
  const s = getAudioSettings();
  for (const ch of AUDIO_CHANNELS) {
    const cur = s[ch.id] || { vol: 1, mute: false };
    const row = document.createElement("div");
    row.className = "tc-row tc-audio-row";

    const head = document.createElement("div");
    head.className = "tc-row-head";
    const label = document.createElement("label");
    label.textContent = ch.label;
    const val = document.createElement("span");
    val.className = "tc-val";
    val.textContent = Math.round(cur.vol * 100) + "%";
    head.append(label, val);

    const ctrls = document.createElement("div");
    ctrls.className = "tc-audio-ctrls";
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "0"; slider.max = "100"; slider.step = "1";
    slider.className = "tc-range";
    slider.value = String(Math.round(cur.vol * 100));
    const muteWrap = document.createElement("label");
    muteWrap.className = "tc-mute";
    const mute = document.createElement("input");
    mute.type = "checkbox"; mute.checked = !!cur.mute;
    muteWrap.append(mute, document.createTextNode("Mute"));
    ctrls.append(slider, muteWrap);

    slider.addEventListener("input", () => {
      setChannelVolume(ch.id, (+slider.value) / 100);
      val.textContent = slider.value + "%";
    });
    mute.addEventListener("change", () => setChannelMute(ch.id, mute.checked));

    row.append(head, ctrls);
    audioRowsEl.appendChild(row);
  }
}
export function openOptions() {
  buildAudioRows();
  menuModal.classList.add("hidden");
  optionsModal.classList.remove("hidden");
  setWorldAudioPaused(false); // un-duck while in options so the volume sliders preview audibly
}
export function closeOptions() {
  optionsModal.classList.add("hidden");
  menuModal.classList.remove("hidden"); // back to the hamburger menu
  setWorldAudioPaused(!G.running);      // restore the paused/playing duck state
}

// Show/hide the placement hint banner based on buildMode (called each frame).
export function updateBuildHint() {
  const want = !!G.buildMode && !G.inMenu;
  if (want === !buildHint.classList.contains("hidden")) return;
  buildHint.classList.toggle("hidden", !want);
}

// Callbacks used by input.js after a placement/selection happens.
export function onBuildingPlaced(b) { saveWorld(); }
export function onBuildingSelected(b) {
  if (b) { playSfx("door_open", "building"); showBuildingPanel(b); } // "open the door" on a placed building
  else hideBuildingPanel();
}

// The world-anchored panel: a fixed-position DOM card that tracks the selected
// building each frame and scales with the map zoom (clamped readable).
function freshPanelState() { return { stored: -1, produced: -1, rate: -1, targets: -1, status: "", tools: -1, bonus: "", qtyMax: -1, recv: "" }; }
let panelState = freshPanelState();
export function showBuildingPanel(b) {
  const def = GD.buildings[b.type];
  el("tc-bpanel-title").textContent = def.name;
  const cat = def.category;
  // Title icon: harvester -> what it produces; smelter -> Forge ingot; crafting -> none.
  if (cat === "harvester") {
    const resKind = GD.objects[def.targetKind].drop;
    el("tc-bpanel-icon").src = GD.resources[resKind].icon;
    el("tc-bpanel-tool-icon").src = GD.tools[hutToolKind(b)].icon;
    el("tc-bpanel-receive-icon").src = GD.resources[resKind].icon;
  } else if (cat === "smelter") {
    el("tc-bpanel-icon").src = def.sprites.SE; // building thumbnail
    // Forge has its own per-ingot Receive buttons (built in buildForgeRows).
  } else {
    el("tc-bpanel-icon").src = def.sprites.SE; // building thumbnail
  }
  // Show only the rows for this category.
  setPanelCategory(cat);
  // Build the Forge body once per open (deposit rows per ore type).
  if (cat === "smelter") buildForgeRows(b);
  panelState = freshPanelState();
  buildingPanel.classList.remove("hidden");
  positionBuildingPanel();
}
// Show only the rows whose data-cat token list includes `cat`; hide the rest.
// Toggles inline display (NOT a class) because there is no .tc-bpanel-row.hidden
// rule, and so a row tagged with several cats (e.g. the Receive button
// "harvester smelter") shows for ANY of its listed categories. Rows without a
// data-cat (Status, title, Demolish) are shared and left untouched.
function setPanelCategory(cat) {
  for (const el2 of buildingPanel.querySelectorAll("[data-cat]")) {
    const cats = (el2.getAttribute("data-cat") || "").split(/\s+/);
    el2.style.display = cats.indexOf(cat) >= 0 ? "" : "none";
  }
}
export function hideBuildingPanel() {
  buildingPanel.classList.add("hidden");
}
// Called every frame from render() while a building is selected.
export function positionBuildingPanel() {
  const id = G.selectedBuilding;
  if (!id) { if (!buildingPanel.classList.contains("hidden")) hideBuildingPanel(); return; }
  const b = findBuilding(id);
  if (!b || G.inMenu) { hideBuildingPanel(); return; }
  if (buildingPanel.classList.contains("hidden")) buildingPanel.classList.remove("hidden");

  // Anchor over the building's top, scaled with zoom (clamped readable). On the torus
  // globe, shift to the wrapped copy nearest the view center (both axes) so the panel
  // tracks the building wherever it is drawn in the current loop.
  let acol = b.col, arow = b.row;
  if (G.world.wrapX || G.world.wrapY) {
    const bb = visibleCellBounds();
    if (G.world.wrapX) { const n = G.world.cols, ctr = (bb.c0 + bb.c1) / 2; acol = b.col + Math.round((ctr - b.col) / n) * n; }
    if (G.world.wrapY) { const n = G.world.rows, ctr = (bb.r0 + bb.r1) / 2; arow = b.row + Math.round((ctr - b.row) / n) * n; }
  }
  const a = buildingAnchor(acol, arow);
  const scale = Math.min(1.6, Math.max(0.8, G.cam.zoom / 2));
  buildingPanel.style.left = a.x + "px";
  buildingPanel.style.top = (a.y + (TOPBAR_H + SUBBAR_H)) + "px";
  buildingPanel.style.transform = `translate(-50%, calc(-100% - 90px)) scale(${scale})`;

  const cat = GD.buildings[b.type].category;
  if (cat === "harvester") refreshHarvesterPanel(b);
  else if (cat === "smelter") refreshForgePanel(b);
  // crafting: static body, nothing dynamic.
}

function refreshHarvesterPanel(b) {
  const def = GD.buildings[b.type];
  const tools = hutToolCount(b);
  const stored = storedTotal(b);
  const produced = producedTotal(b);
  const rate = productionPerMin(b);
  const targets = buildingTargets(b).length;
  const speedPct = Math.round((1 - effectiveSpeedMs(b) / def.harvestSpeedMs) * 100);
  const bonus = effectiveMaxTargets(b) + " / +" + speedPct + "%";
  const status = tools <= 0 ? "Idle - no tools" : (targets > 0 ? "Working" : "Idle - no targets");
  const poolMovable = poolMovableForHut(b);
  const hutMov = hutMovable(b);
  const qtyMax = Math.max(1, poolMovable, hutMov);

  if (tools !== panelState.tools) {
    el("tc-bpanel-tools").textContent = tools;
    el("tc-bpanel-deposit").disabled = poolMovable <= 0;
    el("tc-bpanel-withdraw").disabled = hutMov <= 0;
    panelState.tools = tools;
  }
  if (qtyMax !== panelState.qtyMax) {
    const slider = el("tc-bpanel-qty");
    slider.max = String(qtyMax);
    if (+slider.value > qtyMax) slider.value = String(qtyMax);
    el("tc-bpanel-qty-val").textContent = slider.value;
    panelState.qtyMax = qtyMax;
  }
  if (bonus !== panelState.bonus) { el("tc-bpanel-bonus").textContent = bonus; panelState.bonus = bonus; }
  setReceive(stored);
  if (produced !== panelState.produced) { el("tc-bpanel-produced").textContent = produced; panelState.produced = produced; }
  if (rate !== panelState.rate) { el("tc-bpanel-rate").textContent = rate + " / min"; panelState.rate = rate; }
  if (targets !== panelState.targets) { el("tc-bpanel-targets").textContent = targets; panelState.targets = targets; }
  if (status !== panelState.status) { el("tc-bpanel-status").textContent = status; panelState.status = status; }
}

function setReceive(stored) {
  if (stored === panelState.stored) return;
  const btn = el("tc-bpanel-receive");
  btn.disabled = stored <= 0;
  el("tc-bpanel-receive-text").textContent = stored > 0 ? "Receive " + stored : "Receive";
  panelState.stored = stored;
}

// --- Forge (smelter) panel body --------------------------------------
// Built when a forge is selected: an amount-step selector, one deposit/withdraw
// row per ore type, a fuel deposit row, and one Receive button per output ingot.
// The step picks how much each +/- moves (1/10/100, or All = everything available
// for that action); each deposit/withdraw clamps to what's actually on hand.
let forgeRefs = null;
let forgeStepMode = 10;                       // 1 | 10 | 100 | "all"; persists across opens
const FORGE_STEPS = [1, 10, 100, "all"];
function buildForgeRows(b) {
  const host = el("tc-forge-rows");
  host.innerHTML = "";
  forgeRefs = { id: b.id, ore: {}, fuel: null, recv: {} };
  const def = GD.buildings[b.type];
  const fuelRes = def.fuelResource;

  // Step selector: how much each +/- button moves.
  const steps = document.createElement("div");
  steps.className = "tc-forge-steps";
  const chips = [];
  for (const s of FORGE_STEPS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tc-forge-step" + (s === forgeStepMode ? " active" : "");
    chip.textContent = s === "all" ? "All" : "+" + s;
    chip.addEventListener("click", () => {
      forgeStepMode = s;
      for (const c of chips) c.classList.toggle("active", c === chip);
    });
    chips.push(chip);
    steps.appendChild(chip);
  }
  host.appendChild(steps);

  // One deposit/withdraw row per smeltable ore.
  for (const res of forgeOreTypes(b)) {
    const row = document.createElement("div");
    row.className = "tc-bpanel-row tc-forge-row";
    const label = document.createElement("span");
    label.className = "tc-bpanel-label";
    label.innerHTML = `<img class="tc-bpanel-inline-icon" src="${GD.resources[res].icon}" /> ${GD.resources[res].name}`;
    const val = document.createElement("span"); val.className = "tc-bpanel-val";
    const wd = document.createElement("button"); wd.type = "button"; wd.className = "tc-btn tc-forge-mini"; wd.textContent = "-";
    const dep = document.createElement("button"); dep.type = "button"; dep.className = "tc-btn tc-forge-mini"; dep.textContent = "+";
    dep.addEventListener("click", () => {
      const amt = forgeStepMode === "all" ? (G.world[res] | 0) : forgeStepMode;
      if (depositOre(b.id, res, amt) > 0) saveWorld();
    });
    wd.addEventListener("click", () => {
      const amt = forgeStepMode === "all" ? forgeFreeOre(b, res) : forgeStepMode;
      if (withdrawOre(b.id, res, amt) > 0) saveWorld();
    });
    const ctrls = document.createElement("span"); ctrls.className = "tc-forge-ctrls"; ctrls.append(val, wd, dep);
    row.append(label, ctrls);
    host.appendChild(row);
    forgeRefs.ore[res] = val;
  }

  // Fuel row (deposit only - burned fuel can't be withdrawn).
  const frow = document.createElement("div");
  frow.className = "tc-bpanel-row tc-forge-row";
  const fl = document.createElement("span"); fl.className = "tc-bpanel-label";
  fl.innerHTML = `<img class="tc-bpanel-inline-icon" src="${GD.resources[fuelRes].icon}" /> Fuel`;
  const fv = document.createElement("span"); fv.className = "tc-bpanel-val";
  const fdep = document.createElement("button"); fdep.type = "button"; fdep.className = "tc-btn tc-forge-mini"; fdep.textContent = "+";
  fdep.addEventListener("click", () => {
    const amt = forgeStepMode === "all" ? (G.world[fuelRes] | 0) : forgeStepMode;
    if (depositFuel(b.id, amt) > 0) saveWorld();
  });
  const fctrls = document.createElement("span"); fctrls.className = "tc-forge-ctrls"; fctrls.append(fv, fdep);
  frow.append(fl, fctrls);
  host.appendChild(frow);
  forgeRefs.fuel = fv;

  // One Receive button per distinct output ingot (collects just that ingot).
  const outs = [];
  for (const ore of forgeOreTypes(b)) { const ing = GD.resources[ore].smeltTo; if (ing && outs.indexOf(ing) < 0) outs.push(ing); }
  for (const ing of outs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tc-btn tc-primary tc-forge-receive";
    const img = document.createElement("img"); img.className = "tc-bpanel-inline-icon"; img.src = GD.resources[ing].icon;
    const txt = document.createElement("span");
    btn.append(img, txt);
    btn.addEventListener("click", () => { if (receiveResources(b.id, ing) > 0) { saveWorld(); } });
    host.appendChild(btn);
    forgeRefs.recv[ing] = { btn, txt };
  }
}
function refreshForgePanel(b) {
  if (!forgeRefs || forgeRefs.id !== b.id) buildForgeRows(b);
  for (const res of Object.keys(forgeRefs.ore)) forgeRefs.ore[res].textContent = b.oreStored[res] | 0;
  forgeRefs.fuel.textContent = Math.floor(b.fuel);
  for (const ing of Object.keys(forgeRefs.recv)) {
    const n = b.ingots[ing] | 0;
    const r = forgeRefs.recv[ing];
    r.txt.textContent = n > 0 ? `Receive ${GD.resources[ing].name} (${n})` : `Receive ${GD.resources[ing].name}`;
    r.btn.disabled = n <= 0;
  }
  const busy = !!b.smelt;
  const status = busy ? "Working" : (anyOre(b) ? (b.fuel > 0 ? "Working" : "Idle - no fuel") : "Idle - no input");
  if (status !== panelState.status) { el("tc-bpanel-status").textContent = status; panelState.status = status; }
}
function anyOre(b) { for (const res of forgeOreTypes(b)) if ((b.oreStored[res] | 0) > 0) return true; return false; }

// --- Event messages --------------------------------------------------
// A transient toast stack above the craft/build buttons. Identical consecutive
// messages are de-duped within a short window so holding the mouse on a
// too-tough vein does not spam. Each line fades out via CSS then is removed.
let lastEventText = "", lastEventAt = -100000;
export function postEvent(text) {
  if (!eventsEl) return;
  // Throttle repeats of the same message (G.animTime is ms).
  if (text === lastEventText && (G.animTime - lastEventAt) < 1500) return;
  lastEventText = text; lastEventAt = G.animTime;
  const line = document.createElement("div");
  line.className = "tc-event";
  line.textContent = text;
  eventsEl.appendChild(line);
  // Cap visible lines.
  while (eventsEl.childElementCount > 4) eventsEl.removeChild(eventsEl.firstChild);
  setTimeout(() => { line.classList.add("tc-event-out"); }, 2600);
  setTimeout(() => { if (line.parentElement) line.parentElement.removeChild(line); }, 3200);
}
