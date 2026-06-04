// TapCraft - ambient cosmetic FX: drifting clouds, birds, and bugs.
// PURELY decorative - no gameplay effect, no world interaction. Counts/speeds are
// data-tuned via GD.ambient. Clouds are SIMULATED here (drift/recycle/lump shape)
// but no longer painted: render.js queries cloudShadeAt(c, r) per tile and folds
// the shade into each tile's (and its object's) RGB light tint.
//
// Everything is WORLD-ANCHORED (positioned in world coords, drawn via worldToScreen)
// so it scrolls with the terrain as you pan; items DESPAWN/recycle once they leave
// the viewport (+margin), with fresh ones in view. Clouds + birds scale with the map
// (size x camera zoom). BUGS are always 1px (true bug-sized at any zoom).
//
// Bugs use a loose ATTRACTANT model: a few "swarm" centers wander but steer back
// toward LAND; each bug is independently pulled toward its swarm center (a damped
// spring) plus its own random jitter, with per-bug variation - so they mill about
// non-uniformly inside a general cluster, each leaving a gentle fading pixel trail.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { HALF_W, HALF_H, SHADOW_SKEW, SHADOW_SQUASH } from "./config.js";
import { canvas, ctx } from "./dom.js";
import { screenToWorld, worldToScreen, worldToCell, cellCenter } from "./iso.js";
import { tileAt, snownessAt } from "./cells.js";
import { dayAmount, weatherCloud, weatherRain } from "./env.js";

let clouds = [], birds = [], swarms = [], moonbeams = [], inited = false;
let cloudField = []; // per-frame cloud snapshot (centers + lump + shade) - rain coverage AND tile-shade queries
let windAng = 0, windTarget = 0, windTimer = 0; // shared cloud wind, EASED toward windTarget; re-rolled on a timer
let cloudSizeMul = 1; // live per-frame radius scale: clouds swell toward storm-sized as the rain rises (clouds.rainSize)

const OFFSCREEN_M = 120;       // despawn margin (screen px) beyond the viewport
const DEFAULT_WIND_SWITCH = 300000; // 5 min between wind-direction changes
const BUG_SPAWN_R = 26;  // initial bug scatter around its swarm (world px)

// RGB triplets (alpha applied per draw, so head + trail can fade independently).
const BUG_COLORS = [
  "255, 246, 205", // pale yellow
  "255, 222, 178", // peach
  "200, 240, 255", // pale blue
  "200, 255, 205", // pale green
];

const W = () => canvas.clientWidth || 1;
const H = () => canvas.clientHeight || 1;
// canvas.clientWidth/Height are layout-touching DOM reads. The per-particle offscreen
// tests call them for every cloud/swarm/bird/beam each frame; cache them once per
// updateAmbient (refreshed at the top of that function) and read the cache in the
// hot loops. Default 0 falls back to a live read for the rare off-frame caller.
let frameW = 0, frameH = 0;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr, i, d) => (Array.isArray(arr) ? arr[i] : (arr != null ? arr : d));

// Per-world override reader: returns G.world.settings[key] when present (a real
// number), otherwise the supplied fallback. Guards undefined settings (the menu-
// preview world / very old saves) so ambient FX always have a count to target.
function wsNum(key, fallback) {
  const s = G.world && G.world.settings;
  const v = s ? s[key] : undefined;
  return (typeof v === "number" && isFinite(v)) ? v : fallback;
}
// Total target bug population for this world (per-world override or data default).
// On a globe, bugs thin out toward the frozen biome (G.viewSnow).
function bugTotal() {
  const n = wsNum("bugs", (GD.ambient.bugs && GD.ambient.bugs.count) | 0);
  return G.world.wrapX ? Math.round(n * (1 - (G.viewSnow || 0) * 0.9)) : n;
}
// Cloud-count budget (per-world override or data default).
function cloudBudget() { return wsNum("cloudCount", (GD.ambient.clouds && GD.ambient.clouds.count) || 5); }
// Bird population cap (per-world override or data default). On a globe, birds all but
// vanish in the snowy biome (G.viewSnow) - the view fades to just wind.
function birdMax() {
  const m = wsNum("birds", (GD.ambient.birds && GD.ambient.birds.max) | 0);
  return G.world.wrapX ? Math.round(m * (1 - (G.viewSnow || 0) * 0.95)) : m;
}

