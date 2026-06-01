// TapCraft - hand-rolled WebGL2 batched sprite renderer.
//
// Draws the whole world (floor tiles + entities + shadows + drops) from the single
// runtime atlas (atlas.js) as a few instanced draw calls, so a dense scene that used to
// issue thousands of ctx.drawImage calls on one CPU core becomes a handful of GPU
// commands. The 2D path in render.js stays intact as a fallback (G.useGL).
//
// TWO instance layers share one shader/atlas:
//   - FLOOR (cached): rebuilt only when the camera/zoom/water/visible-range changes; the
//     per-cell tile + biome lookup is the expensive part, so caching it keeps steady
//     frames cheap (one draw, no CPU re-emit).
//   - DYNAMIC (per frame): entities, shadows, drops - things that move/animate/hover.
//
// Each instance is a 2x3 affine (unit quad -> screen px), a UV rect, and a premultiplied
// tint color. The affine expresses axis-aligned sprites, horizontal flip, AND the sheared
// shadow cast, so one shader covers everything. Coordinates are CSS px (the same space the
// 2D ctx used via setTransform(dpr)); the projection folds DPR in via the device-px viewport.
//
// Alpha is PREMULTIPLIED throughout: the atlas is uploaded with UNPACK_PREMULTIPLY_ALPHA,
// the canvas is premultipliedAlpha:true, blend is (ONE, ONE_MINUS_SRC_ALPHA). Tint is a
// straight multiply of the premultiplied texel: (1,1,1,1)=normal, (1.6,1.6,1.6,1)=hover
// brighten, (k,k,k,k)=scale opacity to k (shadows/smoke/ghost).
"use strict";

import { uvFor } from "./atlas.js";

const FLOATS_PER = 14;            // a,b,c,d, e,f, u0,v0,u1,v1, r,g,b,alpha
let gl = null, glCanvas = null;
let prog = null, tintProg = null;
let uResLoc = null, uTexLoc = null, uTintColLoc = null;
let dummyVao = null, quadBuf = null, tex = null;
let resW = 1, resH = 1;
let ready = false;
let atlasRef = null; // kept so the atlas can be re-uploaded after a context-restore

// An instance layer: its own CPU array + GL buffer + VAO. `cur` is the push target.
function makeLayer(cap) { return { data: new Float32Array(FLOATS_PER * cap), count: 0, cap, buf: null, vao: null }; }
let dyn = makeLayer(16384), flr = makeLayer(8192), cur = dyn;
let dynLast = 0;

