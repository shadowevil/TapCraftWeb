// TapCraft - weather visuals (rain). Cosmetic only. The weather STATE lives in
// env.js (cloud/rain levels); this module renders the rain it produces and drives
// the rain audio:
//   - falling drops: a screen-space foreground layer (rain in front of the camera),
//     count proportional to the rain level, drawn over the whole world.
//   - ground splashes: small expanding rings that land ONLY on open ground tiles
//     (never on a tree/rock/ore/building/water), injected into render.js's depth-
//     sorted entity pass so nearer objects occlude them and the iso illusion holds.
// updateWeather is called from the sim's animation step ONLY while running, so rain
// freezes with the play/pause button like the other ambient FX.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { canvas, ctx } from "./dom.js";
import { visibleCellBounds, worldToScreen, cellCenter, screenToWorld } from "./iso.js";
import { HALF_W, HALF_H } from "./config.js";
import { tileAt, stageAt, rockRawAt } from "./cells.js";
import { weatherRain, weatherKind } from "./env.js";
import { cloudShadowAt, randomCloudInView } from "./ambient.js";
import { setRainAudio, playThunder, setViewSnowAudio } from "./sound.js";

let rainDrops = [], splashes = [], splashAcc = 0;
let flashes = [], strikeTimer = 0, pendingThunder = []; // lightning: active flashes + next-strike countdown + scheduled claps
const MAX_SPLASH = 260;
const CLOUD_MIN = 0.1; // rain only falls where cloud coverage exceeds this (rain comes FROM clouds)

const W = () => canvas.clientWidth || 1;
const H = () => canvas.clientHeight || 1;

// Per-world rain/storm intensity multiplier (G.world.settings.rainIntensity),
// falling back to 1 for old saves / the menu-preview world. Scales the drop
// count + splash rate so a world can be drizzly or torrential.
function rainIntensity() {
  const s = G.world && G.world.settings;
  const v = s ? s.rainIntensity : undefined;
  return (typeof v === "number" && isFinite(v) && v > 0) ? v : 1;
}

function resetDrop(d) {
  d.x = Math.random() * (W() + 200) - 100;
  d.y = -20 - Math.random() * 40;
  d.sp = 0.7 + Math.random() * 0.6; // per-drop speed variation
  d.ph = Math.random() * 6283;      // sway phase (used when it falls as snow)
}
function newDrop(spread) { const d = { x: 0, y: 0, sp: 1 }; resetDrop(d); if (spread) d.y = Math.random() * H(); return d; }

// Open ground = harvestable-free, building-free, non-water (a splash here won't
// visually collide with anything standing on the tile).
function openGround(c, r) {
  if (tileAt(c, r) === "water") return false;
  if (stageAt(c, r) >= 0) return false;  // a tree (any growth stage) is on this cell
  if (rockRawAt(c, r) >= 0) return false; // a rock / ore vein is on this cell
  for (const bd of G.world.buildings) {
    if (c >= bd.col && c <= bd.col + 1 && r >= bd.row && r <= bd.row + 1) return false; // 2x2 footprint
  }
  return true;
}

