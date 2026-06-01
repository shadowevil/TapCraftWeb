// TapCraft - environment: the day/night cycle + weather (the weather system).
// Owns the time-of-day phase and the weather state, and derives the scene
// tint/brightness, object-shadow strength, cloud coverage, rain level, and which
// ambience set (day/night) should play. Cosmetic only.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { setAmbienceMode } from "./sound.js";

let lastNight = null;

// --- Per-world settings (persisted in G.world.settings) ---------------
// Each reader falls back to the gamedata default so old saves / the menu-preview
// world (settings may be undefined) behave exactly as before.
function ws() { return (G.world && G.world.settings) || null; }
// Weather-change interval [min,max] ms, scaled by the per-world weatherFreq, which
// is an AVERAGE-MINUTES target: the gamedata min/max window is rescaled so its
// midpoint lands on weatherFreq*60000 (keeping the same min:max spread ratio).
function weatherInterval() {
  const cw = GD.weather || {};
  const dmin = cw.changeMinMs || 90000, dmax = cw.changeMaxMs || 240000;
  const s = ws(), freq = s && typeof s.weatherFreq === "number" && isFinite(s.weatherFreq) ? s.weatherFreq : 0;
  if (freq > 0) {
    const mid = freq * 60000;
    const dmid = (dmin + dmax) / 2 || 1;
    const k = mid / dmid;
    return { min: dmin * k, max: dmax * k };
  }
  return { min: dmin, max: dmax };
}
function rollInterval() { const iv = weatherInterval(); return iv.min + Math.random() * (iv.max - iv.min); }
// Real-time ms the LIT half of the cycle (sunrise..sunset) should take: per-world
// dayMinutes if set, else GD.daynight.dayMs, else half the full cycle.
function dayHalfMs() {
  const s = ws(), dn = GD.daynight || {};
  if (s && typeof s.dayMinutes === "number" && isFinite(s.dayMinutes) && s.dayMinutes > 0) return s.dayMinutes * 60000;
  if (typeof dn.dayMs === "number" && dn.dayMs > 0) return dn.dayMs;
  return (dn.cycleMs || 960000) / 2;
}
// Real-time ms the DARK half (sunset..sunrise) should take: per-world nightMinutes
// if set, else GD.daynight.nightMs, else half the full cycle.
function nightHalfMs() {
  const s = ws(), dn = GD.daynight || {};
  if (s && typeof s.nightMinutes === "number" && isFinite(s.nightMinutes) && s.nightMinutes > 0) return s.nightMinutes * 60000;
  if (typeof dn.nightMs === "number" && dn.nightMs > 0) return dn.nightMs;
  return (dn.cycleMs || 960000) / 2;
}
// Full day/night cycle length (ms) = day half + night half. Kept for any callers
// that want the total (none in-tree currently, but exported behavior preserved).
function cycleMs() { return dayHalfMs() + nightHalfMs(); }
// True when the time-of-day phase `t` is in the LIT half (sunrise 0.25 .. sunset
// 0.75). Matches sunElev() >= 0; the complement is the dark half.
function isDayPhase(t) { return t >= 0.25 && t < 0.75; }
// Per-world weight for a weather kind, falling back to the state's own weight.
function weightFor(kind, fallback) {
  const s = ws();
  if (s && s.weights && typeof s.weights[kind] === "number" && isFinite(s.weights[kind])) return s.weights[kind];
  return fallback;
}

// Sun "elevation" proxy from the time-of-day phase (0=midnight .. 0.5=noon):
//   -1 deep night .. 0 at sunrise/sunset .. +1 at noon.
function sunElev() { return -Math.cos((G.world.timeOfDay || 0) * Math.PI * 2); }

// --- Weather ----------------------------------------------------------
// A simple state machine: every changeMin..MaxMs we re-roll a target weather
// (weighted by GD.weather.states), and the live cloud/rain levels EASE toward that
// target so transitions are gradual. State lives on G.world.weather (not persisted -
// it just re-rolls fresh on load). Frozen while paused (updateEnv runs in the tick).
function weatherState() {
  if (!G.world.weather) G.world.weather = { kind: "clear", cloud: 0.12, rain: 0, tcloud: 0.12, train: 0, timer: 0 };
  return G.world.weather;
}
function rollWeather(w) {
  const states = (GD.weather && GD.weather.states) || [];
  if (!states.length) return;
  // Weighted pick using the per-world weights (fallback to each state's own weight).
  let total = 0; for (const s of states) total += weightFor(s.kind, s.weight || 1);
  if (total <= 0) total = states.length; // all weights zeroed -> uniform, never divide-by-zero
  let x = Math.random() * total, pick = states[states.length - 1];
  for (const s of states) { x -= weightFor(s.kind, s.weight || 1); if (x <= 0) { pick = s; break; } }
  w.kind = pick.kind; w.tcloud = pick.cloud || 0; w.train = pick.rain || 0;
  w.timer = rollInterval();
}

