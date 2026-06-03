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

// Ambience-loop gain target (1 = full). Ducked below 1 while it rains so the rain
// overlay (also on the ambience channel) stands out over the bird/day loops. Held in
// a module var so it survives track crossfades (every loop fades in toward it).
let ambienceDuck = 1;
let rainApplied = -1; // last rain level pushed to the audio graph (throttle re-ramps)
let viewSnowApplied = 0; // last view-snowiness pushed to the audio graph
let windSnow = 0;        // current view-snowiness for the wind scheduler (more gusts when snowy)

// Recompute the ambience-loop duck from BOTH rain and view-snowiness: rain ducks the
// bird/day ambience so it reads through, and a snowy view ducks it harder (cold = quiet
// but for the wind). Re-applied across track crossfades (every loop fades toward this).
function applyAmbienceDuck() {
  const A = G.audio;
  const birdDuck = (GD.weather && GD.weather.birdDuck != null) ? GD.weather.birdDuck : 0.6;
  ambienceDuck = Math.max(0, (1 - Math.max(0, rainApplied) * birdDuck) * (1 - viewSnowApplied * 0.9));
  if (A.ambience && A.ambience.node && A.ambience.node.gain) rampGain(A.ambience.node.gain.gain, ambienceDuck, 0.8);
}
// Fade the bird/day ambience down + lean on the wind overlay as the VIEW gets snowy (the
// cold biome). Called each tick from weather.js with G.viewSnow.
export function setViewSnowAudio(snow) {
  const A = G.audio;
  if (!A.ctx || !A.resumed) return;
  windSnow = snow;
  if (Math.abs(snow - viewSnowApplied) < 0.03) return;
  viewSnowApplied = snow;
  applyAmbienceDuck();
}

// Ramp a GainParam toward a target over `sec`, from its current value (no click).
function rampGain(p, target, sec) {
  const t = G.audio.ctx.currentTime;
  try { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(target, t + sec); }
  catch (e) { try { p.value = target; } catch (e2) { /* ignore */ } }
}

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

// Channels silenced while the game is paused (world + ambient); music plays on.
const PAUSABLE = new Set(["ambience", "effects", "building"]);
function gainFor(name) {
  const s = G.audio.settings[name];
  if (G.audio.worldPaused && PAUSABLE.has(name)) return 0; // ducked while paused
  return s.mute ? 0 : s.vol;
}
function applyAllGains() {
  if (!G.audio.ctx) return;
  G.audio.masterGain.gain.value = gainFor("master");
  for (const name of CHANNELS) G.audio.channels[name].gain.value = gainFor(name);
}

// Pause/resume the world + ambient sound (music keeps playing). Ramped briefly so
// the ambience loop fades rather than clicking. Called from setRunning (play/pause).
export function setWorldAudioPaused(paused) {
  const A = G.audio;
  A.worldPaused = !!paused;
  if (!A.ctx) return;
  const t = A.ctx.currentTime;
  for (const name of CHANNELS) {
    const g = A.channels[name].gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(gainFor(name), t + 0.18);
    } catch (e) { g.value = gainFor(name); }
  }
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
  ((s.thunder && s.thunder.clips) || []).forEach((c) => { if (c.src) urls.add(c.src); });
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
  const target = channelName === "ambience" ? ambienceDuck : 1; // honor the rain duck
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(target, t + fadeMs / 1000);
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

function ambienceTracks(mode) { return GD.sounds.ambience[mode] || GD.sounds.ambience.day || []; }
function tracksReady(tracks) { return tracks.length && tracks.some((u) => G.audio.buffers[u]); }
// Day vs night from the current time-of-day phase (computed inline to avoid a
// circular import with env.js, which calls setAmbienceMode below).
function curAmbienceMode() { return (-Math.cos((G.world.timeOfDay || 0) * Math.PI * 2) < 0) ? "night" : "day"; }

