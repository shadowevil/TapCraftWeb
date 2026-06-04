// TapCraft - simulation loop: growth tick, animations, the fixed-timestep RAF.
// Moved verbatim from the original game.js IIFE.
"use strict";

import {
  TICK_MS, FRAME_MS,
  POP_MS, FLY_MS,
  DROP_GRAVITY, DROP_BOUNCE, DROP_REST_VZ,
} from "./config.js";
import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { playBtn, pauseBtn } from "./dom.js";
import { viewCenterCell } from "./iso.js";
import { setStage, setProgress, setChop, clampBox, growCell } from "./cells.js";
import { PERF, pBegin, pEnd, pFps } from "./perf.js";
import { updateAmbient } from "./ambient.js";
import { updateWeather } from "./weather.js";
import { updateEnv } from "./env.js";
import { objectAt, render } from "./render.js";
import {
  doHarvest, harvestCategory, spawnDrop, flushPopDrop, collectDrop,
  dropHovered, startDropFly, renderFx, bestToolId,
} from "./resources.js";
import { advanceCrafting } from "./crafting.js";
import { updateBuildings, footprintOf } from "./buildings.js";
import { maybeSpread } from "./ecology.js";
import { updateWetness } from "./wetness.js";
import { saveWorld } from "./persistence.js";
import { setWorldAudioPaused } from "./sound.js";

// --- Simulation -------------------------------------------------------
export function tick() {
  G.world.tick++;
  updateEnv(TICK_MS); // advance the day/night cycle (pauses with the game)
  const g0 = pBegin(); growthTick(); pEnd("growth", g0);
  // Buildings harvest on the fixed sim step too, so they pause with the game
  // and stay deterministic. They run for ALL buildings regardless of viewport.
  const b0 = pBegin(); updateBuildings(TICK_MS); pEnd("buildings", b0);
  // Ground wetness: rain wets the visible ground, evaporation dries every tracked
  // tile. Pauses with the game (runs in the fixed tick). Data layer only for now.
  const w0 = pBegin(); updateWetness(TICK_MS); pEnd("wetness", w0);
}

// Growth runs on a PRIORITY RADIUS, not the whole world (an infinite / 10000x10000
// world has far too many cells to sweep). The visible viewport is grown every tick
// (exact per-tick growth); rings beyond it update less often (advanced by their
// expected gain x elapsed ticks); past the outermost band growth is frozen. Every
// building's harvest radius is also grown at full priority every tick so off-screen
// huts keep their resources regrowing and never starve.
function growthTick() {
  const t = G.world.tick;
  const g = G.world.settings.growthRate;
  const seed = G.world.seed;
  const mature = GD.matureStage;
  const stageFull = GD.worldgen.stageFull;
  const expectedGain = 0.5 * (GD.worldgen.gainMin + GD.worldgen.gainMax) / 2;
  const bands = (GD.worldgen.growth && GD.worldgen.growth.bands) || [{ radius: 40, period: 1 }];

  // One keyed lookup per cell (see cells.growCell), down from four. AMORTIZED bands
  // pass their precomputed gain (expectedGain * period); EXACT bands derive gain
  // from growthStep inside the helper. growCell's returned stage feeds the
  // ecology spread hook (mature tree = seed source, empty cell = bush source);
  // `mult` scales the spread odds the same way it scales growth, so the rate is
  // band-independent.
  const grow = (c, r, exact, mult) => {
    maybeSpread(c, r, growCell(c, r, mature, stageFull, expectedGain * mult, exact, t, seed, g), mult);
  };

  // Priority radius around the viewport CENTER: band 0 (period 1, exact growth) is
  // a capped disc; each outer band is a lower-frequency ring radiating outward;
  // past the last band growth is frozen. Bounded by the bands' radii, NOT by zoom -
  // so this stays cheap even at max zoom-out over a huge/infinite world. (Chebyshev
  // distance partitions the bands into disjoint rings; no per-cell allocation.)
  const { c: cc, r: cr } = viewCenterCell();
  let innerR = -1;
  for (const band of bands) {
    const R = band.radius | 0;
    const period = (band.period | 0) || 1;
    const exact = period === 1;
    const slice = t % period;            // which row-slice this band grows on this tick
    const box = clampBox(cc - R, cc + R, cr - R, cr + R);
    for (let r = box.r0; r <= box.r1; r++) {
      // Outer bands are AMORTIZED across their period instead of firing the whole ring on
      // one tick: each tick grows only the rows in this tick's slice (mult=period keeps the
      // per-cell gain identical), so the ring is fully covered once per `period` ticks. This
      // turns the old once-per-8 / once-per-40 BURSTS (~17k / ~45k cells in a single tick,
      // which also thrashed the cell cache and stalled the next render) into a steady
      // trickle - no periodic growth spike. Band 0 (period 1) still grows fully every tick.
      if (!exact && ((((r - cr) % period) + period) % period) !== slice) continue;
      const dr = Math.abs(r - cr);
      for (let c = box.c0; c <= box.c1; c++) {
        const cheb = Math.max(Math.abs(c - cc), dr);
        if (cheb <= innerR || cheb > R) continue; // owned by an inner band / outside this ring
        grow(c, r, exact, period);
      }
    }
    innerR = R;
  }

  // Buildings: full-priority growth across each harvester's radius, every tick,
  // wherever they are (always active, on or off screen).
  for (const b of G.world.buildings) {
    const radius = GD.buildings[b.type].harvestRadius | 0;
    if (radius <= 0) continue;
    const fp = footprintOf(b.type);
    const box = clampBox(b.col - radius, b.col + fp.w - 1 + radius, b.row - radius, b.row + fp.h - 1 + radius);
    for (let r = box.r0; r <= box.r1; r++) {
      for (let c = box.c0; c <= box.c1; c++) grow(c, r, true, 1);
    }
  }
}

