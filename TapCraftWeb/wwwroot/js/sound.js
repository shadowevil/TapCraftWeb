// TapCraft - audio engine (Web Audio API).
// A small 5-channel mixer: each channel (music, ambience, effects, building) is
// a GainNode routed through a master GainNode to the destination, so Master
// scales everything and each channel scales independently. SFX are one-shot
// buffer sources (overlap freely); ambience is two day tracks gently crossfading
// back and forth; wind is an overlay that plays a random clip with generous gaps.
// All sound files are data-driven (GD.sounds) and decoded once into buffers.
//
// Autoplay policy: browsers keep the context suspended until a user gesture, so
// resumeAudio() is called on the first pointerdown/keydown (see input.js).
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";

const CHANNELS = ["music", "ambience", "effects", "building"]; // master is the parent
const AUDIO_KEY = "tapcraft.audio";

// --- Settings (persisted globally) -----------------------------------
function defaultSettings() {
  const ch = GD.sounds.channels;
  const s = {};
  for (const name of ["master", ...CHANNELS]) s[name] = { vol: ch[name] != null ? ch[name] : 1, mute: false };
  return s;
}
function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem(AUDIO_KEY));
    if (o && typeof o === "object") {
      const s = defaultSettings();
      for (const name of Object.keys(s)) {
        if (o[name]) {
          if (typeof o[name].vol === "number") s[name].vol = Math.min(1, Math.max(0, o[name].vol));
          s[name].mute = !!o[name].mute;
        }
      }
      return s;
    }
  } catch (e) { /* ignore - use defaults */ }
  return defaultSettings();
}
function saveSettings() {
  try { localStorage.setItem(AUDIO_KEY, JSON.stringify(G.audio.settings)); } catch (e) { /* ignore */ }
}

// --- Graph setup -----------------------------------------------------
export function initAudio() {
  const A = G.audio;
  if (A.ctx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return; // no Web Audio - game runs silently
  A.ctx = new Ctx();
  A.settings = loadSettings();
  A.masterGain = A.ctx.createGain();
  A.masterGain.connect(A.ctx.destination);
  for (const name of CHANNELS) {
    const g = A.ctx.createGain();
    g.connect(A.masterGain);
    A.channels[name] = g;
  }
  applyAllGains();
}

function gainFor(name) { const s = G.audio.settings[name]; return s.mute ? 0 : s.vol; }
function applyAllGains() {
  if (!G.audio.ctx) return;
  G.audio.masterGain.gain.value = gainFor("master");
  for (const name of CHANNELS) G.audio.channels[name].gain.value = gainFor(name);
}

// Resume the context after the first user gesture (autoplay policy).
export function resumeAudio() {
  const A = G.audio;
  if (!A.ctx || A.resumed) return;
  A.resumed = true;
  if (A.ctx.state === "suspended") A.ctx.resume();
  startAmbience(); // safe to (re)start once we can actually hear it
}

// --- Loading ---------------------------------------------------------
// Collect every unique sound URL referenced by GD.sounds.
function allSoundUrls() {
  const s = GD.sounds, urls = new Set();
  (s.ambience.day || []).forEach((u) => urls.add(u));
  (s.ambience.night || []).forEach((u) => urls.add(u));
  for (const k of Object.keys(s.overlays || {})) {
    const o = s.overlays[k];
    if (o.src) urls.add(o.src);
    (o.srcs || []).forEach((u) => urls.add(u));
  }
  for (const g of Object.keys(s.effects || {})) (s.effects[g] || []).forEach((u) => urls.add(u));
  return [...urls];
}
// Fetch + decode all sounds into the buffer cache. Per-file failures are
// non-fatal (a missing/undecodable file just stays silent), so the game still
// runs if an asset is absent.
export function loadSounds() {
  if (!G.audio.ctx) return Promise.resolve();
  const ctx = G.audio.ctx;
  return Promise.all(allSoundUrls().map((url) =>
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => { G.audio.buffers[url] = decoded; })
      .catch((e) => { console.warn("TapCraft: sound failed to load:", url, e); })
  ));
}

// --- One-shot SFX ----------------------------------------------------
function pick(list) { return (list && list.length) ? list[Math.floor(Math.random() * list.length)] : null; }

// Play a random clip from an effects group on a channel. volScale further
// attenuates this one play (used for the reduced building-caused hits).
export function playSfx(group, channel = "effects", volScale = 1) {
  const A = G.audio;
  if (!A.ctx || !A.resumed) return;
  const url = pick(GD.sounds.effects[group]);
  const buf = url && A.buffers[url];
  if (!buf) return;
  const src = A.ctx.createBufferSource();
  src.buffer = buf;
  const node = A.channels[channel] || A.channels.effects;
  if (volScale === 1) {
    src.connect(node);
  } else {
    const g = A.ctx.createGain();
    g.gain.value = volScale;
    src.connect(g); g.connect(node);
  }
  src.start();
}