function nearLand(col, row) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (tileAt(col + dc, row + dr) !== "water") return true;
    }
  }
  return false;
}
function landSpawnWorld() {
  const w = W(), h = H();
  for (let i = 0; i < 40; i++) {
    const wpt = screenToWorld(rand(w * 0.12, w * 0.88), rand(h * 0.12, h * 0.88));
    const cell = worldToCell(wpt.x, wpt.y);
    if (nearLand(cell.col, cell.row)) return { wx: wpt.x, wy: wpt.y };
  }
  return null;
}
function offscreen(wx, wy, m) {
  const s = worldToScreen(wx, wy), mm = m || OFFSCREEN_M;
  const w = frameW || W(), h = frameH || H();
  return s.x < -mm || s.x > w + mm || s.y < -mm || s.y > h + mm;
}

// --- Clouds (world-anchored shade, consumed as per-tile LIGHT LEVELS) ------
// Clouds are no longer painted as overlay fills: render.js reads cloudShadeAt
// per tile and darkens the tile's (and its object's) RGB tint instead - the
// art darkens, nothing is drawn over it.

// Lumpy outline radius-multiplier vs angle for one cloud, computed ONCE at
// spawn (the phases never change): per-tile shade queries then cost a lookup,
// not atan2 + two sins. CLOUD_N is a pow2 so the angle index can mask-wrap.
const CLOUD_N = 128;
function buildLumpTable(phase, phase2) {
  const t = new Float32Array(CLOUD_N), PI2 = Math.PI * 2;
  for (let i = 0; i < CLOUD_N; i++) {
    const a = (i / CLOUD_N) * PI2 - Math.PI;
    t[i] = 0.78 + 0.22 * Math.sin(2 * a + phase) + 0.14 * Math.sin(3 * a + phase2);
  }
  return t;
}
function newCloud(inView) {
  const a = GD.ambient.clouds;
  const rCells = rand(a.minCells, a.maxCells);     // radius in cells (tile footprint)
  const speed = a.speed * rand(0.6, 1.4);          // per-cloud speed; direction is the shared wind
  const c = {
    wx: 0, wy: 0, speed, vx: Math.cos(windAng) * speed, vy: Math.sin(windAng) * speed, rCells,
    alpha: a.alpha * rand(0.55, 1.45),             // per-cloud opacity varies a lot
    phase: rand(0, Math.PI * 2), phase2: rand(0, Math.PI * 2), // lumpy outline
  };
  c.lump = buildLumpTable(c.phase, c.phase2);      // static per cloud (phases never change)
  const cluster = a.cluster || 0;
  if (cluster > 0 && clouds.length && Math.random() < cluster) {
    // Clustering: drop this cloud near an existing one so they clump into groups
    // (same sizes, just grouped) instead of spreading evenly.
    const base = clouds[(Math.random() * clouds.length) | 0];
    const spread = (a.minCells + rCells) * 2 * HALF_W; // a couple cloud-radii in world px
    c.wx = base.wx + rand(-spread, spread);
    c.wy = base.wy + rand(-spread, spread);
  } else if (inView) {
    const wpt = screenToWorld(rand(0, W()), rand(0, H())); c.wx = wpt.x; c.wy = wpt.y;
  } else {
    recycleCloud(c);
  }
  return c;
}
// Effective draw radius (cells): the cloud's own size swollen by the live storm scale, so the
// shape, the rain-coverage field, and the recycle margin all agree on how big the cloud is now.
function cloudR(c) { return c.rCells * cloudSizeMul; }
function cloudMargin(c) { return cloudR(c) * 2 * HALF_W * G.cam.zoom + 24; }
function recycleCloud(c) {
  const m = cloudMargin(c), w = frameW || W(), h = frameH || H();
  let sx, sy;
  if (Math.abs(c.vx) >= Math.abs(c.vy)) { sx = c.vx >= 0 ? -m : w + m; sy = rand(-m * 0.2, h + m * 0.2); }
  else { sy = c.vy >= 0 ? -m : h + m; sx = rand(-m * 0.2, w + m * 0.2); }
  const wpt = screenToWorld(sx, sy); c.wx = wpt.x; c.wy = wpt.y;
}