const SPRITE_VS = `#version 300 es
layout(location=0) in vec2 a_quad;
layout(location=1) in vec4 a_x0;
layout(location=2) in vec2 a_x1;
layout(location=3) in vec4 a_uv;
layout(location=4) in vec4 a_col;
uniform vec2 u_res;
out vec2 v_uv;
out vec4 v_col;
void main() {
  float sx = a_x0.x * a_quad.x + a_x0.z * a_quad.y + a_x1.x;
  float sy = a_x0.y * a_quad.x + a_x0.w * a_quad.y + a_x1.y;
  gl_Position = vec4(sx / u_res.x * 2.0 - 1.0, 1.0 - sy / u_res.y * 2.0, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_quad);
  v_col = a_col;
}`;
const SPRITE_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_col;
uniform sampler2D u_tex;
out vec4 o;
void main() { o = texture(u_tex, v_uv) * v_col; }`;
// Fullscreen-triangle multiply pass for the day/night + weather tint (no vertex buffer).
const TINT_VS = `#version 300 es
void main() {
  float x = (gl_VertexID == 1) ? 3.0 : -1.0;
  float y = (gl_VertexID == 2) ? 3.0 : -1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
}`;
const TINT_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("TapCraft GL shader:", gl.getShaderInfoLog(s));
    gl.deleteShader(s); return null;
  }
  return s;
}
function link(vsSrc, fsSrc) {
  const vs = compile(gl.VERTEX_SHADER, vsSrc), fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error("TapCraft GL link:", gl.getProgramInfoLog(p)); return null;
  }
  return p;
}

// A VAO binding the shared unit quad (loc 0) + a layer's per-instance attributes (locs 1-4).
function setupLayerVao(layer) {
  layer.buf = gl.createBuffer();
  layer.vao = gl.createVertexArray();
  gl.bindVertexArray(layer.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const stride = FLOATS_PER * 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, layer.buf);
  for (const [loc, size, off] of [[1, 4, 0], [2, 2, 16], [3, 4, 24], [4, 4, 40]]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
}

function buildPipeline() {
  prog = link(SPRITE_VS, SPRITE_FS);
  tintProg = link(TINT_VS, TINT_FS);
  if (!prog || !tintProg) return false;
  uResLoc = gl.getUniformLocation(prog, "u_res");
  uTexLoc = gl.getUniformLocation(prog, "u_tex");
  uTintColLoc = gl.getUniformLocation(tintProg, "u_color");
  dummyVao = gl.createVertexArray();
  tex = gl.createTexture();
  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf); // static unit quad (triangle strip corners)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  setupLayerVao(dyn);
  setupLayerVao(flr);
  return true;
}

// Initialize on the #tc-gl canvas. Returns true if WebGL2 + pipeline are good (so the
// caller can flip G.useGL); false -> stay on the 2D renderer.
export function initGL(canvas) {
  glCanvas = canvas;
  if (!glCanvas) return false;
  gl = glCanvas.getContext("webgl2", {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
  });
  if (!gl) { console.warn("TapCraft: WebGL2 unavailable, using 2D renderer"); return false; }
  // Context loss (GPU reset / sleep / too many contexts): mark not-ready so render() falls
  // back to the 2D path, and rebuild the pipeline + re-upload the atlas when it returns.
  glCanvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); ready = false; }, false);
  glCanvas.addEventListener("webglcontextrestored", () => {
    if (buildPipeline()) {
      gl.clearColor(0, 0, 0, 0); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
      ready = true;
      if (atlasRef) uploadAtlas(atlasRef);
    }
  }, false);
  if (!buildPipeline()) { gl = null; return false; }
  gl.clearColor(0, 0, 0, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  ready = true;
  return true;
}
export function glReady() { return ready; }

export function uploadAtlas(atlasCanvas) {
  if (!ready || !atlasCanvas) return;
  atlasRef = atlasCanvas;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

export function resizeGL(cssW, cssH) {
  if (!ready) return;
  resW = Math.max(1, cssW); resH = Math.max(1, cssH);
  gl.viewport(0, 0, glCanvas.width, glCanvas.height);
}

// --- Instance push (into the current layer) ----------------------------------
function push(a, b, c, d, e, f, uvR, cr, cg, cb, ca) {
  const L = cur;
  if (L.count >= L.cap) {
    L.cap *= 2;
    const n = new Float32Array(FLOATS_PER * L.cap); n.set(L.data); L.data = n;
  }
  let i = L.count * FLOATS_PER;
  const D = L.data;
  D[i] = a; D[i + 1] = b; D[i + 2] = c; D[i + 3] = d; D[i + 4] = e; D[i + 5] = f;
  D[i + 6] = uvR.u0; D[i + 7] = uvR.v0; D[i + 8] = uvR.u1; D[i + 9] = uvR.v1;
  D[i + 10] = cr; D[i + 11] = cg; D[i + 12] = cb; D[i + 13] = ca;
  L.count++;
}
const WHITE = [1, 1, 1, 1];

// Axis-aligned sprite at screen-px top-left (tx,ty), size (dw,dh), optional h-flip.
export function sprite(img, tx, ty, dw, dh, flip, tint) {
  if (!ready) return;
  const uvR = uvFor(img); if (!uvR) return;
  const t = tint || WHITE;
  if (flip) push(-dw, 0, 0, dh, tx + dw, ty, uvR, t[0], t[1], t[2], t[3]);
  else push(dw, 0, 0, dh, tx, ty, uvR, t[0], t[1], t[2], t[3]);
}
// Sheared cast shadow: replicates render.js drawShadowRect's ctx.transform.
export function shadowCast(shImg, pivotX, groundY, dw, dh, footRows, unit, flip, skew, squash, alpha) {
  if (!ready) return;
  const uvR = uvFor(shImg); if (!uvR) return;
  const s = flip ? -1 : 1;
  const ox = -dw / 2, oy = -footRows * unit;
  const a = s * dw, c = skew * dh, d = squash * dh;
  const e = pivotX + s * ox + skew * oy, f = groundY + squash * oy;
  push(a, 0, c, d, e, f, uvR, alpha, alpha, alpha, alpha);
}
// Grounding-pool ellipse centered at (cx, cy), size (pw, ph).
export function pool(poolImg, cx, cy, pw, ph, alpha) {
  if (!ready) return;
  const uvR = uvFor(poolImg); if (!uvR) return;
  push(pw, 0, 0, ph, cx - pw / 2, cy - ph / 2, uvR, alpha, alpha, alpha, alpha);
}

// --- Floor layer (cached) ----------------------------------------------------
// render.js calls these only when the floor signature changes; floor sprites use the same
// sprite()/etc. (cur is switched to the floor layer for the duration).
export function beginFloor() { if (ready) { cur = flr; flr.count = 0; } }
export function endFloor() {
  if (!ready) { cur = dyn; return; }
  gl.bindBuffer(gl.ARRAY_BUFFER, flr.buf);
  gl.bufferData(gl.ARRAY_BUFFER, flr.data.subarray(0, flr.count * FLOATS_PER), gl.DYNAMIC_DRAW);
  cur = dyn;
}
function drawLayer(layer) {
  if (!ready || layer.count === 0) return;
  gl.useProgram(prog);
  gl.uniform2f(uResLoc, resW, resH);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(uTexLoc, 0);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha over
  gl.bindVertexArray(layer.vao);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.count);
  gl.bindVertexArray(null);
}
export function drawFloor() { drawLayer(flr); } // cached floor buffer (uploaded in endFloor)
// Animate water without rebuilding the whole floor: render.js records each water tile's
// instance index during the floor build, then each water tick rewrites just those UVs (in
// place, draw order unchanged) and re-uploads the floor buffer. floorInstanceCount() is the
// index the NEXT floor sprite will occupy.
export function floorInstanceCount() { return flr.count; }
export function patchFloorUV(idx, u0, v0, u1, v1) {
  if (!ready) return;
  const i = idx * FLOATS_PER;
  flr.data[i + 6] = u0; flr.data[i + 7] = v0; flr.data[i + 8] = u1; flr.data[i + 9] = v1;
}
export function reuploadFloor() {
  if (!ready || flr.count === 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, flr.buf);
  gl.bufferData(gl.ARRAY_BUFFER, flr.data.subarray(0, flr.count * FLOATS_PER), gl.DYNAMIC_DRAW);
}

// --- Per-frame dynamic layer -------------------------------------------------
export function beginFrame() {
  if (!ready) return;
  gl.clear(gl.COLOR_BUFFER_BIT);
  dyn.count = 0; cur = dyn;
}
export function flush() {
  if (!ready || dyn.count === 0) { dynLast = dyn.count; return; }
  dynLast = dyn.count;
  gl.bindBuffer(gl.ARRAY_BUFFER, dyn.buf);
  gl.bufferData(gl.ARRAY_BUFFER, dyn.data.subarray(0, dyn.count * FLOATS_PER), gl.DYNAMIC_DRAW);
  drawLayer(dyn);
  dyn.count = 0;
}

// Day/night + weather tint: fullscreen multiply (RGB *= color), alpha untouched. color
// components are 0..255 (matching applyEnvTint's pre-blended color).
export function drawEnvTint(r, g, b) {
  if (!ready) return;
  gl.useProgram(tintProg);
  gl.uniform4f(uTintColLoc, r / 255, g / 255, b / 255, 1);
  gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ONE);
  gl.bindVertexArray(dummyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

export const instanceCount = () => flr.count + dynLast; // diagnostics (floor + last dynamic flush)
