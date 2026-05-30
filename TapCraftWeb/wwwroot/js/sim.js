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
import { growthStep } from "./rng.js";
import { objectAt, render } from "./render.js";
import {
  doHarvest, spawnDrop, flushPopDrop, collectDrop,
  dropHovered, startDropFly, renderFx,
} from "./resources.js";
import { advanceCrafting } from "./crafting.js";
import { updateBuildings } from "./buildings.js";
import { saveWorld } from "./persistence.js";

// --- Simulation -------------------------------------------------------
export function tick() {
  G.world.tick++;
  const g = G.world.settings.growthRate;
  const seed = G.world.seed;
  const t = G.world.tick;
  const rows = G.world.rows, cols = G.world.cols;
  for (let r = 0; r < rows; r++) {
    const stRow = G.world.stage[r];
    const pRow = G.world.progress[r];
    for (let c = 0; c < cols; c++) {
      const st = stRow[c];
      if (st < 0 || st >= GD.matureStage) continue;
      const gain = growthStep(c, r, t, seed);
      if (gain <= 0) continue;
      pRow[c] += gain * g;
      if (pRow[c] >= GD.worldgen.stageFull) { stRow[c] = st + 1; pRow[c] = 0; }
    }
  }
  // Buildings harvest on the fixed sim step too, so they pause with the game
  // and stay deterministic. Visual pops/drops still animate on real dt below.
  updateBuildings(TICK_MS);
}

// Advance pops + drop physics (visual only; real dt, runs even while paused).
export function updateAnimations(dtMs) {
  const dt = Math.min(0.05, dtMs / 1000);

  // Hold-to-harvest: every HARVEST_INTERVAL_MS, harvest the object under the
  // cursor IF it matches the kind locked in when the hold began. Other kinds
  // (and empty cells) are ignored, so a drag sweeps one resource type.
  // Disabled while paused (G.running) - no harvesting when the sim is stopped.
  if (G.running && G.harvesting && G.mouse.on && !G.inMenu && G.animTime - G.lastHarvestAt >= GD.worldgen.harvestIntervalMs) {
    const obj = objectAt(G.mouse.x, G.mouse.y);
    if (obj && obj.kind === G.harvestKind) doHarvest(obj);
    G.lastHarvestAt = G.animTime;
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
  // Felling timer: reliably reverts a chopped tree to a sprout, independent
  // of the pop animation (which fast clicking would otherwise keep restarting).
  for (const [key, t] of G.chopResets) {
    if (G.animTime < t) continue;
    flushPopDrop(key); // make sure the felling click's drop still emits
    const col = key % G.world.cols, row = (key - col) / G.world.cols;
    G.world.stage[row][col] = 0;
    G.world.progress[row][col] = 0;
    G.world.chop[row][col] = 0;
    G.chopResets.delete(key);
    G.pops.delete(key);
  }
  for (let i = G.drops.length - 1; i >= 0; i--) {
    const d = G.drops[i];
    if (d.phase === "fly") {
      if ((G.animTime - d.flyT0) / FLY_MS >= 1) { collectDrop(d.kind); G.drops.splice(i, 1); }
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
  G.animTime = t;
  if (G.lastTime === 0) G.lastTime = t;
  let dt = t - G.lastTime;
  G.lastTime = t;
  if (dt > 250) dt = 250;
  if (G.running && G.hasWorld) {
    G.acc += dt;
    let steps = 0;
    while (G.acc >= TICK_MS && steps < 240) { tick(); G.acc -= TICK_MS; steps++; }
  } else {
    G.acc = 0;
  }
  if (G.hasWorld) updateAnimations(dt); // pops/drops animate even while paused
  if (t - G.lastRender >= FRAME_MS - 0.5) { G.lastRender = t; render(); renderFx(); }
}

export function setRunning(on) {
  G.running = on;
  updatePlayPause();
  saveWorld();
}
export function updatePlayPause() {
  playBtn.disabled = G.running;
  pauseBtn.disabled = !G.running;
}