// Cloud coverage (0..1) at a WORLD point - used by the rain so it only falls under
// clouds. Approximates each cloud as a disc in cell space (the base radius, ignoring
// the lumpy outline) and returns the strongest overlap. Cheap (a handful of clouds).
export function cloudShadowAt(wx, wy) {
  if (!cloudField.length) return 0;
  const fcol = wx / (2 * HALF_W) + wy / (2 * HALF_H);
  const frow = wy / (2 * HALF_H) - wx / (2 * HALF_W);
  let cover = 0;
  for (const f of cloudField) {
    const dx = fcol - f.ccol, dy = frow - f.crow, d2 = dx * dx + dy * dy;
    if (d2 >= f.r2) continue;                       // squared-distance early-out (no sqrt)
    const v = 1 - Math.sqrt(d2) / f.r;
    if (v > cover) cover = v;
  }
  return cover;
}
// Snapshot cloud cell-centers once per frame so the per-drop coverage query above
// and the per-tile shade query below don't recompute them thousands of times.
// Rebuilt in updateAmbient after the clouds move. Each entry also carries the
// shade ingredients: the cloud's lump table, its opacity (rain-boosted - storm
// clouds read darker), and the squared LUMPY max radius for the early reject.
function rebuildCloudField() {
  cloudField.length = 0;
  const rainBoost = 1 + weatherRain() * 0.7;
  for (const c of clouds) {
    const r = cloudR(c);
    const maxR = r * 1.15; // just past the max lumpy radius (0.78+0.22+0.14)
    cloudField.push({
      ccol: c.wx / (2 * HALF_W) + c.wy / (2 * HALF_H),
      crow: c.wy / (2 * HALF_H) - c.wx / (2 * HALF_W),
      r, r2: r * r, maxR2: maxR * maxR,
      shadeA: Math.min(1, c.alpha * rainBoost), lump: c.lump,
    });
  }
}
// Banded cloud shade 0..1 at tile (c,r) - the per-tile LIGHT-LEVEL input that
// replaced the painted cloud shadows: same lumpy blob + 3-step falloff the old
// drawCloud rasterized, but returned as a number for render.js to fold into the
// tile's RGB tint (floor instance + the object standing on it). Overlapping
// clouds compound like stacked translucent fills did: 1 - prod(1 - shade).
const CLOUD_IDX_SCALE = CLOUD_N / (Math.PI * 2);
export function cloudShadeAt(c, r) {
  if (!cloudField.length) return 0;
  let through = 1; // light let through by all clouds
  for (const f of cloudField) {
    const ox = c - f.ccol, oy = r - f.crow;
    const d2 = ox * ox + oy * oy;
    if (d2 > f.maxR2) continue;                    // far corner -> skip before sqrt/atan2
    const reff = f.r * f.lump[((Math.atan2(oy, ox) + Math.PI) * CLOUD_IDX_SCALE) & (CLOUD_N - 1)];
    const d = Math.sqrt(d2);
    if (d > reff) continue;
    const lvl = Math.ceil((1 - d / reff) * 3);     // 3 bands (tiled falloff)
    if (lvl <= 0) continue;
    through *= 1 - f.shadeA * (Math.min(3, lvl) / 3);
  }
  return 1 - through;
}
export function cloudsActive() { return cloudField.length > 0; }

