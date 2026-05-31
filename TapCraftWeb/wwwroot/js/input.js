// TapCraft - pointer/camera input, hold-to-harvest, wheel zoom, parallax.
// Listeners are attached at import time, matching the original IIFE which wired
// them synchronously at startup (before init's loadImages). Moved verbatim.
"use strict";

import { PARALLAX } from "./config.js";
import { G } from "./state.js";
import { canvas } from "./dom.js";
import { screenToWorld, worldToCell, minZoom } from "./iso.js";
import { objectAt, buildingAt } from "./render.js";
import { doHarvest } from "./resources.js";
import { placeBuilding } from "./buildings.js";
import { onBuildingSelected, onBuildingPlaced } from "./ui.js";
import { resumeAudio } from "./sound.js";
import { toggleConsole } from "./console.js";

// --- Camera input (in-game only; menu overlay blocks the canvas) ------
function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
// First user gesture anywhere (incl. main-menu buttons) unlocks + starts audio.
// Browsers keep the AudioContext suspended until a gesture; this resumes it once.
window.addEventListener("pointerdown", resumeAudio);
window.addEventListener("keydown", resumeAudio);

canvas.addEventListener("pointerdown", (e) => {
  if (G.inMenu || e.button !== 0) return; // left button only
  const p = pointerPos(e);
  G.mouse.x = p.x; G.mouse.y = p.y; G.mouse.on = true;

  // Placement mode: click places the building at the snapped footprint (cursor
  // anchors the front tile). Never pans/harvests. Stays in buildMode on a bad
  // spot so the player can reposition.
  if (G.buildMode) {
    const wpt = screenToWorld(p.x, p.y);
    const front = worldToCell(wpt.x, wpt.y);
    const b = placeBuilding(G.buildMode.type, front.col - 1, front.row - 1, G.buildMode.facing);
    if (b) { G.buildMode = null; onBuildingPlaced(b); }
    return;
  }

  // A building (and no targetable object in front of it) selects it.
  const bld = buildingAt(p.x, p.y);
  if (bld && !objectAt(p.x, p.y)) {
    G.selectedBuilding = bld.id;
    onBuildingSelected(bld);
    return;
  }

  canvas.setPointerCapture(e.pointerId);
  // Pressing a harvestable object starts a harvest-hold (locked to its kind);
  // pressing empty ground/water pans the camera (and deselects any building).
  // Harvesting is disabled while the sim is paused - a click then pans instead.
  const obj = G.running ? objectAt(p.x, p.y) : null;
  if (obj) {
    G.harvesting = true;
    // Lock the hold to a CATEGORY ("tree" | "mine") so a drag keeps harvesting
    // the same family (any vein/rock counts as "mine").
    G.harvestKind = obj.mineable ? "mine" : "tree";
    doHarvest(obj);              // first harvest is immediate
    G.lastHarvestAt = G.animTime;
  } else {
    G.selectedBuilding = null;   // click on empty space deselects
    onBuildingSelected(null);
    G.panning = true;
    G.panStart = { x: e.clientX, y: e.clientY, camX: G.cam.x, camY: G.cam.y };
    canvas.classList.add("dragging");
  }
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointerPos(e);
  G.mouse.x = p.x; G.mouse.y = p.y; G.mouse.on = true;
  if (!G.panning) return;
  G.cam.x = G.panStart.camX + (e.clientX - G.panStart.x);
  G.cam.y = G.panStart.camY + (e.clientY - G.panStart.y);
});
canvas.addEventListener("pointerleave", () => { G.mouse.on = false; });
const endPan = (e) => {
  if (e && e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
  G.panning = false;
  G.harvesting = false;
  G.harvestKind = null;
  canvas.classList.remove("dragging");
};
canvas.addEventListener("pointerup", endPan);
canvas.addEventListener("pointercancel", endPan);
canvas.addEventListener("wheel", (e) => {
  if (G.inMenu) return;
  e.preventDefault();
  const p = pointerPos(e);
  const before = screenToWorld(p.x, p.y);
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  G.cam.zoom = Math.min(6, Math.max(minZoom(), G.cam.zoom * factor));
  G.cam.x = p.x - before.x * G.cam.zoom;
  G.cam.y = p.y - before.y * G.cam.zoom;
}, { passive: false });

// Parallax: drift the menu island opposite the mouse.
window.addEventListener("mousemove", (e) => {
  if (!G.inMenu) return;
  const dx = e.clientX / window.innerWidth - 0.5;
  const dy = e.clientY / window.innerHeight - 0.5;
  G.cam.x = G.parallaxBase.x - dx * PARALLAX;
  G.cam.y = G.parallaxBase.y - dy * PARALLAX;
});

// Keyboard: R rotates the placement ghost (SE<->SW); Esc cancels placement,
// or closes the selected building's panel. Ignored in the menu or while typing.
window.addEventListener("keydown", (e) => {
  // Backtick toggles the dev console from anywhere (swallow it so it doesn't
  // type into any field or fire a game key).
  if (e.key === "`" || e.key === "~") { toggleConsole(); e.preventDefault(); return; }
  // While the console is open, the input owns the keyboard; no game shortcuts.
  if (G.consoleOpen) return;
  if (G.inMenu) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
  if (e.key === "r" || e.key === "R") {
    if (G.buildMode) G.buildMode.facing = G.buildMode.facing === "SE" ? "SW" : "SE";
  } else if (e.key === "Escape") {
    if (G.buildMode) { G.buildMode = null; }
    else if (G.selectedBuilding) { G.selectedBuilding = null; onBuildingSelected(null); }
  }
});