export function updateWeather(dtMs) {
  if (!GD.weather || !G.hasWorld) return;
  // No weather FX on the main-menu preview (the day/night tint is skipped there too,
  // so rain/splashes without the dimming would look out of place); clear any carryover.
  if (G.inMenu) { if (rainDrops.length || splashes.length) { rainDrops.length = 0; splashes.length = 0; } setRainAudio(0); return; }
  const dt = Math.min(0.05, dtMs / 1000);
  // Deserts are dry: thin the live rainfall (drops + splashes + audio) where the view is desert.
  const dcut = (GD.worldgen && GD.worldgen.climate && GD.worldgen.climate.desertRainCut != null) ? GD.worldgen.climate.desertRainCut : 0.8;
  const rain = weatherRain() * (1 - (G.viewDesert || 0) * dcut);
  setRainAudio(rain); // rain overlay + bird-ambience duck follow the live rain level
  setViewSnowAudio(G.viewSnow || 0); // snowy view: bird ambience down, wind gusts up

  const cfg = GD.weather.rain || {};
  const intensity = rainIntensity();
  const h = H(), w = W();
  // Falling drops (screen-space): keep the active count proportional to rain,
  // scaled by the per-world intensity.
  const target = Math.round((cfg.drops || 0) * rain * intensity);
  while (rainDrops.length < target) rainDrops.push(newDrop(true));
  if (rainDrops.length > target) rainDrops.length = target;
  // Snow: in the cold (globe) view the same precipitation falls SLOWER and SWAYS instead
  // of streaking down. `snow` (0..1) crossfades the motion + look between rain and snow.
  const snow = G.viewSnow || 0;
  const scfg = GD.weather.snow || {};
  const fallMul = 1 - snow * (1 - (scfg.fallMul != null ? scfg.fallMul : 0.42));
  const drift = (scfg.drift != null ? scfg.drift : 34) * snow;
  const sp = cfg.speed || 1500, slant = cfg.slant || 0.22;
  for (const d of rainDrops) {
    d.y += sp * d.sp * fallMul * dt;
    d.x += sp * d.sp * slant * dt * (1 - snow) + Math.sin((G.animTime + d.ph) * 0.002) * drift * dt;
    if (d.y > h + 24 || d.x > w + 24 || d.x < -24) resetDrop(d);
  }

  // Ground splashes: spawn on open ground UNDER A CLOUD in view, at a rain-scaled
  // rate; expire after splashMs.
  // Snow barely splashes - fade the ground splashes out as the view gets snowy.
  splashAcc += rain * (cfg.splashRate || 0) * intensity * dt * (1 - snow * (1 - (scfg.splashMul != null ? scfg.splashMul : 0.12)));
  const b = visibleCellBounds();
  const dur = cfg.splashMs || 430;
  let guard = 0;
  while (splashAcc >= 1 && splashes.length < MAX_SPLASH && guard++ < 16) {
    splashAcc -= 1;
    for (let i = 0; i < 10; i++) {
      const c = b.c0 + ((Math.random() * (b.c1 - b.c0 + 1)) | 0);
      const r = b.r0 + ((Math.random() * (b.r1 - b.r0 + 1)) | 0);
      if (!openGround(c, r)) continue;
      const cc = cellCenter(c, r);
      if (cloudShadowAt(cc.x, cc.y) < CLOUD_MIN) continue; // only under clouds
      // A single rain "hit" on a tile = 0..5 separate droplets, each at its own
      // spot on the tile, with its own ring size and a small stagger.
      const n = (Math.random() * 6) | 0;
      if (n > 0) {
        const drops = [];
        for (let k = 0; k < n; k++) {
          const rr = Math.random() * 0.72, ang = Math.random() * Math.PI * 2; // point inside the tile diamond
          drops.push({ ou: rr * Math.cos(ang), ov: rr * Math.sin(ang), scale: 0.5 + Math.random() * 0.9, delay: Math.random() * dur * 0.35 });
        }
        splashes.push({ c, r, t0: G.animTime, drops });
      }
      break;
    }
  }
  for (let i = splashes.length - 1; i >= 0; i--) if (G.animTime - splashes[i].t0 >= dur * 1.4) splashes.splice(i, 1);

  // --- Lightning (storm only) ---
  // Storms in the cold become snowstorms: suppress lightning above noLightningView snowiness.
  const ln = GD.weather.lightning;
  if (ln && weatherKind() === "storm" && snow < (scfg.noLightningView != null ? scfg.noLightningView : 0.5)) {
    strikeTimer -= dtMs;
    if (strikeTimer <= 0) {
      strikeTimer = (ln.strikeGapMinMs || 2500) + Math.random() * ((ln.strikeGapMaxMs || 9000) - (ln.strikeGapMinMs || 2500));
      strike(ln);
    }
  } else {
    strikeTimer = 0; // primed so a strike can happen right as a storm begins
  }
  for (let i = flashes.length - 1; i >= 0; i--) if (G.animTime - flashes[i].t0 >= flashes[i].dur) flashes.splice(i, 1);
  for (let i = pendingThunder.length - 1; i >= 0; i--) {
    if (G.animTime >= pendingThunder[i].at) { playThunder(pendingThunder[i].vol); pendingThunder.splice(i, 1); }
  }
}