// Pick a random cloud currently in view (for a lightning strike). Returns its world
// position + cell radius, or null if none on screen.
export function randomCloudInView() {
  if (!clouds.length) return null;
  const inview = [];
  for (const c of clouds) if (!offscreen(c.wx, c.wy, 0)) inview.push(c);
  const pool = inview.length ? inview : clouds;
  const c = pool[(Math.random() * pool.length) | 0];
  return { wx: c.wx, wy: c.wy, r: c.rCells, phase: c.phase, phase2: c.phase2 };
}

// --- Moonlight / sun beams (world-anchored shafts that LAND on land tiles) ---
// Each beam is a short shaft slanting in from the top-right (the object-shadow
// angle) onto a single tile, with a soft pool brightening that tile. They all
// DRIFT in one shared direction (like the clouds), as if the moon/sun were moving
// across the sky, and recycle at the upwind edge. Over water they draw nothing.
function landTileWorld() {
  const w = W(), h = H();
  for (let i = 0; i < 30; i++) {
    const wpt = screenToWorld(rand(w * 0.05, w * 0.95), rand(h * 0.05, h * 0.95));
    const cell = worldToCell(wpt.x, wpt.y);
    if (tileAt(cell.col, cell.row) !== "water") { const cc = cellCenter(cell.col, cell.row); return { wx: cc.x, wy: cc.y }; }
  }
  return null;
}
function newMoonbeam(inView) {
  const m = GD.ambient.moonlight;
  const driftAng = ((m.driftDeg != null ? m.driftDeg : 200) * Math.PI) / 180;
  const sp = (m.driftSpeed != null ? m.driftSpeed : 5);
  const b = {
    wx: 0, wy: 0,
    vx: Math.cos(driftAng) * sp, vy: Math.sin(driftAng) * sp,   // shared steady drift (sun/moon motion)
    len: rand(m.minLen || 2.5, m.maxLen || 5),                  // shaft length (tiles)
    width: rand(m.minWidth || 0.3, m.maxWidth || 0.6),          // beam thickness (tile-half-widths)
    aScale: rand(0.7, 1.25),
    phase: rand(0, Math.PI * 2),
    phaseSpeed: (m.shimmerSpeed || 0.0006) * rand(0.7, 1.3),
  };
  if (inView) { const p = landTileWorld(); if (p) { b.wx = p.wx; b.wy = p.wy; } else { const w = screenToWorld(rand(0, W()), rand(0, H())); b.wx = w.x; b.wy = w.y; } }
  else recycleMoonbeam(b);
  return b;
}
function beamMargin(b) {
  const m = GD.ambient.moonlight, pool = (m && m.poolTiles != null ? m.poolTiles : 2.5) * 2 * HALF_W;
  return (b.len * 2 * HALF_H + pool) * G.cam.zoom + 24; // cover the shaft + the pool radius so the glow never pops at the edge
}
function recycleMoonbeam(b) {
  const m = beamMargin(b), w = W(), h = H();
  let sx, sy;
  if (Math.abs(b.vx) >= Math.abs(b.vy)) { sx = b.vx >= 0 ? -m : w + m; sy = rand(-m * 0.2, h + m * 0.2); }
  else { sy = b.vy >= 0 ? -m : h + m; sx = rand(-m * 0.2, w + m * 0.2); }
  const wpt = screenToWorld(sx, sy); b.wx = wpt.x; b.wy = wpt.y;
}