// Advance pops + drop physics (visual only; real dt, runs even while paused).
export function updateAnimations(dtMs) {
  const dt = Math.min(0.05, dtMs / 1000);
  if (G.running) { updateAmbient(dtMs); updateWeather(dtMs); } // decorative FX + weather - frozen while paused (menu preview runs: it sets running=true)

  // Hold-to-harvest cadence: bare hands swing every baseSwingMs (slow); holding
  // the matching crafted tool swings at that tool's swingMs (faster). Clicking
  // (input.js) fires one full swing per click and is unthrottled, so rapid
  // clicking out-paces holding - active play is rewarded.
  // Disabled while paused (G.running) - no harvesting when the sim is stopped.
  if (G.running && G.harvesting && G.mouse.on && !G.inMenu) {
    // Cadence from the best owned tool of the held kind (trees -> hatchet,
    // mining -> pickaxe); "hand" holds (toughness-0 pickups) and bare hands
    // use baseSwingMs.
    const kind = G.harvestKind === "mine" ? "pickaxe" : G.harvestKind === "tree" ? "hatchet" : null;
    const toolId = kind ? bestToolId(G.world.tools, kind) : null;
    const interval = toolId ? GD.tools[toolId].swingMs : GD.harvest.baseSwingMs;
    if (G.animTime - G.lastHarvestAt >= interval) {
      const obj = objectAt(G.mouse.x, G.mouse.y);
      // Same category as the hold (shared classifier - keeps "hand" pickups
      // from chaining into rock mining mid-drag and vice versa).
      if (obj && harvestCategory(obj) === G.harvestKind) doHarvest(obj);
      G.lastHarvestAt = G.animTime;
    }
  }

  for (const [key, p] of G.pops) {
    const prog = (G.animTime - p.t0) / POP_MS;
    if (prog >= 0.5 && !p.dropped) {
      p.dropped = true;
      for (let i = 0; i < p.dropCount; i++) spawnDrop(p.col, p.row, p.drop);
    }
    if (prog >= 1) G.pops.delete(key);
  }

  // Crafting: advance each in-progress batch; produce one finished tool every
  // CRAFT_MS (sequential). Runs even while paused / panel closed.
  advanceCrafting(dtMs);
  // Felling timer: removes a chopped tree FOR GOOD (stage -1 = bare ground;
  // ecology.js spreading is the only way trees come back - deforestation is
  // real). Runs on its own timer, independent of the pop animation (which fast
  // clicking would otherwise keep restarting).
  for (const [key, t] of G.chopResets) {
    if (G.animTime < t) continue;
    flushPopDrop(key); // make sure the felling click's drop still emits
    const ci = key.indexOf(","), col = +key.slice(0, ci), row = +key.slice(ci + 1);
    setStage(col, row, -1);
    setProgress(col, row, 0);
    setChop(col, row, 0);
    G.chopResets.delete(key);
    G.pops.delete(key);
  }
  for (let i = G.drops.length - 1; i >= 0; i--) {
    const d = G.drops[i];
    if (d.phase === "fly") {
      if ((G.animTime - d.flyT0) / FLY_MS >= 1) {
        collectDrop(d.kind);
        // swap-remove: O(1), and safe in this back-to-front loop (the tail element
        // was already visited this frame). Drops are unordered particles.
        const last = G.drops.length - 1;
        if (i !== last) G.drops[i] = G.drops[last];
        G.drops.length = last;
      }
      continue;
    }
    d.gx += d.vx * dt;
    d.gy += d.vy * dt;
    d.vz -= DROP_GRAVITY * dt;
    d.z += d.vz * dt;
    if (d.z <= 0) {
      d.z = 0;
      if (d.vz < -DROP_REST_VZ) {
        d.vz = -d.vz * DROP_BOUNCE;
        d.vx *= 0.6; d.vy *= 0.6;
      } else {
        d.vz = 0; d.vx = 0; d.vy = 0; d.phase = "rest";
      }
    }
    if (d.phase === "rest" && !G.inMenu && G.mouse.on && dropHovered(d)) {
      startDropFly(d);
    }
  }
}