// One lightning strike: a flash under a random in-view cloud, plus a thunder clap
// scheduled by distance from the viewport center (farther = quieter + later, like
// the sound lagging the light). The specific clap (and its level) is random in sound.js.
function strike(ln) {
  const c = randomCloudInView();
  if (!c) return;
  flashes.push({
    wx: c.wx, wy: c.wy, r: c.r, phase: c.phase, phase2: c.phase2, t0: G.animTime,
    dur: (ln.flashMinMs || 240) + Math.random() * ((ln.flashMaxMs || 520) - (ln.flashMinMs || 240)),
    peak: (ln.peakMin || 0.45) + Math.random() * ((ln.peakMax || 0.95) - (ln.peakMin || 0.45)),
  });
  const s = worldToScreen(c.wx, c.wy);
  const cx = (canvas.clientWidth || 1) / 2, cy = (canvas.clientHeight || 1) / 2;
  const maxd = Math.hypot(cx, cy) || 1, dist = Math.min(maxd, Math.hypot(s.x - cx, s.y - cy));
  const near = 1 - dist / maxd;
  const minV = ln.minVol != null ? ln.minVol : 0.25, maxV = ln.maxVol != null ? ln.maxVol : 1;
  pendingThunder.push({ at: G.animTime + (dist / maxd) * (ln.maxDelayMs || 1600), vol: minV + (maxV - minV) * near });
}

// Lightning flash: briefly LIGHTS UP THE TILES around the cloud in additive white.
// It covers MORE than the shadow (radius = cloud radius x flashSpread) and falls off
// smoothly with distance - brightest at the cloud center, dimmer toward the edge -
// quantized into bands so it can batch-fill. Alpha is scaled so tiles/objects brighten
// but stay visible (no white-out). Cheap: flashes are brief + rare (usually 0-1 active).
const FLASH_BANDS = 5;
export function renderLightning() {
  if (!flashes.length) return;
  const z = G.cam.zoom, hw = HALF_W * z, hh = HALF_H * z;
  const spread = (GD.weather.lightning && GD.weather.lightning.flashSpread) || 1.7;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const fl of flashes) {
    const p = (G.animTime - fl.t0) / fl.dur;
    if (p < 0 || p > 1) continue;
    const env = fl.peak * (1 - p) * (0.8 + 0.2 * Math.sin(p * 60)); // fade + flicker
    if (env <= 0.004) continue;
    const fcol = fl.wx / (2 * HALF_W) + fl.wy / (2 * HALF_H);
    const frow = fl.wy / (2 * HALF_H) - fl.wx / (2 * HALF_W);
    const ccol = Math.round(fcol), crow = Math.round(frow);
    const Rext = fl.r * spread, RR = Math.ceil(Rext) + 1;
    const bands = [];
    for (let i = 0; i < FLASH_BANDS; i++) bands.push(new Path2D());
    for (let dr = -RR; dr <= RR; dr++) {
      for (let dc = -RR; dc <= RR; dc++) {
        const col = ccol + dc, row = crow + dr;
        const ox = col - fcol, oy = row - frow, d = Math.hypot(ox, oy);
        if (d >= Rext) continue;
        const factor = 1 - d / Rext;            // 1 at the center -> 0 at the edge
        const bi = Math.min(FLASH_BANDS - 1, (factor * FLASH_BANDS) | 0);
        const cc = cellCenter(col, row), s = worldToScreen(cc.x, cc.y);
        const pth = bands[bi];
        pth.moveTo(s.x, s.y - hh); pth.lineTo(s.x + hw, s.y); pth.lineTo(s.x, s.y + hh); pth.lineTo(s.x - hw, s.y); pth.closePath();
      }
    }
    for (let bi = 0; bi < FLASH_BANDS; bi++) {
      const a = env * ((bi + 1) / FLASH_BANDS) * 0.62; // brighter bands toward the center
      if (a <= 0.004) continue;
      ctx.fillStyle = "rgba(245, 248, 255, " + a.toFixed(3) + ")";
      ctx.fill(bands[bi]);
    }
  }
  ctx.restore();
}