// --- Bugs (world-anchored attractant; always 1px) --------------------
function newBug(s) {
  const a = GD.ambient.bugs;
  return {
    wx: s.wx + rand(-BUG_SPAWN_R, BUG_SPAWN_R), wy: s.wy + rand(-BUG_SPAWN_R, BUG_SPAWN_R), vx: 0, vy: 0,
    k: (a.attract || 5) * rand(0.55, 1.5),     // per-bug attraction (varied -> non-uniform)
    jit: (a.jitter || 120) * rand(0.6, 1.4),   // per-bug wander
    maxSp: (a.maxSpeed || 40) * rand(0.65, 1.25),
    rgb: BUG_COLORS[(Math.random() * BUG_COLORS.length) | 0],
    trail: [], lwx: 1e9, lwy: 1e9,             // recent WORLD path points (the stream)
  };
}
function newSwarm() {
  const a = GD.ambient.bugs, p = landSpawnWorld();
  if (!p) return null; // no land in view -> no swarm (no bugs over open ocean)
  // No bug swarms in the snow biome (globe) - bugs belong to warmer ground.
  if (G.world.wrapX) { const cell = worldToCell(p.wx, p.wy); if (snownessAt(cell.col, cell.row) > 0.4) return null; }
  const s = { wx: p.wx, wy: p.wy, ang: rand(0, Math.PI * 2),
    sp: (a.swarmSpeed || 12) * rand(0.6, 1.4), t: 0,
    next: rand(pick(a.wanderMs, 0, 700), pick(a.wanderMs, 1, 1800)),
    homeWX: p.wx, homeWY: p.wy, onLand: true, bugs: [] };
  const per = Math.max(1, Math.round(bugTotal() / Math.max(1, (a.swarms | 0) || 1)));
  for (let i = 0; i < per; i++) s.bugs.push(newBug(s));
  return s;
}

// --- Birds (world-anchored, scale with zoom) -------------------------
function spawnBirdFlock() {
  const a = GD.ambient.birds, w = W(), h = H();
  const fromLeft = Math.random() < 0.5;
  const sp = rand(a.minSpeed, a.maxSpeed) * (fromLeft ? 1 : -1); // world px/s
  const edgeX = fromLeft ? -20 : w + 20, baseY = rand(h * 0.08, h * 0.55);
  const n = Math.round(rand(pick(a.flock, 0, 1), pick(a.flock, 1, 3)));
  const max = birdMax();
  for (let i = 0; i < n && birds.length < max; i++) {
    const wpt = screenToWorld(edgeX - i * 26 * Math.sign(sp), baseY + rand(-18, 18));
    birds.push({ wx: wpt.x, wy: wpt.y, vx: sp * rand(0.9, 1.1), bob: rand(6, 16),
      bobMs: rand(900, 1500), phase: rand(0, 1000), flap: rand(0, 1000), size: a.size * rand(0.85, 1.25) });
  }
}

function initAmbient() {
  inited = true; clouds = []; birds = []; swarms = []; moonbeams = [];
  const a = GD.ambient;
  windAng = windTarget = rand(0, Math.PI * 2);
  windTimer = (a.clouds && a.clouds.windSwitchMs) || DEFAULT_WIND_SWITCH;
  const cloud0 = Math.round(cloudBudget() * weatherCloud()); // start at the weather's coverage
  for (let i = 0; i < cloud0; i++) clouds.push(newCloud(true));
  for (let i = 0; i < ((a.moonlight && a.moonlight.count) | 0); i++) moonbeams.push(newMoonbeam(true));
  const target = Math.max(0, (a.bugs && a.bugs.swarms | 0) || 0);
  for (let i = 0; i < target; i++) { const s = newSwarm(); if (s) swarms.push(s); }
}

// --- Update (called every frame, even while paused) -------------------
function updateBug(b, s, dt) {
  // Damped spring toward the swarm center + per-bug random jitter (organic mill).
  b.vx += (s.wx - b.wx) * b.k * dt + rand(-1, 1) * b.jit * dt;
  b.vy += (s.wy - b.wy) * b.k * dt + rand(-1, 1) * b.jit * dt;
  b.vx *= 0.9; b.vy *= 0.9;
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > b.maxSp) { b.vx = b.vx / sp * b.maxSp; b.vy = b.vy / sp * b.maxSp; }
  b.wx += b.vx * dt; b.wy += b.vy * dt;
  const trailLen = (GD.ambient.bugs.trail | 0) || 16;
  if (Math.abs(b.wx - b.lwx) > 0.4 || Math.abs(b.wy - b.lwy) > 0.4) {
    b.trail.push(b.wx, b.wy); if (b.trail.length > trailLen * 2) b.trail.splice(0, 2); b.lwx = b.wx; b.lwy = b.wy;
  }
}

