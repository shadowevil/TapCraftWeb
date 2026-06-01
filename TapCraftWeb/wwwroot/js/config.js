// TapCraft - engine, feel and layout constants (NOT game content).
//
// Game-CONTENT data (tiles, objects, items, recipes, drop/harvest balance,
// worldgen balance, default settings) lives in the external content pack
// wwwroot/data/gamedata.json and is read via the GD object in gamedata.js.
// What remains here is engine/render/feel math, fixed layout sizes that mirror
// the CSS, and localStorage keys - none of it is player-facing game content.
"use strict";

// --- Sprite geometry / projection (engine) ----------------------------
export const SPRITE = 32;     // base tile sprite is 32x32
export const HALF_W = 16;     // surface diamond half-width
export const HALF_H = 8;      // surface diamond half-height
export const OBJECT_LIFT = 8; // upward nudge for tall sprites, in sprite px (scaled by zoom)

// --- Loop timing (engine) ---------------------------------------------
export const TPS = 20;                  // simulation ticks per second
export const TICK_MS = 1000 / TPS;
export const MAX_FPS = 60;
export const FRAME_MS = 1000 / MAX_FPS;

// --- Persistence keys (infrastructure, not content) -------------------
export const WORLDS_KEY = "tapcraft.worlds";    // index: [{id, name, size, updatedAt}]
export const CURRENT_KEY = "tapcraft.current";  // last-opened world id
export const worldKey = (id) => "tapcraft.world." + id;
export const AUTOSAVE_MS = 5000;

// --- Main menu presentation (engine/feel) -----------------------------
export const MENU_SIZE = 32;   // background island size on the main menu
export const PARALLAX = 46;    // max menu parallax shift (px)

// --- Viewport / zoom (engine) -----------------------------------------
// Hard cap on cells swept per frame: the minimum zoom (max zoom-out) is derived
// so the visible window never exceeds this, keeping huge/infinite worlds smooth.
// Each visible cell costs a tile drawImage (plus per-cell work), so this directly
// bounds the render cost. Lower = smoother but less zoom-out range.
export const MAX_VISIBLE_CELLS = 8000;
// Below this zoom, cast shadows are skipped (they are sub-pixel/invisible when
// zoomed far out, and drawing one per entity is a big share of the entity pass).
export const SHADOW_MIN_ZOOM = 0.9;
// Below this zoom the water animation is frozen (one fixed frame). The floor is
// cached to an offscreen layer; freezing water keeps that cache valid every frame
// when zoomed out (waves are imperceptible there) so the floor isn't re-rendered.
export const WATER_ANIM_MIN_ZOOM = 2.0;
// Below this zoom cosmetic ground-cover decorations (flowers/grass patches) are not
// drawn: they are sub-pixel/imperceptible far out, and probing every visible cell for
// one would bloat the entity pass over huge/infinite worlds. Same spirit as
// SHADOW_MIN_ZOOM. `z` is part of the floor-cache key, so crossing this rebuilds.
export const DECOR_MIN_ZOOM = 1.2;
// Above this many visible entities (a dense forest/jungle filling the screen), per-object
// cast shadows are skipped this frame: at that density they overlap into mush, and the
// extra ~2 drawImage + canvas transform per object dominates the entity pass. The skip
// applies hysteresis (re-enables at 75% of this) so panning a forest edge doesn't flicker.
export const SHADOW_SKIP_COUNT = 500;

// --- Click "pop" + resource-drop physics (feel) -----------------------
export const POP_MS = 280;     // tree click "pop" duration
export const POP_AMOUNT = 0.22; // peak extra scale on the pop
export const DROP_GRAVITY = 520; // px/s^2 for a bouncing resource drop
export const DROP_BOUNCE = 0.45; // velocity retained per bounce
export const DROP_REST_VZ = 26;  // below this upward speed on landing, the drop settles
export const DROP_SCALE = 0.7;   // ground drop render scale (relative to icon, x zoom)
export const FLY_MS = 420;       // drop fly-to-bar duration

// --- Cast shadow render math (engine) ---------------------------------
// A black silhouette of each object, anchored at its base and sheared +
// flattened so it lies down on the ground (up-left) like a real shadow.
export const SHADOW_ALPHA = 0.32;
export const SHADOW_SKEW = 0.7;     // horizontal lean per unit of sprite height (up-left)
export const SHADOW_SQUASH = 0.6;   // vertical rise of the cast (bigger = steeper toward top-left)
export const SHADOW_POOL_ALPHA = 0.3; // grounding pool darkness under the object foot
export const SHADOW_POOL_RATIO = 0.4; // pool ellipse height / width (lower = flatter)

// --- Layout bar heights (must match game.css) -------------------------
export const TOPBAR_H = 42;    // main top bar height (px)
export const SUBBAR_H = 32;    // secondary bar height (px); canvas fills below both

// --- Tool cursor render (feel) ----------------------------------------
// Shown over a harvestable object with the OS cursor hidden. Each pivots at
// its handle grip (pinned to the mouse) and oscillates. The cursor sprite
// PATHS are content (GD.tools.<id>.icon); only the render geometry is here.
export const TOOL_SCALE = 1.5;        // render scale (sprites are 32x29)
export const TOOL_SWING_DEG = 60;     // oscillation arc
export const TOOL_SWING_MS = 520;     // full back-and-forth period
export const HATCHET_PIVOT_X = 27, HATCHET_PIVOT_Y = 28;        // bottom-right grip
export const PICKAXE_PIVOT_X = 27, PICKAXE_PIVOT_Y = 28;        // bottom-right grip (handle end)