// Advance time of day + weather. Called from the sim tick, so it pauses with the
// game and runs at a fixed rate. A full day = daynight.cycleMs.
export function updateEnv(dtMs) {
  const dn = GD.daynight;
  if (dn) {
    // Non-uniform advance: each HALF of the cycle (lit [0.25,0.75), dark otherwise)
    // consumes its own configured real-time minutes. The per-ms phase increment for
    // the current half = 0.5 / (halfMs), so a half always covers exactly 0.5 of the
    // phase in its configured time regardless of the other half's length.
    const prev = G.world.timeOfDay || 0;
    const halfMs = isDayPhase(prev) ? dayHalfMs() : nightHalfMs();
    let t = prev + dtMs * (0.5 / Math.max(1, halfMs));
    // A "new day" begins at the midnight wrap (phase crosses 1 -> 0). One full loop
    // can span at most one wrap per call (dt is a single tick), so a simple
    // wrapped-below-previous test is sufficient.
    let wrapped = false;
    if (t >= 1) { t -= Math.floor(t); wrapped = true; }
    G.world.timeOfDay = t;
    if (wrapped) G.world.day = (G.world.day | 0 || 1) + 1; // increment the day counter on the midnight wrap
    const night = sunElev() < 0;
    if (night !== lastNight) { lastNight = night; setAmbienceMode(night ? "night" : "day"); }
  }
  const cw = GD.weather;
  if (cw) {
    const w = weatherState();
    w.timer -= dtMs;
    if (w.timer <= 0) rollWeather(w);
    const k = Math.min(1, dtMs / (cw.easeMs || 16000)); // ease live levels toward the target
    w.cloud += (w.tcloud - w.cloud) * k;
    w.rain += (w.train - w.rain) * k;
  }
}

// Current weather levels (0..1). cloud = sky coverage, rain = downpour strength.
export function weatherCloud() { return weatherState().cloud; }
export function weatherRain() { return weatherState().rain; }
export function weatherKind() { return weatherState().kind; }
// Extra scene darkening from overcast/rain, added on top of the day/night tint.
export function weatherDim() {
  const cw = GD.weather; if (!cw) return 0;
  const w = weatherState();
  const d = w.cloud * (cw.cloudDim || 0) + w.rain * (cw.rainDim || 0);
  return Math.max(0, Math.min(cw.maxDim != null ? cw.maxDim : 0.42, d));
}
// Force a named weather immediately (dev console). Returns false if unknown.
export function setWeather(kind) {
  const states = (GD.weather && GD.weather.states) || [];
  const s = states.find((x) => x.kind === kind);
  if (!s) return false;
  const w = weatherState();
  w.kind = s.kind; w.tcloud = s.cloud || 0; w.train = s.rain || 0;
  w.timer = rollInterval();
  return true;
}
export function weatherKinds() { return ((GD.weather && GD.weather.states) || []).map((s) => s.kind); }

// 0 at deep night .. 1 at noon (daylight strength).
export function dayAmount() { return Math.max(0, Math.min(1, sunElev())); }
export function isNight() { return sunElev() < 0; }

// Object-shadow alpha multiplier: faint at night (moonlight), full at midday.
export function shadowMul() {
  const dn = GD.daynight, nm = (dn && dn.nightShadowMul != null) ? dn.nightShadowMul : 0.4;
  return nm + (1 - nm) * dayAmount();
}

// The scene tint overlay {r,g,b,a} for the current time, or null. Interpolated
// across the data-defined keyframes (GD.daynight.tint, keyed by phase 0..1, with
// 0 and 1 endpoints supplied so any time is bracketed).
export function envTint() {
  const keys = GD.daynight && GD.daynight.tint;
  if (!keys || keys.length < 2) return null;
  const t = G.world.timeOfDay || 0;
  let lo = keys[0], hi = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].at && t <= keys[i + 1].at) { lo = keys[i]; hi = keys[i + 1]; break; }
  }
  const span = hi.at - lo.at, f = span > 0 ? (t - lo.at) / span : 0;
  return {
    r: Math.round(lo.r + (hi.r - lo.r) * f),
    g: Math.round(lo.g + (hi.g - lo.g) * f),
    b: Math.round(lo.b + (hi.b - lo.b) * f),
    a: lo.a + (hi.a - lo.a) * f,
  };
}