export function updateAmbient(dtMs) {
  if (!GD.ambient || !G.hasWorld) return;
  if (!inited) initAmbient();
  const dt = Math.min(0.05, dtMs / 1000);
  frameW = W(); frameH = H(); // one DOM geometry read per frame for the offscreen tests

  // Shared wind: all clouds drift one direction, which EASES toward a new random
  // heading every windSwitchMs (gradual shortest-arc turn - no instant reverses or
  // hard angles). Each switch nudges the target by at most +-windVaryDeg.
  const cw = GD.ambient.clouds;
  windTimer -= dtMs;
  if (windTimer <= 0) {
    const vary = ((cw.windVaryDeg || 70) * Math.PI) / 180;
    windTarget = windAng + rand(-vary, vary);
    windTimer = cw.windSwitchMs || DEFAULT_WIND_SWITCH;
  }
  const maxTurn = ((cw.windTurnSpeed || 6) * Math.PI) / 180 * dt; // radians this frame
  const diff = Math.atan2(Math.sin(windTarget - windAng), Math.cos(windTarget - windAng));
  windAng += Math.max(-maxTurn, Math.min(maxTurn, diff));
  // Clouds swell as the rain rises (real storm clouds are miles wide). One shared scale drives
  // every cloud's draw size, its rain-coverage footprint, and its recycle margin (via cloudR).
  cloudSizeMul = 1 + weatherRain() * (cw.rainSize || 0);
  // Cloud coverage tracks the weather: ease the active cloud count toward budget x coverage,
  // where coverage = cloud cover PLUS a share of the rain (rainCover) - so rain and storms push
  // the sky toward fully overcast, not just the plain cloudy level. Each cloud's drawn AREA grows
  // with the square of cloudSizeMul, so we divide the COUNT by cloudSizeMul: storm clouds are far
  // bigger but proportionally fewer, which keeps the sky overcast WITHOUT a runaway tile-draw cost
  // (cost ~ count x radius^2). Add fresh ones off-screen; drop off-screen ones first.
  const cover = Math.min(1, weatherCloud() + weatherRain() * (cw.rainCover || 0));
  const coverTarget = Math.round((cloudBudget() * cover) / cloudSizeMul);
  while (clouds.length < coverTarget) clouds.push(newCloud(false));
  while (clouds.length > coverTarget) {
    let idx = clouds.findIndex((c) => offscreen(c.wx, c.wy, cloudMargin(c)));
    if (idx < 0) idx = clouds.length - 1;
    clouds.splice(idx, 1);
  }
  const wcos = Math.cos(windAng), wsin = Math.sin(windAng);
  for (const c of clouds) {
    c.vx = wcos * c.speed; c.vy = wsin * c.speed;
    c.wx += c.vx * dt; c.wy += c.vy * dt;
    if (offscreen(c.wx, c.wy, cloudMargin(c))) recycleCloud(c);
  }
  rebuildCloudField(); // refresh the fast coverage snapshot now that clouds have moved

  // Bugs: despawn out-of-view swarms, refill in view over land.
  for (let i = swarms.length - 1; i >= 0; i--) if (offscreen(swarms[i].wx, swarms[i].wy)) swarms.splice(i, 1);
  const target = Math.max(0, (GD.ambient.bugs.swarms | 0) || 0);
  let guard = 0;
  while (swarms.length < target && guard++ < target + 2) { const s = newSwarm(); if (s) swarms.push(s); else break; }
  for (const s of swarms) {
    s.t += dtMs;
    if (s.t >= s.next) { s.t = 0; s.next = rand(pick(GD.ambient.bugs.wanderMs, 0, 700), pick(GD.ambient.bugs.wanderMs, 1, 1800)); s.ang += rand(-0.8, 0.8); }
    const cell = worldToCell(s.wx, s.wy);
    s.onLand = nearLand(cell.col, cell.row);
    if (s.onLand) { s.homeWX = s.wx; s.homeWY = s.wy; }
    else { s.ang = Math.atan2(s.homeWY - s.wy, s.homeWX - s.wx); }
    s.wx += Math.cos(s.ang) * s.sp * dt; s.wy += Math.sin(s.ang) * s.sp * dt;
    for (const b of s.bugs) updateBug(b, s, dt);
  }

  // Birds.
  const ba = GD.ambient.birds;
  if (ba && birds.length < birdMax() && Math.random() < (ba.spawnChancePerSec || 0) * dt) spawnBirdFlock();
  for (let i = birds.length - 1; i >= 0; i--) {
    const bd = birds[i];
    bd.wx += bd.vx * dt; bd.flap += dtMs; bd.phase += dtMs;
    bd.wy += Math.sin(bd.phase * (Math.PI * 2) / bd.bobMs) * bd.bob * dt;
    if (offscreen(bd.wx, bd.wy)) birds.splice(i, 1);
  }

  // Moon/sun beams: gentle brightness shimmer + a shared steady drift (the moving
  // light source), recycling at the upwind edge - world-anchored, never camera-locked.
  for (const b of moonbeams) {
    b.phase += b.phaseSpeed * dtMs;
    b.wx += b.vx * dt; b.wy += b.vy * dt;
    if (offscreen(b.wx, b.wy, beamMargin(b))) recycleMoonbeam(b);
  }
}

