// TapCraft - ground wetness: a per-tile state (0 = bone dry .. 1 = saturated) that
// rises when rain falls on a tile and falls via evaporation (faster in sun + heat,
// slower in humid air). DATA LAYER ONLY for now - nothing renders or reads it yet;
// it is the foundation a later puddles/mud/growth/fire system can build on.
//
// Stored SPARSELY as a nested overlay (Map<col, Map<row, wetness>>), keyed by
// CANONICAL coords (so a globe's wrapped copies share one value), holding only
// non-dry tiles (entries are dropped once they dry out). Advanced from the sim tick:
// while it is raining the ground ACCUMULATES water over time, gradually, where rain
// actually falls (rain comes FROM clouds, so wetting is gated to tiles under cloud
// cover); then a drying pass gradually evaporates every tracked tile. On top of that,
// tiles near water carry a baseline dampness whose strength AND reach grow with the size
// of the nearby water body (see waterBaseline). Cost stays bounded on huge / infinite
// worlds. Phase 2 will drive per-cell precipitation from the globe weather field.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { HALF_W, HALF_H } from "./config.js";
import { wrapCol, wrapRow, moistureAt, temperatureAt, tileAt, modsSize } from "./cells.js";
import { visibleCellBounds, viewCenterCell } from "./iso.js";
import { weatherRain, dayAmount } from "./env.js";
import { cloudShadowAt } from "./ambient.js";
import { hash01 } from "./rng.js";
import { globePrecipAt } from "./globeweather.js";

const WET_MIN = 0.002;  // below this a tile counts as dry and is dropped from storage
const CLOUD_MIN = 0.1;  // rain (and thus wetting) only where cloud coverage exceeds this
const EMPTY = {};        // fallback wettable map (old packs) -> every surface defaults to wettable

// --- Sparse storage (nested Map, canonical integer keys) ---------------------
export function createWet() { return new Map(); }
// Raw STORED (rain-accumulated) wetness for a cell, 0 if untracked. The wetting/drying
// passes work on this; consumers call wetnessAt, which adds the water-proximity baseline.
function storedAt(c, r) {
  const m = G.world.wet;
  if (!m || m.size === 0) return 0;
  const cm = m.get(wrapCol(c));
  if (cm === undefined) return 0;
  const w = cm.get(wrapRow(r));
  return w === undefined ? 0 : w;
}
// Baseline dampness a (wettable, non-water) tile gets from nearby water. Sums the
// surrounding water tiles out to radius R with an INVERSE-SQUARE distance weight: a big
// body (many tiles) keeps the sum significant several tiles out, so it radiates further,
// while a 1x1 / 2x2 pond's few tiles fade within a tile or two - so the effective radius
// GROWS WITH BODY SIZE, hard-capped at R. The sum is squashed toward `cap` (75% when ringed
// by a large body) and dithered per tile so the damp falloff is not a perfectly uniform band.
function waterBaseline(c, r, wettable, cap, R, k, dither) {
  if (cap <= 0) return 0;
  const t = tileAt(c, r);
  if (t === "water" || wettable[t] === false) return 0; // only wettable land soaks ambient moisture
  let sum = 0;
  const R2 = R * R;
  for (let dr = -R; dr <= R; dr++) {
    for (let dc = -R; dc <= R; dc++) {
      const d2 = dc * dc + dr * dr;
      if (d2 === 0 || d2 > R2) continue;
      if (tileAt(c + dc, r + dr) === "water") sum += 1 / d2; // closer + more water -> larger sum
    }
  }
  if (sum <= 0) return 0;
  let v = cap * (1 - Math.exp(-sum * k));                            // saturating: lone pond tiny, big body -> cap
  if (dither < 1) v *= dither + (1 - dither) * hash01(c, r, G.world.seed ^ 0x7e7d); // per-tile variation
  return v;
}
// Effective wetness 0..1 = stored rain accumulation + the water-proximity baseline.
// NOTE: waterBaseline scans a (2R+1)^2 neighbourhood, so today this is only called for
// inspection (debug overlay / `wet`). A future consumer reading it across the viewport
// should precompute a water-distance field rather than call this per visible cell.
export function wetnessAt(c, r) {
  const g = GD.weather && GD.weather.ground;
  let v = storedAt(c, r);
  if (g && (g.waterDampCap || 0) > 0) {
    const wettable = (GD.worldgen.terrain && GD.worldgen.terrain.wettable) || EMPTY;
    const R = (g.waterDampRadius | 0) || 6, k = g.waterDampK || 0.4;
    const dither = g.waterDampDither != null ? g.waterDampDither : 1;
    v += waterBaseline(c, r, wettable, g.waterDampCap, R, k, dither);
  }
  return v > 1 ? 1 : v;
}
// Get-or-create the column map and store the clamped value. Shared by the live setter and the
// save loader (both pass FINAL canonical keys - no wrapping happens here).
function putWet(m, col, row, v) {
  let cm = m.get(col);
  if (cm === undefined) { cm = new Map(); m.set(col, cm); }
  cm.set(row, v > 1 ? 1 : v);
}
// Set (clamped 0..1); values at/below WET_MIN remove the tile from the overlay.
function setWetness(m, c, r, v) {
  const col = wrapCol(c), row = wrapRow(r);
  if (v <= WET_MIN) {
    const cm = m.get(col);
    if (cm) { cm.delete(row); if (cm.size === 0) m.delete(col); }
    return;
  }
  putWet(m, col, row, v);
}
export function wetnessSize(m) { return m ? modsSize(m) : 0; }

