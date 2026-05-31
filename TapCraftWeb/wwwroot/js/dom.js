// TapCraft - DOM references.
// These run at import time. ES module scripts are deferred, so the page DOM
// already exists when this evaluates (same timing the original IIFE relied on).
// Moved verbatim from the original game.js IIFE.
"use strict";

// --- DOM --------------------------------------------------------------
export const canvas = document.getElementById("tc-canvas");
export const ctx = canvas.getContext("2d");
export const fxCanvas = document.getElementById("tc-fx");
export const fxctx = fxCanvas.getContext("2d");
export const el = (id) => document.getElementById(id);
// Resource bar lookups by resource id (wood, stone, ...). The bar markup in
// Index.cshtml uses the ids tc-<kind>-icon / tc-<kind>-count by convention.
export const resourceIconEl = (kind) => document.getElementById("tc-" + kind + "-icon");
export const resourceCountEl = (kind) => document.getElementById("tc-" + kind + "-count");
export const resourceBarEl = (kind) => {
  const icon = resourceIconEl(kind);
  return icon ? icon.parentElement : null;
};

export const menuBtn = el("tc-menu-btn");
export const craftBtn = el("tc-craft-btn");
export const buildBtn = el("tc-build-btn");
export const buildHint = el("tc-build-hint");
export const buildPanel = el("tc-build-panel");
export const buildTitlebar = el("tc-build-titlebar");
export const buildCloseBtn = el("tc-build-close");
export const buildListEl = el("tc-build-list");
export const buildingPanel = el("tc-building-panel");
export const craftedHud = el("tc-crafted");
export const craftPanel = el("tc-craft-panel");
export const craftTitlebar = el("tc-craft-titlebar");
export const craftCloseBtn = el("tc-craft-close");
export const craftListEl = el("tc-craft-list");
export const playBtn = el("tc-play");
export const pauseBtn = el("tc-pause");
export const menuModal = el("tc-menu");
export const optionsModal = el("tc-options-modal");
export const audioRowsEl = el("tc-audio-rows");
export const eventsEl = el("tc-events");
export const consoleOverlay = el("tc-console-overlay");
export const consoleLogEl = el("tc-console-log");
export const consoleInput = el("tc-console-input");
export const mainMenuScreen = el("tc-mainmenu-screen");
export const worldListEl = el("tc-world-list");
export const newWorldModal = el("tc-newworld");
export const confirmModal = el("tc-confirm");
export const nameInput = el("tc-name");

export const ui = {
  size: el("tc-size"), sizeVal: el("tc-size-val"),
  land: el("tc-land"), landVal: el("tc-land-val"),
  growth: el("tc-growth"), growthVal: el("tc-growth-val"),
  density: el("tc-density"), densityVal: el("tc-density-val"),
  cluster: el("tc-cluster"), clusterVal: el("tc-cluster-val"),
  rockDensity: el("tc-rock-density"), rockDensityVal: el("tc-rock-density-val"),
  rockCluster: el("tc-rock-cluster"), rockClusterVal: el("tc-rock-cluster-val"),
  mineral: el("tc-mineral"), mineralVal: el("tc-mineral-val"),
  bugs: el("tc-bugs"), bugsVal: el("tc-bugs-val"),
  birds: el("tc-birds"), birdsVal: el("tc-birds-val"),
  clouds: el("tc-clouds"), cloudsVal: el("tc-clouds-val"),
  weatherFreq: el("tc-weather-freq"), weatherFreqVal: el("tc-weather-freq-val"),
  dayMinutes: el("tc-day-minutes"), dayMinutesVal: el("tc-day-minutes-val"),
  rainIntensity: el("tc-rain-intensity"), rainIntensityVal: el("tc-rain-intensity-val"),
  weightClear: el("tc-weight-clear"), weightClearVal: el("tc-weight-clear-val"),
  weightCloudy: el("tc-weight-cloudy"), weightCloudyVal: el("tc-weight-cloudy-val"),
  weightRain: el("tc-weight-rain"), weightRainVal: el("tc-weight-rain-val"),
  weightStorm: el("tc-weight-storm"), weightStormVal: el("tc-weight-storm-val"),
  infinite: el("tc-infinite"),
  seed: el("tc-seed"),
};
