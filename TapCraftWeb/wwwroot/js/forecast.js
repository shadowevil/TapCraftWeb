// TapCraft - forecast widget: a small HUD panel under the playback buttons showing the
// conditions in the player's area - current weather (condition / cloud / rain) plus the
// local climate (temperature, moisture, biome) sampled around the view centre. The values
// change slowly, so it refreshes on a throttle and writes the DOM only when a field
// actually changes (no per-frame churn).
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { el } from "./dom.js";
import { viewCenterCell } from "./iso.js";
import { weatherKind, weatherCloud, weatherRain } from "./env.js";
import { temperatureAt, moistureAt, biomeAt } from "./cells.js";

const REFRESH_MS = 500; // conditions drift slowly; refresh ~2x/sec
let lastAt = -1e9;
let refs = null;
const shown = {}; // last value written per field (dirty check)

function ensureRefs() {
  if (refs) return refs;
  refs = {
    box: el("tc-forecast"), cond: el("tc-fc-cond"),
    cloud: el("tc-fc-cloud"), rain: el("tc-fc-rain"),
    temp: el("tc-fc-temp"), moist: el("tc-fc-moist"), biome: el("tc-fc-biome"),
  };
  return refs;
}
function put(node, key, val) {
  if (!node || shown[key] === val) return;
  shown[key] = val;
  node.textContent = val;
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "-");

// Average a field over a few cells around (cc,cr) so the reading is a stable "area"
// value rather than a single twitchy cell.
function areaAvg(fn, cc, cr) {
  const o = 10;
  return (fn(cc, cr) + fn(cc - o, cr - o) + fn(cc + o, cr - o) + fn(cc - o, cr + o) + fn(cc + o, cr + o)) / 5;
}
// Descriptive labels off the climate thresholds (temperature) and moisture bands, so the
// abstract 0..1 fields read as plain English.
function tempLabel(t) {
  const cl = (GD.worldgen && GD.worldgen.climate) || {};
  if (t < (cl.snowFull != null ? cl.snowFull : 0.1)) return "Frozen";
  if (t < (cl.snowTemp != null ? cl.snowTemp : 0.34)) return "Cold";
  if (t < (cl.hotTemp != null ? cl.hotTemp : 0.55)) return "Temperate";
  if (t < (cl.hotFull != null ? cl.hotFull : 0.9)) return "Warm";
  return "Hot";
}
function moistLabel(m) {
  if (m < 0.2) return "Arid";
  if (m < 0.4) return "Dry";
  if (m < 0.6) return "Moderate";
  if (m < 0.8) return "Humid";
  return "Wet";
}

// Called from the render loop's HUD-update pass (render.js). The whole HUD-right stack is
// hidden on the menu by CSS (body.tc-menu-mode), so here we just skip sampling when there is
// no world to read, and throttle the (cheap) sampling + DOM writes.
export function updateForecast() {
  if (!G.hasWorld || G.inMenu) return;
  const r = ensureRefs();
  if (!r.box) return;
  if (G.animTime - lastAt < REFRESH_MS) return;
  lastAt = G.animTime;

  const { c: cc, r: cr } = viewCenterCell();
  put(r.cond, "cond", cap(weatherKind()));
  put(r.cloud, "cloud", Math.round(weatherCloud() * 100) + "%");
  put(r.rain, "rain", Math.round(weatherRain() * 100) + "%");
  put(r.temp, "temp", tempLabel(areaAvg(temperatureAt, cc, cr)));
  put(r.moist, "moist", moistLabel(areaAvg(moistureAt, cc, cr)));
  put(r.biome, "biome", cap(biomeAt(cc, cr)));
}