// --- Persistence (flat ["c,r", wetness] array, like the cell overlay) --------
export function wetToEntries(m) {
  const out = [];
  if (m) for (const [c, cm] of m) for (const [r, w] of cm) out.push([c + "," + r, +w.toFixed(3)]);
  return out;
}
export function wetFromEntries(arr) {
  const m = new Map();
  if (Array.isArray(arr)) {
    for (const pair of arr) {
      const w = +pair[1];
      if (!(w > WET_MIN)) continue;
      const k = "" + pair[0], ci = k.indexOf(",");
      putWet(m, +k.slice(0, ci), +k.slice(ci + 1), w);
    }
  }
  return m;
}

// Precip rate (0..1) actually reaching a tile right now. GLOBE: the per-cell regional
// weather field (climate-driven, spatially varying). FLAT / INFINITE: the global rain
// level, gated to where clouds are overhead (rain falls under clouds, matching the visuals).
function precipAt(c, r) {
  if (G.world.wrapX) return globePrecipAt(c, r);
  const rain = weatherRain();
  if (rain <= 0.001) return 0;
  const wx = (c - r) * HALF_W, wy = (c + r) * HALF_H; // cell center in world px (no alloc)
  return cloudShadowAt(wx, wy) > CLOUD_MIN ? rain : 0;
}

// Advance ground wetness one sim step (called from sim.tick, so it pauses with the
// game). Wetting pass over the visible region while raining, then a drying pass.
//
// Evaporation rate per tile = dryRate * sun * humidityDamp * heat, where sun (day vs
// night) and the globe flag are frame-constant (hoisted), and humidity (all worlds)
// + heat (globe temperature bands only) vary per tile.
export function updateWetness(dtMs) {
  if (!G.hasWorld) return;
  const g = GD.weather && GD.weather.ground;
  if (!g) return;
  // Amortize: wetness changes slowly and is data-only, so run the passes once every `period`
  // ticks with the accumulated dt instead of every tick (the sim can run several ticks per
  // frame, and the wetting pass - a globe weather-field sample per cell - is the costly part).
  const period = (g.period | 0) || 4;
  if (G.world.tick % period !== 0) return;
  const m = G.world.wet || (G.world.wet = createWet());
  const dt = (dtMs * period) / 1000;

  // Wetting: only when there is rain to deposit (a no-op in clear weather). Skips water tiles.
  if (weatherRain() > 0.001) {
    // Region = the visible box, CAPPED to a radius around the view centre, so the cost does not
    // explode when zoomed out (wetness has no visuals yet, so bounding it is invisible).
    const vb = visibleCellBounds();
    const R = (g.simRadius | 0) || 40;
    const cc = (vb.c0 + vb.c1) >> 1, cr = (vb.r0 + vb.r1) >> 1;
    const c0 = Math.max(vb.c0, cc - R), c1 = Math.min(vb.c1, cc + R);
    const r0 = Math.max(vb.r0, cr - R), r1 = Math.min(vb.r1, cr + R);
    const gain = g.wetGain;
    const wettable = (GD.worldgen.terrain && GD.worldgen.terrain.wettable) || EMPTY;
    // Precip is a LOW-FREQUENCY field, so sample it once per `block` cells along a row (one
    // expensive globe-noise / cloud lookup per block instead of per cell) and reuse it.
    const block = (g.precipBlock | 0) || 4;
    for (let r = r0; r <= r1; r++) {
      const br = Math.floor(r / block) * block;
      let lastBc = 2e9, p = 0;
      for (let c = c0; c <= c1; c++) {
        const bc = Math.floor(c / block) * block;
        if (bc !== lastBc) { lastBc = bc; p = precipAt(bc, br); }
        if (p <= 0) continue;
        const t = tileAt(c, r);
        if (t === "water" || wettable[t] === false) continue; // water + non-soaking surfaces stay dry
        setWetness(m, c, r, storedAt(c, r) + p * gain * dt);   // accumulate the rain part (baseline added in wetnessAt)
      }
    }
  }

  // Drying: every tracked tile loses moisture by its local rate; dropped once dry.
  if (m.size) {
    const sun = g.dryNight + (1 - g.dryNight) * dayAmount();    // night (dryNight) .. noon (1)
    const base = g.dryRate * sun * dt;                          // frame-constant part
    const damp = g.dryMoistDamp, coldMul = g.dryColdMul, globe = !!G.world.wrapX;
    for (const [col, cm] of m) {
      for (const [row, w] of cm) {
        let rate = base * (1 - damp * moistureAt(col, row));     // humid air -> slower
        if (globe) rate *= coldMul + (1 - coldMul) * temperatureAt(col, row); // cold band -> slower
        const nw = w - rate;
        if (nw <= WET_MIN) cm.delete(row);
        else cm.set(row, nw);
      }
      if (cm.size === 0) m.delete(col);
    }
  }
}

// Debug/inspection (console `wet`, debug overlay): count of wet tiles + the value
// at the current view-center cell.
export function wetStatus() {
  const m = G.world.wet;
  const { c: cc, r: cr } = viewCenterCell();
  return { count: wetnessSize(m), c: cc, r: cr, centerWet: wetnessAt(cc, cr) };
}