export function startAmbience() {
  const A = G.audio;
  if (!A.ctx || !A.resumed || A.ambience) return; // need audio + not already running
  const cf = GD.sounds.ambience.crossfadeMs, hold = GD.sounds.ambience.trackHoldMs;
  let mode = curAmbienceMode();
  let tracks = ambienceTracks(mode);
  if (!tracksReady(tracks)) { mode = "day"; tracks = ambienceTracks("day"); } // night set undecoded -> day
  if (!tracksReady(tracks)) return; // nothing decoded yet
  const state = { mode, tracks, idx: 0, node: null, timer: null, startTimer: null, next: null };
  A.ambience = state;
  state.next = () => {
    const ni = (state.idx + 1) % state.tracks.length;
    const old = state.node;
    state.node = playLoopFadeIn(state.tracks[ni], "ambience", cf);
    state.idx = ni;
    fadeOutStop(old, cf);
    state.timer = setTimeout(state.next, hold + cf);
  };
  state.node = playLoopFadeIn(state.tracks[0], "ambience", cf);
  state.timer = setTimeout(state.next, hold + cf);
  startWind();
}

// Hand the ambience over to the day or night track set (called by env.js on the
// dawn/dusk flip). No-op if already in that mode or the requested set isn't decoded.
// This is a GRADUAL sequential handoff, not an abrupt swap: the current set fades
// fully out over modeFadeMs, and the new set is gently brought in partway through
// that fade - so the daytime sounds taper off and, just as they end, the night
// sounds rise in (and vice versa). The overlapping tail keeps it from going silent.
export function setAmbienceMode(mode) {
  const A = G.audio;
  if (!A.ctx || !A.resumed || !A.ambience) return;
  const want = mode === "night" ? "night" : "day";
  if (A.ambience.mode === want) return;
  const tracks = ambienceTracks(want);
  if (!tracksReady(tracks)) return; // requested set unavailable - keep current
  const cf = GD.sounds.ambience.crossfadeMs, hold = GD.sounds.ambience.trackHoldMs;
  const fade = GD.sounds.ambience.modeFadeMs || cf * 2;
  const old = A.ambience.node;
  fadeOutStop(old, fade);                 // gradually lose the current set
  A.ambience.mode = want; A.ambience.tracks = tracks; A.ambience.idx = 0;
  A.ambience.node = null;                 // nothing "current" during the handoff
  clearTimeout(A.ambience.timer); A.ambience.timer = null;
  clearTimeout(A.ambience.startTimer);
  // Bring the new set in once the old one is well into its fade-out.
  A.ambience.startTimer = setTimeout(() => {
    A.ambience.startTimer = null;
    if (!A.ambience || A.ambience.mode !== want) return; // flipped again meanwhile
    A.ambience.node = playLoopFadeIn(tracks[0], "ambience", Math.round(fade * 0.7));
    A.ambience.timer = setTimeout(A.ambience.next, hold + cf);
  }, Math.round(fade * 0.6));
}
export function stopAmbience() {
  const A = G.audio;
  if (A.ambience) {
    clearTimeout(A.ambience.timer);
    clearTimeout(A.ambience.startTimer);
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
    // A snowy view makes the wind gusts much more frequent (the cold biome's voice).
    const gap = (w.gapMinMs + Math.random() * (w.gapMaxMs - w.gapMinMs)) * (1 - windSnow * 0.7);
    A.windTimer = setTimeout(playOnce, Math.max(400, gap));
  };
  const playOnce = () => {
    A.windTimer = null;
    const url = pick(w.srcs);
    const buf = url && A.buffers[url];
    if (!buf) { scheduleNext(); return; } // nothing to play, keep the cadence
    const src = A.ctx.createBufferSource();
    src.buffer = buf;
    // Fade the gust in and back out (it used to start/stop abruptly).
    const g = A.ctx.createGain();
    const t = A.ctx.currentTime, d = buf.duration, fade = Math.min((w.fadeMs || 1800) / 1000, d / 2);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(1, t + fade);
    g.gain.setValueAtTime(1, t + Math.max(fade, d - fade));
    g.gain.linearRampToValueAtTime(0.0001, t + d);
    src.connect(g); g.connect(A.channels[w.channel] || A.channels.ambience);
    src.onended = scheduleNext; // gap timer starts only after the clip finishes
    src.start();
  };
  scheduleNext();
}

