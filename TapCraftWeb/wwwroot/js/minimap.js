// TapCraft - minimap: a coarse, zoomable top-down map of the world, drawn into the forecast
// panel. The whole (bounded) world is sampled ONCE into an offscreen "world map" (shaded water
// / land / biome blocks); each frame just blits a windowed region + draws the viewport quad +
// a player marker - so panning is a cheap drawImage, not a re-sample. The window is CENTRED on
// the player only while the world is too big to fit; once an axis can show the whole map it
// ANCHORS (map static, marker travels) - see drawMinimap. The expensive one-time build runs at
// world entry (behind a loading screen, see ui.startGame).
"use strict";

import { G } from "./state.js";
import { el, canvas } from "./dom.js";
import { screenToWorld, worldToCell } from "./iso.js";
import { tileAt, snownessAt, desertAt, iceAt, landHeightAt, wrapCol, wrapRow, isTilledTile } from "./cells.js";
import { inBounds } from "./rng.js";

const MM_MAX = 768;                    // max offscreen world-map dimension (caps the one-time build)
const INF_SPAN = 2048;                 // infinite worlds: cells covered by the map, around spawn
let mmZoom = 3; // display cells-per-pixel (continuous); clamped to [1, fit-world] each frame

let cnv = null, ctx = null, coordEl = null, coordTxt = null, wired = false;
// The pre-rendered world map: offscreen + its world->pixel mapping. Rebuilt only on world change.
let wm = null, wmW = 0, wmH = 0, wmCpp = 1, wmOc = 0, wmOr = 0, wmSeed = -1;
// Last-drawn state for the per-frame redraw dirty-check: the blit + viewport quad + marker only
// change when the camera, the minimap zoom, the buffer size, or the loaded world map changes.
let lastCamX = NaN, lastCamY = NaN, lastCamZoom = NaN, lastMmZoom = NaN, lastDw = 0, lastDh = 0, lastWmSeed = -2;

const C_VOID = [10, 16, 30], C_WATER = [33, 67, 110], C_ICE = [120, 160, 205], C_SAND = [200, 176, 121],
  C_STONE = [107, 114, 128], C_DIRT = [122, 102, 80], C_GRASS = [63, 122, 58], C_SNOW = [223, 232, 240], C_DESERT = [170, 165, 96],
  C_TILLED = [101, 78, 53];

// Write the shaded RGBA of cell (c,r) into image data at byte i. Land gets a subtle elevation
// relief (low ground darker, highlands brighter) for a map-like look. (data is a
// Uint8ClampedArray, so float colour * shade is rounded + clamped on assignment.)
function sampleColor(c, r, data, i) {
  let col, shade = 1;
  if (!inBounds(c, r)) col = C_VOID;
  else {
    const t = tileAt(c, r);
    if (t === "water") col = (G.world.wrapX && iceAt(c, r)) ? C_ICE : C_WATER;
    else {
      if (t === "sand") col = C_SAND;
      else if (t === "stone") col = C_STONE;
      else if (t === "dirt") col = C_DIRT;
      else if (isTilledTile(t)) col = C_TILLED;
      else if (G.world.wrapX) col = snownessAt(c, r) > 0.5 ? C_SNOW : (desertAt(c, r) > 0.5 ? C_DESERT : C_GRASS);
      else col = C_GRASS;
      shade = 0.82 + 0.4 * landHeightAt(c, r);
    }
  }
  data[i] = col[0] * shade; data[i + 1] = col[1] * shade; data[i + 2] = col[2] * shade; data[i + 3] = 255;
}

// One-time coarse render of the whole (bounded) world into the offscreen. EXPENSIVE (samples
// up to MM_MAX^2 cells incl. rivers/lakes); call once per world, behind a loading screen.
export function buildWorldMap() {
  if (!G.hasWorld) return;
  let spanC, spanR, oc, or;
  if (G.world.infinite) {
    const sp = G.world.spawn || { c: 0, r: 0 };
    spanC = spanR = INF_SPAN; oc = (sp.c | 0) - (INF_SPAN >> 1); or = (sp.r | 0) - (INF_SPAN >> 1);
  } else {
    spanC = G.world.cols | 0; spanR = G.world.rows | 0; oc = 0; or = 0;
  }
  const cpp = Math.max(1, Math.ceil(Math.max(spanC, spanR) / MM_MAX));
  wmCpp = cpp; wmOc = oc; wmOr = or;
  wmW = Math.max(1, Math.round(spanC / cpp)); wmH = Math.max(1, Math.round(spanR / cpp));
  if (!wm) wm = document.createElement("canvas");
  wm.width = wmW; wm.height = wmH;
  const wctx = wm.getContext("2d");
  const img = wctx.createImageData(wmW, wmH), d = img.data;
  let i = 0;
  for (let py = 0; py < wmH; py++) {
    const row = or + py * cpp;
    for (let px = 0; px < wmW; px++) { sampleColor(oc + px * cpp, row, d, i); i += 4; }
  }
  wctx.putImageData(img, 0, 0);
  wmSeed = G.world.seed >>> 0;
}

