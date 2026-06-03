// TapCraft - globe (torus) regional weather field. On globe worlds weather is no longer
// one global state: each region derives its own from a CLIMATE-DRIVEN, time-ADVECTED noise
// field, so it varies by location, drifts across the map, and resumes exactly on reload
// (it is a pure function of position + the saved world clock G.world.tick + the seed).
// Flat / infinite worlds are unaffected - they keep the global state machine in env.js.
//
// The disturbance field is low-octave 4D value noise sampled on TWO circles (one per axis)
// so it wraps seamlessly on the torus, like the terrain fields; advection rotates the
// sample point around those circles over time. The local climate (moisture / desert) then
// shapes the disturbance into cloud cover + precipitation.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { makeFbm4 } from "./rng.js";
import { moistureAt, desertAt } from "./cells.js";

const PI2 = Math.PI * 2;
const ZERO = { cloud: 0, rain: 0, kind: "clear" };

// The noise closure AND the resolved config are rebuilt when the world (seed) changes. cols/rows
// parameterize the two wrapping circles; the rest are the GD.weather.globe tunables pre-resolved
// into plain numbers here (GD is immutable after load) so the per-cell field math - hot on the
// globe ground-wetting pass via globePrecipAt - reads locals instead of re-walking the cfg
// defaults ladder on every sample.
let wseed = -1, fbm = null, cols = 1, rows = 1;
let Rc = 1, Rr = 1, driftX = 0.05, driftY = 0.02, contrast = 1.6;
let rainThreshold = 0.58, rainGain = 1.8, moistInfluence = 0.6;
let cloudBias = 0.12, cloudGain = 1.3, moistCloud = 0.4, desertCloudCut = 0.6;
let rainKindT = 0.12, cloudyKindT = 0.5, stormKindT = 0.55;
function ensure() {
  const s = G.world.seed >>> 0;
  if (s === wseed && fbm) return;
  wseed = s;
  cols = G.world.cols || 1;
  rows = G.world.rows || 1;
  const cfg = (GD.weather && GD.weather.globe) || {};
  fbm = makeFbm4((s ^ 0x5715a9c1) >>> 0, (cfg.octaves | 0) || 2);
  Rc = (cfg.systemsX || 5) / PI2; Rr = (cfg.systemsY || 3) / PI2;
  driftX = cfg.driftX != null ? cfg.driftX : 0.05;
  driftY = cfg.driftY != null ? cfg.driftY : 0.02;
  contrast = cfg.contrast != null ? cfg.contrast : 1.6;
  rainThreshold = cfg.rainThreshold != null ? cfg.rainThreshold : 0.58;
  rainGain = cfg.rainGain || 1.8;
  moistInfluence = cfg.moistInfluence != null ? cfg.moistInfluence : 0.6;
  cloudBias = cfg.cloudBias || 0.12;
  cloudGain = cfg.cloudGain || 1.3;
  moistCloud = cfg.moistCloud != null ? cfg.moistCloud : 0.4;
  desertCloudCut = cfg.desertCloudCut != null ? cfg.desertCloudCut : 0.6;
  rainKindT = cfg.rainKind != null ? cfg.rainKind : 0.12;
  cloudyKindT = cfg.cloudyKind != null ? cfg.cloudyKind : 0.5;
  stormKindT = cfg.stormKind != null ? cfg.stormKind : 0.55;
}

// Synoptic disturbance ~0..1 at (c,r), advected by world time t (ticks). systemsX/Y set how
// many systems span each wrap (so it is resolution-independent); driftX/Y move the pattern.
function synopticAt(c, r, t) {
  const thc = PI2 * (c + driftX * t) / cols;
  const thr = PI2 * (r + driftY * t) / rows;
  const raw = fbm(Math.cos(thc) * Rc, Math.sin(thc) * Rc, Math.cos(thr) * Rr, Math.sin(thr) * Rr);
  // Value noise bunches around its midpoint; spread it around 0.5 so wet/dry regions are
  // well-defined (and storms reachable). contrast > 1 widens; clamp back to 0..1.
  const D = 0.5 + (raw - 0.5) * contrast;
  return D < 0 ? 0 : D > 1 ? 1 : D;
}

// Precip 0..1 from a disturbance value at a cell: the part of D above rainThreshold, scaled
// by rainGain, gated by local moisture (moistInfluence) and suppressed by desert.
function precipFromD(D, c, r) {
  if (D <= rainThreshold) return 0;
  let p = ((D - rainThreshold) / (1 - rainThreshold)) * rainGain;
  p *= (1 - moistInfluence + moistInfluence * moistureAt(c, r)) * (1 - desertAt(c, r));
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

// Per-cell precip only (hot path: ground wetness). One field sample + memoized climate reads.
export function globePrecipAt(c, r) {
  if (!G.world.wrapX) return 0;
  ensure();
  return precipFromD(synopticAt(c, r, G.world.tick), c, r);
}

// Full regional weather at a cell: cloud cover, precip, and a renderer "kind". Used for the
// view-centre sample (env.js drives the screen-space renderer from it) and the debug overlay.
export function globeWeatherAt(c, r) {
  if (!G.world.wrapX) return ZERO;
  ensure();
  const D = synopticAt(c, r, G.world.tick);
  const des = desertAt(c, r), moist = moistureAt(c, r);
  let cloud = cloudBias + D * cloudGain;
  cloud *= (1 - moistCloud + moistCloud * moist) * (1 - desertCloudCut * des);
  cloud = cloud < 0 ? 0 : cloud > 1 ? 1 : cloud;
  const rain = precipFromD(D, c, r);
  let kind = "clear";
  if (rain >= stormKindT) kind = "storm";
  else if (rain >= rainKindT) kind = "rain";
  else if (cloud >= cloudyKindT) kind = "cloudy";
  return { cloud, rain, kind };
}
