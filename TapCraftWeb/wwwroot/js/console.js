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
import { addTool } from "./resources.js";
import { setWeather, weatherKinds } from "./env.js";
import { glReady } from "./gl/glrender.js";

const MAX_LOG = 200; // keep memory bounded; CSS limits visible lines to ~10

// --- Command registry -------------------------------------------------
const COMMANDS = new Map();
function register(name, usage, run) { COMMANDS.set(name, { name, usage, run }); }

// Parse a positive integer argument, defaulting when absent/blank.
function intArg(v, def) {
  if (v === undefined || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

register("addresource", "addresource <wood|stone> [amount=1]", (args) => {
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

register("addtool", "addtool <hatchet|pickaxe> [amount=1]", (args) => {
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

// Toggle the live cell-inspector overlay (drawn in render.js).
register("debugoverlay", "debugoverlay <true|false>", (args) => {
  const a = (args[0] || "").toLowerCase();
  if (a === "true" || a === "on" || a === "1") G.debugOverlay = true;
  else if (a === "false" || a === "off" || a === "0") G.debugOverlay = false;
  else if (a === "") G.debugOverlay = !G.debugOverlay; // bare toggle
  else return { text: "Usage: debugoverlay <true|false>", error: true };
  return "Debug overlay " + (G.debugOverlay ? "ON" : "OFF") + ". Hover a tile to inspect it.";
});

// Toggle the WebGL2 world renderer vs the Canvas-2D fallback (for A/B during the GL
// migration). No-op if WebGL2 was unavailable at startup.
register("gl", "gl <on|off>", (args) => {
  if (!glReady()) return { text: "WebGL2 renderer unavailable; using the 2D path.", error: true };
  const a = (args[0] || "").toLowerCase();
  if (a === "on" || a === "true" || a === "1") G.useGL = true;
  else if (a === "off" || a === "false" || a === "0") G.useGL = false;
  else return { text: "Usage: gl <on|off>", error: true };
  return "WebGL renderer " + (G.useGL ? "ON" : "OFF (Canvas-2D fallback)") + ".";
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

register("help", "help", () => {
  const lines = [...COMMANDS.values()].map((c) => "  " + c.usage);
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
