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
import { saveWorld, saveWorldNow } from "./persistence.js";
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
// Visible hard-fail when WebGL2 is unavailable. The world renders exclusively
// through WebGL (the Canvas-2D world path was removed); without it the game
// cannot draw, so stop at boot with a clear message instead of a black screen.
function showGLError() {
  const m = document.createElement("div");
  m.className = "no-script-message";
  m.textContent = "TapCraft needs WebGL2, which this browser/device has disabled or does not support. Try enabling hardware acceleration or a current browser.";
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

  // The game is WebGL-only: create the GL context first and hard-fail with a
  // visible message if WebGL2 is unavailable (no 2D world fallback anymore).
  if (!initGL(glCanvas)) {
    showGLError();
    return;
  }
  wireUi();
  resizeCanvas(); // sizes #tc-gl + sets the GL viewport
  // Build the audio graph now (GD.sounds is loaded); it stays suspended until
  // the first user gesture (resumeAudio in input.js). Decode sounds in parallel
  // with images - non-blocking, and the game runs fine if any clip fails.
  initAudio();
  loadSounds();
  // Right-click is blocked on the canvas; also use it to cancel a placement.
  document.addEventListener("contextmenu", (e) => { if (G.buildMode) G.buildMode = null; e.preventDefault(); });
  window.addEventListener("resize", () => { resizeCanvas(); if (G.inMenu) fitMenu(); });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { saveWorldNow(); G.lastTime = 0; G.acc = 0; } // sync: tab may be closing
  });
  window.addEventListener("beforeunload", saveWorldNow); // sync: a debounced flush would not run
  setInterval(saveWorld, AUTOSAVE_MS);

  loadImages().then(() => {
    buildMasks();
    buildShadows();
    // Build the single runtime atlas from the now-loaded sprites + baked shadows
    // and upload it as the GL texture. If the context is lost mid-session,
    // render() pauses the world with a notice until contextrestored re-uploads.
    uploadAtlas(buildAtlas());
    showMainMenu();
    requestAnimationFrame(frame);
  });
}

init();
