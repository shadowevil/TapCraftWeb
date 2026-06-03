// TapCraft - external game-content pack (tiles, objects, items, recipes,
// worldgen balance, defaults). NETWORK-FIRST: re-fetched on every load (the browser
// revalidates via ETag, so an unchanged file is a cheap 304), with the localStorage
// copy kept ONLY as an offline fallback. So editing gamedata.json takes effect on the
// next refresh with no version bump needed.
//
// GD is a single stable object populated in place after the fetch (mirroring
// the runtime-state object G in state.js). Consumers `import { GD }` and read
// e.g. GD.crafting.recipes / GD.objects.tree.drop. This is safe ONLY because
// every content value is read inside a function body at runtime, never at
// module top-level eval time (so the data is present by the time it is read).
"use strict";

// The single shared content object. Identity is fixed at module-eval time so
// every importer holds the same live reference; loadGameData() fills it in.
export const GD = {};

// NOTE: gamedata.json's "version" field is INFORMATIONAL now (handy for tracking a
// content-pack release); the loader no longer gates on it - see loadGameData below.
// Editing gamedata.json needs no version bump; just refresh.

const CACHE_KEY = "tapcraft.gamedata";
// Relative (no leading slash) so it resolves against the page, working both at the
// site root (.NET dev) and under a GitHub Pages project sub-path (/<repo>/).
const DATA_URL = "data/gamedata.json";

// The localStorage copy is ONLY an offline fallback now: store/return the last
// successfully-fetched pack data (no version gating). Tolerates the old {version,data}
// cache shape too (it still has .data).
function readCache() {
  try { const o = JSON.parse(localStorage.getItem(CACHE_KEY)); return (o && o.data) ? o.data : null; }
  catch (e) { return null; }
}
function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data })); }
  catch (e) { /* storage full / unavailable - fine */ }
}

// Copy data into GD in place and compute derived values. Clearing first keeps
// a re-load from leaving stale keys behind.
function populate(data) {
  for (const k of Object.keys(GD)) delete GD[k];
  Object.assign(GD, data);
  // Derived: the mature growth stage index = number of pre-mature stage sprites
  // (sprout 0 -> sapling 1 -> ... -> mature N). Adding a stage needs no code edit.
  GD.matureStage = GD.objects.tree.stageSprites.length;
}

// --- DEV live-reload --------------------------------------------------
// On localhost only, poll gamedata.json and HOT-APPLY edits (re-populate GD) when the file
// changes, so render-time tweaks (object/decor yOffset, sprite mappings, colours) update in
// REAL TIME with no refresh - the render loop runs continuously so the next entity-pass frame
// shows it, and a "tapcraft:packreload" event tells render.js to drop its floor cache too. NOT
// hot-applied: the per-world gen snapshot, so worldgen BALANCE (densities/climate) still needs a
// new world. Disabled on the deployed static host (the pack never changes there).
let lastPackText = null, liveReloadOn = false;
function startDevLiveReload() {
  if (liveReloadOn) return;
  const h = location.hostname;
  if (!(h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "")) return; // dev only
  liveReloadOn = true;
  setInterval(async () => {
    let text;
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" }); // revalidates; cheap 304 when unchanged
      if (!res.ok) return;
      text = await res.text();
    } catch (e) { return; } // transient hiccup - retry next tick
    if (text === lastPackText) return;
    lastPackText = text;
    let data;
    try { data = JSON.parse(text); }
    catch (e) { lastPackText = null; console.warn("[TapCraft] live-reload: gamedata.json is not valid JSON (mid-save or a typo?) - not applied"); return; } // retry next tick
    populate(data);
    writeCache(data);
    window.dispatchEvent(new Event("tapcraft:packreload")); // render.js drops its floor cache
    console.info("[TapCraft] gamedata.json hot-reloaded live");
  }, 1000);
}

// NETWORK-FIRST. Returns GD (also the shared import). Always re-fetch the pack;
// `cache: "no-cache"` makes the browser revalidate (a cheap 304 when unchanged), so
// edits to gamedata.json are picked up on the next refresh with no version bump. The
// localStorage copy is used ONLY when the fetch fails (offline) so the game still runs;
// only a failure with NO cached copy rejects (caller shows a hard-fail message).
export async function loadGameData() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const data = JSON.parse(text);
    lastPackText = text;          // baseline for the dev live-reload diff
    writeCache(data);
    populate(data);
    startDevLiveReload();          // dev-only: hot-apply later edits with no refresh
    return GD;
  } catch (e) {
    const cached = readCache();
    if (cached) { console.warn("TapCraft: using cached game data (fetch failed):", e); populate(cached); return GD; }
    throw e; // no network AND no cached copy -> hard fail
  }
}