// --- Render -----------------------------------------------------------
// Cloud SHADOWS are no longer painted here: their shade is folded into each
// tile's light level (cloudShadeAt -> render.js RGB tints), so the floor and
// the objects on it darken at the pixel level instead of under an overlay fill.
export function renderAmbient() {
  if (!GD.ambient || !G.hasWorld || !inited) return;
  const z = G.cam.zoom;
  renderMoonlight();
  for (const s of swarms) { if (s.onLand) for (const b of s.bugs) drawBug(b); }
  for (const bd of birds) drawBird(bd, z);
}

// Fake moon/sun beams: short additive light shafts that slant in from the top-right
// (the object-shadow lean, derived from SHADOW_SKEW/SQUASH so they stay matched) and
// LAND on a single land tile, with a soft pool that gives that tile a touch more
// brightness - like a ray cast onto it, not a streak across the whole screen.
// Present day AND night: the colour blends from cool BLUE (night) to warm YELLOW/ORANGE
// (day) by dayAmount, so as the sun rises the moonbeams become sun rays. World-anchored
// + drifting (see update), so the pools glide over the terrain as the light source moves.
function renderMoonlight() {
  const m = GD.ambient.moonlight;
  if (!m || !moonbeams.length) return;
  const z = G.cam.zoom;
  // Tilt = object-shadow lean; rotating local -y to (sin,-cos) aims the shaft UP-RIGHT
  // toward the source, so it lands coming from the top-right. gamedata angleDeg overrides.
  const ang = (m.angleDeg != null) ? (m.angleDeg * Math.PI / 180) : Math.atan2(SHADOW_SKEW, SHADOW_SQUASH);
  const day = dayAmount();                   // 0 across night -> 1 at noon (ramps through dawn/dusk)
  const nc = m.nightColor || [120, 165, 255], dc = m.dayColor || [255, 205, 120];
  const rgb = Math.round(nc[0] + (dc[0] - nc[0]) * day) + ", " +
              Math.round(nc[1] + (dc[1] - nc[1]) * day) + ", " +
              Math.round(nc[2] + (dc[2] - nc[2]) * day);
  const baseA = (m.alpha != null ? m.alpha : 0.14);
  ctx.save();
  ctx.globalCompositeOperation = "lighter"; // additive: beams add light to the scene
  for (const b of moonbeams) {
    const cell = worldToCell(b.wx, b.wy);
    if (tileAt(cell.col, cell.row) === "water") continue; // only light land tiles
    const a = baseA * b.aScale * (0.75 + 0.25 * Math.sin(b.phase)); // gentle shimmer
    if (a <= 0.002) continue;
    const p = worldToScreen(b.wx, b.wy);
    const lenPx = b.len * 2 * HALF_H * z, hw = b.width * HALF_W * z;
    // Shaft: a soft elongated radial glow along the beam, NOT a hard rect - feathered
    // on every edge (sides + tip) so it reads as a soft beam. Drawn by scaling a unit
    // radial into an ellipse hw across by ~lenPx long, centered a bit up the beam toward
    // the source; brightest at its core, fading to nothing at the rim.
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);                          // local -y -> up-right (toward the light source)
    ctx.translate(0, -lenPx * 0.4);
    ctx.scale(hw, lenPx * 0.55);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, "rgba(" + rgb + ", " + a.toFixed(3) + ")");
    g.addColorStop(0.5, "rgba(" + rgb + ", " + (a * 0.5).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + rgb + ", 0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Soft pool where it lands: spreads over a RADIUS of several tiles, losing
    // brightness outward (radial falloff) - the light spilling across the ground, not
    // a single-tile dot. Radius is poolTiles tiles wide, scaled by zoom.
    const pr = Math.max(4, (m.poolTiles != null ? m.poolTiles : 2.5) * 2 * HALF_W * z);
    const pg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, pr);
    pg.addColorStop(0, "rgba(" + rgb + ", " + a.toFixed(3) + ")");
    pg.addColorStop(0.4, "rgba(" + rgb + ", " + (a * 0.4).toFixed(3) + ")");
    pg.addColorStop(1, "rgba(" + rgb + ", 0)");
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawBug(b) {
  // Always 1px (true bug-sized at any zoom) - position is world-anchored, size is not.
  const tr = b.trail, n = tr.length / 2;
  for (let i = 0; i < n; i++) {
    const a = 0.5 * (i + 1) / n;
    const p = worldToScreen(tr[i * 2], tr[i * 2 + 1]);
    ctx.fillStyle = "rgba(" + b.rgb + ", " + a.toFixed(3) + ")";
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  }
  const p = worldToScreen(b.wx, b.wy);
  const sz = (GD.ambient.bugs.pxSize | 0) || 2; // FIXED px (never scales with zoom)
  ctx.fillStyle = "rgba(" + b.rgb + ", 0.95)";
  ctx.fillRect(Math.round(p.x) - (sz >> 1), Math.round(p.y) - (sz >> 1), sz, sz);
}

// Live counts for the debug overlay (to confirm spawning).
export function ambientCounts() {
  let bugCount = 0;
  for (const s of swarms) bugCount += s.bugs.length;
  return { clouds: clouds.length, swarms: swarms.length, bugs: bugCount, birds: birds.length, beams: moonbeams.length };
}

function drawBird(bd, z) {
  const p = worldToScreen(bd.wx, bd.wy);
  const flap = Math.sin(bd.flap * (Math.PI * 2) / (GD.ambient.birds.wingMs || 240));
  const s = bd.size * z, wy = s * (0.25 + 0.55 * flap);
  ctx.strokeStyle = "rgba(40, 46, 58, 0.82)";
  ctx.lineWidth = Math.max(1, s * 0.13);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(p.x - s, p.y - wy);
  ctx.quadraticCurveTo(p.x - s * 0.3, p.y + s * 0.18, p.x, p.y);
  ctx.quadraticCurveTo(p.x + s * 0.3, p.y + s * 0.18, p.x + s, p.y - wy);
  ctx.stroke();
}
