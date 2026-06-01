// TapCraft - entry module (home page).
// Reproduces the original IIFE bootstrap: load the game-content pack, wire UI,
// size the canvas, install the global listeners and autosave, then load images
// and start the loop.
// Importing ./input.js here attaches the pointer/camera listeners at startup,
// matching the original (which wired them synchronously before init()).
"use strict";

import { AUTOSAVE_MS } from "./config.js";
import { G } from "./state.js";
import { loadGameData } from "./gamedata.js";
import { loadImages, buildMasks, buildShadows } from "./assets.js";
import { glCanvas } from "./dom.js";
import { initGL, uploadAtlas } from "./gl/glrender.js";
import { buildAtlas } from "./gl/atlas.js";
import { wireUi, resizeCanvas, fitMenu, showMainMenu } from "./ui.js";
import { saveWorld } from "./persistence.js";
import { frame } from "./sim.js";
import { initAudio, loadSounds } from "./sound.js";
import "./input.js";
import "./console.js";

// Visible hard-fail when the content pack can't be loaded and there's no cache.
// Without data the game can't run, so we never reach wireUi() with an empty GD.
function showDataError() {
  const m = document.createElement("div");
  m.className = "no-script-message";
  m.textContent = "Failed to load game data. Check your connection and reload.";
  document.body.appendChild(m);
}

// --- Init -------------------------------------------------------------
async function init() {
  // Content data must be present before wireUi() (builds the craft panel from
  // recipes) and before loadImages()/showMainMenu() (read sprite paths + gen).
  try {
    await loadGameData();
  } catch (e) {
    console.error("TapCraft: could not load game data", e);
    showDataError();
    return;
  }

  wireUi();
  // Create the WebGL2 context before the first resizeCanvas (which sizes #tc-gl + sets the
  // GL viewport). Falls back to the 2D renderer if WebGL2 is unavailable.
  const glOk = initGL(glCanvas);
  resizeCanvas();
  // Build the audio graph now (GD.sounds is loaded); it stays suspended until
  // the first user gesture (resumeAudio in input.js). Decode sounds in parallel
  // with images - non-blocking, and the game runs fine if any clip fails.
  initAudio();
  loadSounds();
  // Right-click is blocked on the canvas; also use it to cancel a placement.
  document.addEventListener("contextmenu", (e) => { if (G.buildMode) G.buildMode = null; e.preventDefault(); });
  window.addEventListener("resize", () => { resizeCanvas(); if (G.inMenu) fitMenu(); });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { saveWorld(); G.lastTime = 0; G.acc = 0; }
  });
  window.addEventListener("beforeunload", saveWorld);
  setInterval(saveWorld, AUTOSAVE_MS);

  loadImages().then(() => {
    buildMasks();
    buildShadows();
    // Build the single runtime atlas from the now-loaded sprites + baked shadows, upload it
    // as the GL texture, and enable the WebGL world renderer BY DEFAULT. render() falls back
    // to the 2D path automatically if WebGL2 is unavailable or the context is lost; the
    // `gl on/off` console command toggles it (hook for a future Graphics options setting).
    if (glOk) { const atlas = buildAtlas(); uploadAtlas(atlas); G.useGL = !!atlas; }
    showMainMenu();
    requestAnimationFrame(frame);
  });
}

init();