// --- Loop (20 TPS sim, <=60 FPS render) -------------------------------
export function frame(t) {
  requestAnimationFrame(frame);
  PERF.on = G.debugOverlay; // profiler is free unless the debug overlay is open
  const f0 = pBegin();
  G.animTime = t;
  if (G.lastTime === 0) G.lastTime = t;
  let dt = t - G.lastTime;
  G.lastTime = t;
  if (dt > 250) dt = 250;
  pFps(dt);
  // Camera glide (Town Hall travel): an eased tween toward the target, advanced
  // on real time so it works while paused. Cancelled by manual pan/zoom (input.js).
  if (G.camGlide) {
    const gl = G.camGlide;
    let f = (t - gl.t0) / gl.ms;
    if (f >= 1) { f = 1; G.camGlide = null; }
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2; // easeInOutQuad
    G.cam.x = gl.x0 + (gl.x1 - gl.x0) * e;
    G.cam.y = gl.y0 + (gl.y1 - gl.y0) * e;
  }
  if (G.running && G.hasWorld) {
    G.acc += dt;
    let steps = 0;
    const s0 = pBegin();
    while (G.acc >= TICK_MS && steps < 240) { tick(); G.acc -= TICK_MS; steps++; }
    pEnd("sim", s0);
  } else {
    G.acc = 0;
  }
  if (G.hasWorld) { const a0 = pBegin(); updateAnimations(dt); pEnd("anim", a0); } // pops/drops animate even while paused
  if (t - G.lastRender >= FRAME_MS - 0.5) {
    G.lastRender = t;
    const r0 = pBegin(); render(); pEnd("render", r0);
    const x0 = pBegin(); renderFx(); pEnd("fx", x0);
  }
  pEnd("frame", f0);
}

export function setRunning(on) {
  G.running = on;
  setWorldAudioPaused(!on); // pause/play also ducks the world + ambient sound (music stays)
  updatePlayPause();
  saveWorld();
}
export function updatePlayPause() {
  playBtn.disabled = G.running;
  pauseBtn.disabled = !G.running;
}
