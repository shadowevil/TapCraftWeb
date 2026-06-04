// TapCraft - developer console overlay + command registry.
// A centered, modal overlay (toggle with backtick) for dev/debug commands. It
// blocks game interaction while open. The output log grows upward above the
// input, capped by CSS to ~10 visible lines then scrolls. Adding a command is
// one register(...) call: { name, usage, run(args) -> string | {text,error} }.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { consoleOverlay, consoleLogEl, consoleInput } from "./dom.js";
import { updateResourceUI } from "./ui.js";
import { addTool, toolDurabilityFor } from "./resources.js";
import { updateCraftedHud } from "./crafting.js";
import { setWeather, weatherKinds } from "./env.js";
import { wetStatus } from "./wetness.js";
import { glReady } from "./gl/glrender.js";

const MAX_LOG = 200; // keep memory bounded; CSS limits visible lines to ~10

// --- Command registry -------------------------------------------------
// `usage` may be a FUNCTION: registry-driven commands (addresource/addtool) build
// their usage line from GD at help-time, so new content (hoes, bucket, wheat, ...)
// is listed automatically with no console edit. GD is empty until the pack loads,
// hence the `|| {}` guards in those usages.
const COMMANDS = new Map();
function register(name, usage, run) { COMMANDS.set(name, { name, usage, run }); }
const usageOf = (c) => (typeof c.usage === "function" ? c.usage() : c.usage);