// --- Looping overlays (rain) -----------------------------------------
// Start at silence with a gain node; the caller (setRainAudio) ramps it to the
// wanted level so it fades in rather than popping on.
export function startOverlay(id) {
  const A = G.audio;
  if (!A.ctx || !A.resumed || A.overlays[id]) return;
  const o = GD.sounds.overlays && GD.sounds.overlays[id];
  if (!o || !o.src || !A.buffers[o.src]) return;
  const src = A.ctx.createBufferSource();
  src.buffer = A.buffers[o.src]; src.loop = !!o.loop;
  const g = A.ctx.createGain();
  g.gain.setValueAtTime(0.0001, A.ctx.currentTime);
  src.connect(g); g.connect(A.channels[o.channel] || A.channels.ambience);
  src.start();
  A.overlays[id] = { src, gain: g };
}
export function stopOverlay(id) {
  const A = G.audio, ov = A.overlays[id];
  if (!ov) return;
  delete A.overlays[id];
  if (ov.gain && A.ctx) {
    const t = A.ctx.currentTime;
    try {
      ov.gain.gain.cancelScheduledValues(t);
      ov.gain.gain.setValueAtTime(ov.gain.gain.value, t);
      ov.gain.gain.linearRampToValueAtTime(0.0001, t + 1.0);
      ov.src.stop(t + 1.05);
    } catch (e) { try { ov.src.stop(); } catch (e2) { /* ignore */ } }
  } else { try { ov.src.stop(); } catch (e) { /* ignore */ } }
}

// Drive the rain audio from the live rain level (0..1): fade the looping rain
// overlay in/out and DUCK the ambience loop (the bird/day-ambience) so the rain
// reads through it. Both share the ambience channel, so we duck the loop's own gain
// (re-applied across crossfades via ambienceDuck), not the whole channel. Called
// every frame by weather.js, throttled so we only re-ramp on a real change.
export function setRainAudio(level) {
  const A = G.audio;
  if (!A.ctx || !A.resumed) return;
  if (Math.abs(level - rainApplied) < 0.02 && !(level <= 0.04 && A.overlays.rain)) return;
  rainApplied = level;
  applyAmbienceDuck(); // combined rain + view-snow duck of the bird ambience
  const wantRain = level > 0.04;
  if (wantRain) {
    if (!A.overlays.rain) startOverlay("rain");
    if (A.overlays.rain && A.overlays.rain.gain) rampGain(A.overlays.rain.gain.gain, level, 1.2);
  } else if (A.overlays.rain) {
    stopOverlay("rain");
  }
}

// One-shot thunder clap: a random clip from GD.sounds.thunder, played at its own
// per-clip level x the caller's volume scale (distance-based). On the ambience
// channel, so it's ducked while paused like the rest of the world audio.
export function playThunder(volScale) {
  const A = G.audio;
  if (!A.ctx || !A.resumed) return;
  const t = GD.sounds.thunder;
  if (!t || !t.clips || !t.clips.length) return;
  const clip = t.clips[(Math.random() * t.clips.length) | 0];
  const buf = clip && A.buffers[clip.src];
  if (!buf) return;
  const src = A.ctx.createBufferSource();
  src.buffer = buf;
  const g = A.ctx.createGain();
  g.gain.value = Math.max(0, Math.min(1, (clip.level != null ? clip.level : 1) * volScale));
  src.connect(g); g.connect(A.channels[t.channel] || A.channels.ambience);
  src.start();
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
