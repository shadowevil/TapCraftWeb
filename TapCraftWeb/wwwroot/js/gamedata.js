// TapCraft - external game-content pack (tiles, objects, items, recipes,
// worldgen balance, defaults). Loaded once at startup and cached in
// localStorage, so the player downloads it once and then uses it like local
// data (same model as the save games in persistence.js).
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

// IMPORTANT: bump this TOGETHER with the "version" field in
// wwwroot/data/gamedata.json whenever you edit the data file. The cached copy
// is reused only when its version matches this value; otherwise it re-fetches.
export const EXPECTED_VERSION = 45;

const CACHE_KEY = "tapcraft.gamedata";
// Relative (no leading slash) so it resolves against the page, working both at the
// site root (.NET dev) and under a GitHub Pages project sub-path (/<repo>/).
const DATA_URL = "data/gamedata.json";

function readCache() {
  try {
    const o = JSON.parse(localStorage.getItem(CACHE_KEY));
    return (o && o.version != null && o.data) ? o : null;
  } catch (e) { return null; }
}
function writeCache(obj) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); }
  catch (e) { /* storage full / unavailable - fine, we just refetch next time */ }
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

// Cache-first, then network. Returns GD (also the shared import).
// Failure strategy: a stale cache (any version) is used if the network fails,
// so the game still runs offline; only a fetch failure with NO cache rejects.
export async function loadGameData() {
  const cached = readCache();
  if (cached && cached.version === EXPECTED_VERSION) { populate(cached.data); return GD; }
  try {
    const res = await fetch(DATA_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    writeCache({ version: data.version, data });
    populate(data);
    return GD;
  } catch (e) {
    if (cached) { console.warn("TapCraft: using cached game data (fetch failed):", e); populate(cached.data); return GD; }
    throw e; // no cache and no network -> caller shows a hard-fail message
  }
}
