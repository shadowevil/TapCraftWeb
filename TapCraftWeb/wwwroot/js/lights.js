// TapCraft - per-frame building-light registry (torch light).
//
// render.js rebuilds this once per frame (updateFrameLights, before the floor
// pass); everything that lights a pixel reads it per tile:
//   - the floor tint patch brightens lit tiles' RGB,
//   - the entity emitters warm-brighten sprites standing in the light,
// so the torch pool IS the world art at a higher light level - nothing is
// painted over it. Lives in its own module so ambient.js (clouds) and render.js
// can both depend on it without an import cycle.
"use strict";

export const LIGHT_BANDS = 3; // banded falloff steps (tiles + sprites quantize alike)

// Active lights this frame: {fcol, frow, reff, gain} in view-local cell space
// (columns/rows wrapped to the view centre, matching how clouds and entities
// are positioned). gain = darkness strength * flicker, so everything that reads
// the registry wavers with the flame in sync.
export const frameLights = [];

// Max light boost (0..1) for tile (c,r) across this frame's lights, quantized
// to LIGHT_BANDS steps - so an object brightens exactly as much as the floor
// tile it stands on.
export function lightBoostAt(c, r) {
  let best = 0;
  for (const Lf of frameLights) {
    const ox = c - Lf.fcol, oy = r - Lf.frow;
    const d2 = ox * ox + oy * oy;
    if (d2 > Lf.reff * Lf.reff) continue;
    const lvl = Math.ceil((1 - Math.sqrt(d2) / Lf.reff) * LIGHT_BANDS);
    if (lvl <= 0) continue;
    const v = (Math.min(LIGHT_BANDS, lvl) / LIGHT_BANDS) * Lf.gain;
    if (v > best) best = v;
  }
  return best;
}
