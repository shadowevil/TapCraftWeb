// TapCraft - lightweight per-frame profiler. Records smoothed (EMA) wall-clock
// times for named phases plus a few counters, surfaced in the debug overlay
// (console: `debugoverlay true`). Zero cost when off: every call early-returns
// unless PERF.on is set, and PERF.on is driven by G.debugOverlay each frame.
"use strict";

export const PERF = {
  on: false,
  ms: {},       // phase name -> smoothed milliseconds
  count: {},    // counter name -> last value
  order: [],    // phase names in first-seen order (stable display)
  fps: 0,
};

const SMOOTH = 0.1; // EMA weight for new samples

// Start a span (returns a timestamp, or 0 when profiling is off).
export function pBegin() { return PERF.on ? performance.now() : 0; }

// End a span started with pBegin: fold the elapsed ms into the phase's EMA.
export function pEnd(name, t0) {
  if (!PERF.on) return;
  const d = performance.now() - t0;
  const prev = PERF.ms[name];
  if (prev === undefined) { PERF.ms[name] = d; PERF.order.push(name); }
  else PERF.ms[name] = prev + (d - prev) * SMOOTH;
}

export function pCount(name, n) { if (PERF.on) PERF.count[name] = n; }

// Fold a frame delta (ms) into a smoothed FPS readout.
export function pFps(dtMs) {
  if (!PERF.on || dtMs <= 0) return;
  const inst = 1000 / dtMs;
  PERF.fps = PERF.fps ? PERF.fps + (inst - PERF.fps) * SMOOTH : inst;
}