function ensure() {
  if (cnv) return cnv;
  cnv = el("tc-minimap");
  if (!cnv) return null;
  ctx = cnv.getContext("2d");
  coordEl = el("tc-mm-coords");
  if (!wired) {
    wired = true;
    const zIn = el("tc-mm-in"), zOut = el("tc-mm-out");
    if (zIn) zIn.addEventListener("click", () => { mmZoom = Math.max(1, mmZoom / 1.5); });   // in
    if (zOut) zOut.addEventListener("click", () => { mmZoom *= 1.5; });                      // out (capped at fit-world in draw)
    cnv.addEventListener("wheel", (e) => {
      e.preventDefault();
      mmZoom = e.deltaY < 0 ? Math.max(1, mmZoom / 1.25) : mmZoom * 1.25;
    }, { passive: false });
  }
  return cnv;
}

// Called every rendered frame. Cheap: a windowed blit of the pre-built world map + the indicator.
export function drawMinimap() {
  if (!G.hasWorld || G.inMenu) return;
  if (!ensure()) return;

  // Focus cell = the cell under the screen CENTRE ("where you are"). The map + the viewport quad
  // are both centred on it, so the player marker is always dead-centre on the minimap.
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const fwp = screenToWorld(w / 2, h / 2), fc = worldToCell(fwp.x, fwp.y);
  const fcol = fc.col, frow = fc.row;

  if (wmSeed !== (G.world.seed >>> 0)) buildWorldMap(); // first draw / world change (lazy fallback)
  else if (G.world.infinite && (fcol < wmOc + INF_SPAN * 0.25 || fcol > wmOc + INF_SPAN * 0.75 ||
    frow < wmOr + INF_SPAN * 0.25 || frow > wmOr + INF_SPAN * 0.75)) buildWorldMap(); // wandered out -> recentre
  if (!wm) return;

  // High-DPI display buffer so the map + indicator stay crisp.
  const dpr = window.devicePixelRatio || 1;
  const cw0 = cnv.clientWidth || 281, ch0 = cnv.clientHeight || 188; // one layout read each, reused below (CSS: .tc-forecast/.tc-minimap)
  const dw = Math.max(1, Math.round(cw0 * dpr)), dh = Math.max(1, Math.round(ch0 * dpr));
  if (cnv.width !== dw || cnv.height !== dh) { cnv.width = dw; cnv.height = dh; }

  // Window centred on the focus (canonicalized on a globe so it lands on the map).
  const pcc = wrapCol(fcol), pcr = wrapRow(frow);
  // Clamp the zoom: never zoom OUT past the whole world on a wrapping axis (else the torus map
  // tiles), never zoom IN below 1 cell/pixel. The most zoomed-out level fits the world exactly.
  let cppDMax = Infinity;
  if (G.world.wrapX) cppDMax = Math.min(cppDMax, G.world.cols / cw0);
  if (G.world.wrapY) cppDMax = Math.min(cppDMax, G.world.rows / ch0);
  if (cppDMax < 1) cppDMax = 1;
  if (mmZoom > cppDMax) mmZoom = cppDMax;
  if (mmZoom < 1) mmZoom = 1;
  const cppD = mmZoom;

  // Coordinate readout (cell under the mouse, else the focus cell): cheap, and hovering changes it
  // without moving the map, so update it BEFORE the redraw guard below. (Mineable stock
  // shows in a cursor tooltip instead - render.drawStockTooltip.)
  const hv = G.hoverTile || G.hover;
  const txt = (hv && hv.col != null) ? (hv.col + ", " + hv.row) : (fcol + ", " + frow);
  if (coordEl && coordTxt !== txt) { coordTxt = txt; coordEl.textContent = txt; }

  // Redraw dirty-check: the canvas keeps its previous frame, so when the camera, minimap zoom,
  // buffer size and loaded world map are all unchanged the blit + quad + marker would come out
  // identical - skip the (otherwise every-frame) redraw entirely.
  if (G.cam.x === lastCamX && G.cam.y === lastCamY && G.cam.zoom === lastCamZoom &&
      cppD === lastMmZoom && dw === lastDw && dh === lastDh && wmSeed === lastWmSeed) return;
  lastCamX = G.cam.x; lastCamY = G.cam.y; lastCamZoom = G.cam.zoom;
  lastMmZoom = cppD; lastDw = dw; lastDh = dh; lastWmSeed = wmSeed;

  const scale = (wmCpp / cppD) * dpr;                  // world-map pixel -> device pixel
  const srcW = dw / scale, srcH = dh / scale;          // window size in world-map pixels
  // Per-axis ANCHORING: when the window can show the whole world on an axis,
  // pin that axis (world centred in the window) and let the MARKER travel
  // instead - the map only pans on axes where the full map cannot fit. An
  // infinite world has no full map (the offscreen is a roaming sample around
  // the player), so it always pans.
  const anchorX = !G.world.infinite && srcW >= wmW - 0.5;
  const anchorY = !G.world.infinite && srcH >= wmH - 0.5;
  const pmx = (pcc - wmOc) / wmCpp, pmy = (pcr - wmOr) / wmCpp; // player in world-map px
  const srcX = anchorX ? (wmW - srcW) / 2 : pmx - srcW / 2;
  const srcY = anchorY ? (wmH - srcH) / 2 : pmy - srcH / 2;

  ctx.imageSmoothingEnabled = true;                    // smooth (less blocky) terrain scaling
  ctx.fillStyle = "#0a1222"; ctx.fillRect(0, 0, dw, dh);
  // Tiled blit: a globe map WRAPS, so draw each copy that intersects the window; finite / infinite
  // worlds draw the single copy (the rest of the window stays void).
  const txMin = G.world.wrapX ? Math.floor(srcX / wmW) : 0, txMax = G.world.wrapX ? Math.floor((srcX + srcW) / wmW) : 0;
  const tyMin = G.world.wrapY ? Math.floor(srcY / wmH) : 0, tyMax = G.world.wrapY ? Math.floor((srcY + srcH) / wmH) : 0;
  for (let tx = txMin; tx <= txMax; tx++)
    for (let ty = tyMin; ty <= tyMax; ty++)
      ctx.drawImage(wm, (tx * wmW - srcX) * scale, (ty * wmH - srcY) * scale, wmW * scale, wmH * scale);

  // Viewport quad + marker position: the window centre on panning axes, the
  // player's true map position on anchored ones (the marker walks the map).
  const k2 = dpr / cppD;
  const hx = anchorX ? (pmx - srcX) * scale : dw / 2;
  const hy = anchorY ? (pmy - srcY) * scale : dh / 2;
  // Quad corner offsets from the focus cell (minimap px), computed once.
  const cor = [[0, 0], [w, 0], [w, h], [0, h]], qpts = [];
  for (let k = 0; k < 4; k++) {
    const wp = screenToWorld(cor[k][0], cor[k][1]), cell = worldToCell(wp.x, wp.y);
    qpts.push([(cell.col - fcol) * k2, (cell.row - frow) * k2]);
  }
  // On an anchored WRAPPING axis the quad/marker can straddle the wrap seam:
  // also draw the copies one world-width away so they show on both edges.
  const xOffs = (anchorX && G.world.wrapX) ? [-wmW * scale, 0, wmW * scale] : [0];
  const yOffs = (anchorY && G.world.wrapY) ? [-wmH * scale, 0, wmH * scale] : [0];
  const rad = 3 * dpr;
  ctx.lineJoin = "round";
  for (const xo of xOffs) {
    for (const yo of yOffs) {
      const qx = hx + xo, qy = hy + yo;
      // Viewport quad, drawn with a dark halo + bright line so it reads on any terrain.
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const mx = qpts[k][0] + qx, my = qpts[k][1] + qy;
        if (k === 0) ctx.moveTo(mx, my); else ctx.lineTo(mx, my);
      }
      ctx.closePath();
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = "rgba(0, 0, 0, 0.5)"; ctx.stroke();
      ctx.lineWidth = 1.4 * dpr; ctx.strokeStyle = "rgba(255, 255, 255, 0.96)"; ctx.stroke();
      // Marker (you-are-here): dark ring + bright dot, always visible even zoomed out.
      ctx.beginPath(); ctx.arc(qx, qy, rad + 1.3 * dpr, 0, 6.2832); ctx.fillStyle = "rgba(0, 0, 0, 0.6)"; ctx.fill();
      ctx.beginPath(); ctx.arc(qx, qy, rad, 0, 6.2832); ctx.fillStyle = "rgba(255, 210, 80, 0.98)"; ctx.fill();
    }
  }
}
