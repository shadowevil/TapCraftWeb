// TapCraft - UI: resource counters, canvas sizing, menus and flow wiring.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { MENU_SIZE, TOPBAR_H, SUBBAR_H } from "./config.js";
import { G } from "./state.js";
import { GD } from "./gamedata.js";
import {
  el, canvas, ctx, fxCanvas, fxctx,
  resourceCountEl,
  menuBtn, craftBtn, craftPanel, craftTitlebar, craftCloseBtn,
  playBtn, pauseBtn, menuModal, mainMenuScreen, worldListEl,
  newWorldModal, confirmModal, nameInput, ui,
  buildBtn, buildHint, buildPanel, buildTitlebar, buildCloseBtn, buildListEl, buildingPanel,
  optionsModal, audioRowsEl,
} from "./dom.js";
import { fitView, buildingAnchor } from "./iso.js";
import { generate } from "./worldgen.js";
import {
  readWorldsIndex, saveWorld, loadWorld, deleteWorld, newWorldId,
} from "./persistence.js";
import { setRunning, updatePlayPause } from "./sim.js";
import { buildCraftPanel, toggleCraftPanel } from "./crafting.js";
import {
  findBuilding, demolishBuilding, buildingTargets,
  producedTotal, productionPerMin, canAffordBuilding,
} from "./buildings.js";
import {
  playSfx, getAudioSettings, setChannelVolume, setChannelMute,
} from "./sound.js";

export function updateResourceUI() {
  for (const kind of Object.keys(GD.resources)) {
    const elCount = resourceCountEl(kind);
    if (elCount) elCount.textContent = G.world[kind] | 0;
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
  fitView();
  updatePlayPause();
}

export function generateMenuWorld() {
  G.world.id = null;
  G.world.name = "";
  // Same defaults as a new world, but the menu island uses a denser forest.
  const settings = { ...GD.defaults.worldSettings, forestDensity: GD.defaults.menuForestDensity };
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
  if (G.world.id) saveWorld();        // persist the real world before leaving it
  G.inMenu = true;
  G.running = true;                   // animate the background island
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

export function askDelete(w) {
  G.pendingDelete = w;
  el("tc-confirm-text").textContent = `"${w.name}" will be permanently deleted. This can't be undone.`;
  confirmModal.classList.remove("hidden");
}

export function openNewWorld() {
  nameInput.value = suggestWorldName();
  ui.seed.value = randomSeed();
  mainMenuScreen.classList.add("hidden");
  newWorldModal.classList.remove("hidden");
}

export function createWorld() {
  const sl = GD.sliders;
  // Clamp each slider to its data-defined [min,max]/default. Percentage sliders
  // are authored 0..100 and scaled to 0..1 fractions; growth is a raw float.
  const pct = (s, key) => clampInt(s.value, sl[key].min, sl[key].max, sl[key].default) / 100;
  const size = clampInt(ui.size.value, sl.size.min, sl.size.max, sl.size.default);
  let seed = parseInt(ui.seed.value, 10);
  if (!Number.isFinite(seed)) { seed = randomSeed(); ui.seed.value = seed; }
  const settings = {
    landFraction: pct(ui.land, "land"),
    growthRate: Math.min(sl.growth.max, Math.max(sl.growth.min, Number(ui.growth.value) || sl.growth.default)),
    forestDensity: pct(ui.density, "density"),
    cluster: pct(ui.cluster, "cluster"),
    rockDensity: pct(ui.rockDensity, "rockDensity"),
    rockCluster: pct(ui.rockCluster, "rockCluster"),
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

export function wireUi() {
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
  el("tc-save").addEventListener("click", () => { saveWorld(); flashSaved(); });
  el("tc-mainmenu").addEventListener("click", () => { menuModal.classList.add("hidden"); showMainMenu(); });

  buildCraftPanel();
  craftBtn.addEventListener("click", toggleCraftPanel);
  craftCloseBtn.addEventListener("click", () => craftPanel.classList.add("hidden"));
  makeDraggable(craftPanel, craftTitlebar);

  // Build UI: a floating, draggable panel mirroring the craft panel.
  buildBtn.addEventListener("click", toggleBuildPanel);
  buildCloseBtn.addEventListener("click", () => buildPanel.classList.add("hidden"));
  makeDraggable(buildPanel, buildTitlebar);
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
  if (!buildPanel.classList.contains("hidden")) {
    buildBuildPanel();
    playSfx("door_open", "building"); // a "door opening" cue on the building menu
  }
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
}
export function closeOptions() {
  optionsModal.classList.add("hidden");
  menuModal.classList.remove("hidden"); // back to the hamburger menu
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
  if (b) showBuildingPanel(b);
  else hideBuildingPanel();
}

// The world-anchored panel: a fixed-position DOM card that tracks the selected
// building each frame and scales with the map zoom (clamped readable).
let panelState = { produced: -1, rate: -1, targets: -1, status: "" };
export function showBuildingPanel(b) {
  el("tc-bpanel-title").textContent = GD.buildings[b.type].name;
  panelState = { produced: -1, rate: -1, targets: -1, status: "" };
  buildingPanel.classList.remove("hidden");
  positionBuildingPanel();
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

  // Anchor over the building's top: use its plant point then lift by the
  // sprite height so the card floats above the roof, in full-screen coords.
  const a = buildingAnchor(b.col, b.row);
  const x = a.x;
  const y = a.y + (TOPBAR_H + SUBBAR_H);
  const scale = Math.min(1.6, Math.max(0.8, G.cam.zoom / 2));
  buildingPanel.style.left = x + "px";
  buildingPanel.style.top = y + "px";
  buildingPanel.style.transform = `translate(-50%, calc(-100% - 90px)) scale(${scale})`;

  // Update text only when values change (no per-frame innerHTML churn).
  const produced = producedTotal(b);
  const rate = productionPerMin(b);
  const targets = buildingTargets(b).length;
  const status = targets > 0 ? "Working" : "Idle - no targets";
  if (produced !== panelState.produced) { el("tc-bpanel-produced").textContent = produced; panelState.produced = produced; }
  if (rate !== panelState.rate) { el("tc-bpanel-rate").textContent = rate + " / min"; panelState.rate = rate; }
  if (targets !== panelState.targets) { el("tc-bpanel-targets").textContent = targets; panelState.targets = targets; }
  if (status !== panelState.status) { el("tc-bpanel-status").textContent = status; panelState.status = status; }
}