// Building-caused hit: reduced volume + a single global rate cap so any number
// of buildings stays an ambient texture rather than a wall of hits.
export function playBuildingSfx(group) {
  const A = G.audio;
  if (!A.ctx || !A.resumed) return;
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  if (now - A.lastBuildingSfxAt < GD.sounds.buildingSfxMinGapMs) return;
  A.lastBuildingSfxAt = now;
  playSfx(group, "building", GD.sounds.buildingVolume);
}

// --- Ambience (two day tracks, continuous gentle crossfade) ----------
function playLoopFadeIn(url, channelName, fadeMs) {
  const A = G.audio;
  const buf = A.buffers[url];
  if (!buf) return null;
  const src = A.ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const g = A.ctx.createGain();
  const t = A.ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(1, t + fadeMs / 1000);
  src.connect(g); g.connect(A.channels[channelName]);
  src.start();
  return { src, gain: g };
}
function fadeOutStop(node, fadeMs) {
  if (!node) return;
  const A = G.audio, t = A.ctx.currentTime;
  try {
    node.gain.gain.cancelScheduledValues(t);
    node.gain.gain.setValueAtTime(node.gain.gain.value, t);
    node.gain.gain.linearRampToValueAtTime(0.0001, t + fadeMs / 1000);
    node.src.stop(t + fadeMs / 1000 + 0.05);
  } catch (e) { /* already stopped */ }
}

export function startAmbience() {
  const A = G.audio;
  if (!A.ctx || !A.resumed) return;
  if (A.ambience) return; // already running
  const tracks = GD.sounds.ambience.day || [];
  if (!tracks.length || !tracks.some((u) => A.buffers[u])) return; // nothing decoded yet
  const cf = GD.sounds.ambience.crossfadeMs, hold = GD.sounds.ambience.trackHoldMs;
  const state = { idx: 0, node: null, timer: null };
  A.ambience = state;
  const playIdx = (i) => {
    state.node = playLoopFadeIn(tracks[i], "ambience", cf);
    state.idx = i;
    state.timer = setTimeout(next, hold + cf);
  };
  const next = () => {
    const ni = (state.idx + 1) % tracks.length;
    const old = state.node;
    state.node = playLoopFadeIn(tracks[ni], "ambience", cf);
    state.idx = ni;
    fadeOutStop(old, cf);
    state.timer = setTimeout(next, hold + cf);
  };
  playIdx(0);
  startWind();
}
export function stopAmbience() {
  const A = G.audio;
  if (A.ambience) {
    clearTimeout(A.ambience.timer);
    fadeOutStop(A.ambience.node, 500);
    A.ambience = null;
  }
  if (A.windTimer) { clearTimeout(A.windTimer); A.windTimer = null; }
}

// --- Wind overlay (random clip, generous gap AFTER each finishes) ----
function startWind() {
  const A = G.audio;
  const w = GD.sounds.overlays && GD.sounds.overlays.wind;
  if (!w || A.windTimer) return;
  const scheduleNext = () => {
    const gap = w.gapMinMs + Math.random() * (w.gapMaxMs - w.gapMinMs);
    A.windTimer = setTimeout(playOnce, gap);
  };
  const playOnce = () => {
    A.windTimer = null;
    const url = pick(w.srcs);
    const buf = url && A.buffers[url];
    if (!buf) { scheduleNext(); return; } // nothing to play, keep the cadence
    const src = A.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(A.channels[w.channel] || A.channels.ambience);
    src.onended = scheduleNext; // gap timer starts only after the clip finishes
    src.start();
  };
  scheduleNext();
}

// --- Looping overlays (rain) - wired, not triggered yet --------------
export function startOverlay(id) {
  const A = G.audio;
  if (!A.ctx || !A.resumed || A.overlays[id]) return;
  const o = GD.sounds.overlays && GD.sounds.overlays[id];
  if (!o || !o.src || !A.buffers[o.src]) return;
  const src = A.ctx.createBufferSource();
  src.buffer = A.buffers[o.src]; src.loop = !!o.loop;
  src.connect(A.channels[o.channel] || A.channels.ambience);
  src.start();
  A.overlays[id] = { src };
}
export function stopOverlay(id) {
  const ov = G.audio.overlays[id];
  if (ov) { try { ov.src.stop(); } catch (e) { /* ignore */ } delete G.audio.overlays[id]; }
}

// --- Channel controls (for the options modal) ------------------------
export function getAudioSettings() { return G.audio.settings || (G.audio.settings = loadSettings()); }
export function setChannelVolume(name, vol) {
  const s = getAudioSettings();
  if (!s[name]) return;
  s[name].vol = Math.min(1, Math.max(0, vol));
  applyAllGains();
  saveSettings();
}
export function setChannelMute(name, mute) {
  const s = getAudioSettings();
  if (!s[name]) return;
  s[name].mute = !!mute;
  applyAllGains();
  saveSettings();
}