// Falling-drop layer, drawn in render.js's overlay phase (in front of the world).
export function renderRain() {
  if (!GD.weather || !rainDrops.length) return;
  const cfg = GD.weather.rain || {};
  const snow = G.viewSnow || 0;
  ctx.save();
  // Rain streaks: fade out as the view gets snowy.
  if (snow < 0.985) {
    const col = cfg.color || [165, 190, 230];
    const len = cfg.length || 20, slant = cfg.slant || 0.22;
    ctx.strokeStyle = "rgba(" + col[0] + ", " + col[1] + ", " + col[2] + ", " + ((cfg.alpha != null ? cfg.alpha : 0.28) * (1 - snow)).toFixed(3) + ")";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of rainDrops) {
      const wp = screenToWorld(d.x, d.y);
      if (cloudShadowAt(wp.x, wp.y) < CLOUD_MIN) continue; // drops only show under clouds (world-anchored)
      ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - slant * len, d.y - len);
    }
    ctx.stroke();
  }
  // Snow flakes: fade in as the view gets snowy (drawn as soft round dots, batched in one fill).
  if (snow > 0.015) {
    const scfg = GD.weather.snow || {};
    const col = scfg.color || [236, 243, 255], size = (scfg.size != null ? scfg.size : 1.7);
    ctx.fillStyle = "rgba(" + col[0] + ", " + col[1] + ", " + col[2] + ", " + ((scfg.alpha != null ? scfg.alpha : 0.7) * snow).toFixed(3) + ")";
    ctx.beginPath();
    for (const d of rainDrops) {
      const wp = screenToWorld(d.x, d.y);
      if (cloudShadowAt(wp.x, wp.y) < CLOUD_MIN) continue;
      ctx.moveTo(d.x + size, d.y); ctx.arc(d.x, d.y, size, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

// Active splashes for render.js to inject into its depth-sorted entity pass.
export function activeSplashes() { return splashes; }

// Draw a ground splash: its cluster of droplets, each an expanding+fading ring
// flattened to the iso ground, at its own spot/size/stagger within the tile.
export function drawSplash(c, r, sp, z) {
  if (!sp.drops || !sp.drops.length) return;
  const cfg = GD.weather.rain || {};
  const dur = cfg.splashMs || 430;
  const col = cfg.splashColor || [205, 225, 250];
  const cc = cellCenter(c, r), s = worldToScreen(cc.x, cc.y);
  ctx.save();
  ctx.lineWidth = Math.max(1, z * 0.4);
  for (const d of sp.drops) {
    const p = (G.animTime - sp.t0 - d.delay) / dur;
    if (p < 0 || p > 1) continue;
    const a = (1 - p) * 0.45;
    const rad = (1.5 + p * 5) * z * d.scale;
    const x = s.x + d.ou * HALF_W * z, y = s.y + d.ov * HALF_H * z; // offset within the tile diamond
    ctx.strokeStyle = "rgba(" + col[0] + ", " + col[1] + ", " + col[2] + ", " + a.toFixed(3) + ")";
    ctx.beginPath();
    ctx.ellipse(x, y, rad, rad * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