// Parse a positive integer argument, defaulting when absent/blank.
function intArg(v, def) {
  if (v === undefined || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

register("addresource", () => "addresource <" + Object.keys(GD.resources || {}).join("|") + "> [amount=1]", (args) => {
  if (!G.hasWorld) return { text: "No active world.", error: true };
  const kind = args[0];
  if (!kind || !GD.resources[kind]) {
    return { text: "Unknown resource '" + (kind || "") + "'. Valid: " + Object.keys(GD.resources).join(", "), error: true };
  }
  const n = intArg(args[1], 1);
  if (!Number.isFinite(n) || n <= 0) return { text: "Amount must be a positive integer.", error: true };
  G.world[kind] = (G.world[kind] | 0) + n;
  updateResourceUI();
  return "Added " + n + " " + kind + " (total " + G.world[kind] + ").";
});

register("addtool", () => "addtool <" + Object.keys(GD.tools || {}).join("|") + "> [amount=1]", (args) => {
  if (!G.hasWorld) return { text: "No active world.", error: true };
  const type = args[0];
  if (!type || !GD.tools[type]) {
    return { text: "Unknown tool '" + (type || "") + "'. Valid: " + Object.keys(GD.tools).join(", "), error: true };
  }
  const n = intArg(args[1], 1);
  if (!Number.isFinite(n) || n <= 0) return { text: "Amount must be a positive integer.", error: true };
  for (let i = 0; i < n; i++) addTool(type);
  return "Added " + n + " " + GD.tools[type].name + " (count " + G.world.tools[type].count + ").";
});

// Move buckets between the empty and filled stacks (farming dev: test watering
// without a lake). No durability is spent - this is a free dev transfer.
register("bucket", "bucket <fill|empty> [amount=1]", (args) => {
  if (!G.hasWorld) return { text: "No active world.", error: true };
  const a = (args[0] || "").toLowerCase();
  if (a !== "fill" && a !== "empty") return { text: "Usage: bucket <fill|empty> [amount=1]", error: true };
  const n = intArg(args[1], 1);
  if (!Number.isFinite(n) || n <= 0) return { text: "Amount must be a positive integer.", error: true };
  const tools = G.world.tools;
  const fromId = a === "fill" ? "bucket" : "bucket_water";
  const toId = a === "fill" ? "bucket_water" : "bucket";
  const from = tools[fromId];
  if (!from || from.count <= 0) {
    return { text: a === "fill" ? "No empty buckets. Try: addtool bucket" : "No filled buckets.", error: true };
  }
  const to = tools[toId] || (tools[toId] = { count: 0, dura: 0 });
  let moved = 0;
  while (moved < n && from.count > 0) {
    const d = from.dura;
    from.count -= 1;
    from.dura = from.count > 0 ? toolDurabilityFor(fromId) : 0;
    to.count += 1;
    if (to.count === 1) to.dura = d; // first arrival becomes the active instance
    moved++;
  }
  updateCraftedHud();
  return "Moved " + moved + " bucket(s) to the " + (a === "fill" ? "filled" : "empty") + " stack (" +
    ((tools.bucket && tools.bucket.count) | 0) + " empty / " + ((tools.bucket_water && tools.bucket_water.count) | 0) + " filled).";
});

// Toggle the live cell-inspector overlay (drawn in render.js).
register("debugoverlay", "debugoverlay <true|false>", (args) => {
  const a = (args[0] || "").toLowerCase();
  if (a === "true" || a === "on" || a === "1") G.debugOverlay = true;
  else if (a === "false" || a === "off" || a === "0") G.debugOverlay = false;
  else if (a === "") G.debugOverlay = !G.debugOverlay; // bare toggle
  else return { text: "Usage: debugoverlay <true|false>", error: true };
  return "Debug overlay " + (G.debugOverlay ? "ON" : "OFF") + ". Hover a tile to inspect it.";
});

// Historical: the Canvas-2D world fallback (and this toggle) were removed when
// the game went WebGL-only. Kept as a stub so muscle memory gets an answer.
register("gl", "gl", () => {
  return "The Canvas-2D world renderer was removed - TapCraft is WebGL-only now (status: " + (glReady() ? "healthy" : "context lost, restoring") + ").";
});

// Jump the day/night cycle to a named time of day (dev/testing). Sets the phase
// directly; the tint/shadows update instantly and the day/night ambience swaps on
// the next sim tick while the game is running.
const TIMES = { sunrise: 0.25, morning: 0.36, noon: 0.50, afternoon: 0.62, evening: 0.72, dusk: 0.78, night: 0.92 };
register("settime", "settime <" + Object.keys(TIMES).join("|") + ">", (args) => {
  if (!G.hasWorld) return { text: "No active world.", error: true };
  const key = (args[0] || "").toLowerCase();
  if (!(key in TIMES)) return { text: "Unknown time '" + (args[0] || "") + "'. Valid: " + Object.keys(TIMES).join(", "), error: true };
  G.world.timeOfDay = TIMES[key];
  const h = Math.floor(TIMES[key] * 24), m = Math.floor((TIMES[key] * 24 - h) * 60);
  return "Time set to " + key + " (" + (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m) + ").";
});

register("setweather", "setweather <clear|cloudy|rain|storm>", (args) => {
  if (!G.hasWorld) return { text: "No active world.", error: true };
  const k = (args[0] || "").toLowerCase();
  if (!setWeather(k)) return { text: "Unknown weather '" + (args[0] || "") + "'. Valid: " + weatherKinds().join(", "), error: true };
  return "Weather set to " + k + " (eases in over a few seconds).";
});

// Inspect the ground-wetness state (data-only layer): count of tracked wet tiles
// and the wetness at the current view-center cell.
register("wet", "wet", () => {
  if (!G.hasWorld) return { text: "No active world.", error: true };
  const s = wetStatus();
  return "Ground wetness: " + s.count + " wet tiles. Center (" + s.c + "," + s.r + ") = " + Math.round(s.centerWet * 100) + "%.";
});

register("help", "help", () => {
  const lines = [...COMMANDS.values()].map((c) => "  " + usageOf(c));
  return "Commands:\n" + lines.join("\n");
});

// --- Log -------------------------------------------------------------
function pushLine(text, error) {
  G.consoleLog.push({ text, error: !!error });
  if (G.consoleLog.length > MAX_LOG) G.consoleLog.splice(0, G.consoleLog.length - MAX_LOG);
}
function renderLog() {
  consoleLogEl.innerHTML = "";
  for (const line of G.consoleLog) {
    const div = document.createElement("div");
    div.className = "tc-console-line" + (line.error ? " tc-console-error" : (line.echo ? " tc-console-echo" : ""));
    div.textContent = line.text;
    consoleLogEl.appendChild(div);
  }
  consoleLogEl.scrollTop = consoleLogEl.scrollHeight; // newest pinned by the input
}

// --- Run --------------------------------------------------------------
function runCommand(raw) {
  const input = raw.trim();
  if (!input) return;
  G.consoleHistory.push(input);
  G.consoleLog.push({ text: "> " + input, echo: true });
  const parts = input.split(/\s+/);
  const cmd = COMMANDS.get(parts[0].toLowerCase());
  if (!cmd) {
    pushLine("Unknown command '" + parts[0] + "'. Type 'help'.", true);
  } else {
    let res;
    try { res = cmd.run(parts.slice(1)); }
    catch (e) { res = { text: "Error: " + e.message, error: true }; }
    if (res && typeof res === "object") {
      for (const part of String(res.text).split("\n")) pushLine(part, res.error);
    } else if (typeof res === "string") {
      for (const part of res.split("\n")) pushLine(part, false);
    }
  }
  renderLog();
}

// --- Open / close -----------------------------------------------------
export function openConsole() {
  if (G.consoleOpen) return;
  G.consoleOpen = true;
  consoleOverlay.classList.remove("hidden");
  renderLog();
  consoleInput.value = "";
  consoleInput.focus();
}
export function closeConsole() {
  if (!G.consoleOpen) return;
  G.consoleOpen = false;
  consoleOverlay.classList.add("hidden");
  consoleInput.blur();
}
export function toggleConsole() { if (G.consoleOpen) closeConsole(); else openConsole(); }

// --- Input wiring -----------------------------------------------------
let historyIdx = -1; // -1 = current (not browsing history)
consoleInput.addEventListener("keydown", (e) => {
  // The console input owns the keyboard while focused: stop the event reaching
  // the window-level game-key handler (prevents backtick double-toggle and
  // Escape leaking into build-cancel).
  e.stopPropagation();
  if (e.key === "Enter") {
    runCommand(consoleInput.value);
    consoleInput.value = "";
    historyIdx = -1;
    e.preventDefault();
  } else if (e.key === "Escape") {
    closeConsole();
    e.preventDefault();
  } else if (e.key === "`" || e.key === "~") {
    // Backtick toggles the console - don't type it into the input.
    closeConsole();
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    const h = G.consoleHistory;
    if (h.length) {
      historyIdx = historyIdx < 0 ? h.length - 1 : Math.max(0, historyIdx - 1);
      consoleInput.value = h[historyIdx];
      e.preventDefault();
    }
  } else if (e.key === "ArrowDown") {
    const h = G.consoleHistory;
    if (historyIdx >= 0) {
      historyIdx++;
      if (historyIdx >= h.length) { historyIdx = -1; consoleInput.value = ""; }
      else consoleInput.value = h[historyIdx];
      e.preventDefault();
    }
  }
});
// Clicks inside the box keep focus in the input; the overlay backdrop swallows
// clicks (it is above the canvas) so the game behind never receives them.
consoleOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === consoleOverlay) consoleInput.focus();
});
