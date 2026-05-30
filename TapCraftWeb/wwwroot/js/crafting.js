// TapCraft - crafting logic, craft panel UI and the crafted HUD.
// Moved verbatim from the original game.js IIFE.
"use strict";

import { G } from "./state.js";
import { GD } from "./gamedata.js";
import { craftPanel, craftListEl, craftedHud } from "./dom.js";
import { updateResourceUI } from "./ui.js";
import { addTool } from "./resources.js";

// Recipe name/icon are not stored on the recipe (deduped): they come from the
// tool the recipe produces.
function recipeTool(id) { return GD.tools[GD.crafting.recipes[id].tool]; }

// --- Crafting ---------------------------------------------------------
export function craftCost(id, amount) {
  const c = GD.crafting.recipes[id].cost;
  return { wood: c.wood * amount, stone: c.stone * amount };
}
export function canAfford(id, amount) {
  const cost = craftCost(id, amount);
  return G.world.wood >= cost.wood && G.world.stone >= cost.stone;
}
// Resources already spoken for by queued-but-not-yet-charged units across all
// jobs (the currently-crafting unit of each job is already charged/deducted).
export function reservedCost() {
  let wood = 0, stone = 0;
  if (G.world.craft) {
    for (const id in G.world.craft) {
      const job = G.world.craft[id];
      const uncharged = job.remaining - (job.charged ? 1 : 0);
      const c = GD.crafting.recipes[id].cost;
      wood += c.wood * uncharged;
      stone += c.stone * uncharged;
    }
  }
  return { wood, stone };
}
// What can still be committed to NEW queue entries right now.
export function spendable() {
  const r = reservedCost();
  return { wood: G.world.wood - r.wood, stone: G.world.stone - r.stone };
}

// Queue crafting (deferred charge): enqueue up to `amount`, but only as many
// as currently-uncommitted resources can cover. Nothing is charged here; each
// unit is paid for when it actually starts crafting (see advanceCrafting).
export function startCraft(id, amount) {
  amount = Math.max(1, Math.min(GD.crafting.craftMax, amount | 0));
  const c = GD.crafting.recipes[id].cost;
  const sp = spendable();
  let add = 0;
  while (add < amount && sp.wood >= c.wood && sp.stone >= c.stone) {
    sp.wood -= c.wood; sp.stone -= c.stone; add++;
  }
  if (add <= 0) return;
  const job = G.world.craft[id] || (G.world.craft[id] = { remaining: 0, elapsed: 0, charged: false });
  job.remaining += add;
  updateCraftPanel();
}

// Cancel a queue: keep the in-progress unit (it finishes), drop all pending.
export function cancelCraft(id) {
  const job = G.world.craft[id];
  if (!job) return;
  if (job.charged) job.remaining = 1; // the active unit was paid for; let it finish
  else delete G.world.craft[id];
  updateCraftPanel();
}

// The single job currently crafting: the first queued one (insertion order).
export function firstCraftId() {
  for (const id in G.world.craft) {
    if (G.world.craft[id].remaining > 0) return id;
  }
  return null;
}

// Only ONE item crafts at a time (globally). Charge + produce one unit per
// CRAFT_MS for the active job; every other queued job just waits its turn.
export function advanceCrafting(dtMs) {
  for (const id in G.world.craft) {           // sweep any emptied jobs
    if (G.world.craft[id].remaining <= 0) delete G.world.craft[id];
  }
  const id = firstCraftId();
  if (id) {
    const job = G.world.craft[id];
    if (!job.charged) {
      if (!canAfford(id, 1)) { delete G.world.craft[id]; } // safety net
      else {
        const c = GD.crafting.recipes[id].cost;
        G.world.wood -= c.wood; G.world.stone -= c.stone;
        job.charged = true;
        updateResourceUI();
      }
    }
    if (job.charged) {
      job.elapsed += dtMs;
      if (job.elapsed >= GD.crafting.craftMs) {
        job.elapsed -= GD.crafting.craftMs;
        job.remaining -= 1;
        job.charged = false;
        addTool(GD.crafting.recipes[id].tool);
        if (job.remaining <= 0) delete G.world.craft[id];
      }
    }
  }
  if (!craftPanel.classList.contains("hidden")) updateCraftPanel();
}

// --- Crafting panel & crafted HUD ------------------------------------
export function buildCraftPanel() {
  craftListEl.innerHTML = "";
  for (const id of Object.keys(GD.crafting.recipes)) {
    const tool = recipeTool(id);
    const entry = document.createElement("div");
    entry.className = "tc-craft-entry";

    const main = document.createElement("div");
    main.className = "tc-craft-main";

    const icon = document.createElement("img");
    icon.className = "tc-craft-icon";
    icon.src = tool.icon; icon.alt = tool.name;

    const mid = document.createElement("div");
    mid.className = "tc-craft-mid";
    const name = document.createElement("div");
    name.className = "tc-craft-name";
    name.textContent = tool.name;
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "1"; slider.max = String(GD.crafting.craftMax); slider.value = "1";
    slider.className = "tc-craft-slider";
    const cost = document.createElement("div");
    cost.className = "tc-craft-cost";
    const woodC = costSpan(GD.resources.wood.icon);
    const stoneC = costSpan(GD.resources.stone.icon);
    cost.append(woodC.wrap, stoneC.wrap);
    mid.append(name, slider, cost);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tc-craft-do";

    main.append(icon, mid, button);
    entry.append(main);
    craftListEl.appendChild(entry);

    G.craftEntries[id] = { slider, costWood: woodC.val, costStone: stoneC.val, button };
    slider.addEventListener("input", updateCraftPanel);
    button.addEventListener("click", () => startCraft(id, +slider.value));
  }

  // Queue list: stacked-by-type, each row shows count + progress; hover to
  // cancel the pending units (the in-progress one always finishes).
  G.craftQueueHead = document.createElement("div");
  G.craftQueueHead.className = "tc-queue-head";
  G.craftQueueHead.textContent = "Queue";
  G.craftQueueEl = document.createElement("div");
  G.craftQueueEl.className = "tc-craft-queue";
  craftListEl.append(G.craftQueueHead, G.craftQueueEl);

  updateCraftPanel();
}

export function costSpan(iconSrc) {
  const wrap = document.createElement("span");
  wrap.className = "tc-cost-item";
  const img = document.createElement("img");
  img.src = iconSrc;
  const val = document.createElement("span");
  wrap.append(img, val);
  return { wrap, val };
}

export function createQueueItem(id) {
  const tool = recipeTool(id);
  const el = document.createElement("div");
  el.className = "tc-queue-item";
  el.title = "Cancel pending " + tool.name;

  const img = document.createElement("img");
  img.src = tool.icon; img.alt = tool.name;
  const count = document.createElement("span");
  count.className = "tc-queue-count";
  const prog = document.createElement("div");
  prog.className = "tc-queue-progress";
  const fill = document.createElement("div");
  fill.className = "tc-queue-progress-fill";
  prog.appendChild(fill);
  const cancel = document.createElement("div");
  cancel.className = "tc-queue-cancel";
  cancel.textContent = "X";

  el.append(img, count, prog, cancel);
  el.addEventListener("click", () => cancelCraft(id));
  return { el, count, fill };
}

export function updateCraftPanel() {
  const sp = spendable();
  for (const id of Object.keys(G.craftEntries)) {
    const e = G.craftEntries[id];
    const amount = +e.slider.value;
    const cost = craftCost(id, amount);
    const unit = GD.crafting.recipes[id].cost;
    e.costWood.textContent = cost.wood;
    e.costStone.textContent = cost.stone;
    // Red when the (uncommitted) resources can't cover the requested batch.
    e.costWood.classList.toggle("tc-short", sp.wood < cost.wood);
    e.costStone.classList.toggle("tc-short", sp.stone < cost.stone);
    e.button.textContent = "Craft x" + amount;
    // Enabled when at least one more unit can be queued (the rest cap at what
    // is affordable). Disabled outside an active world.
    e.button.disabled = !G.hasWorld || sp.wood < unit.wood || sp.stone < unit.stone;
  }
  updateCraftQueue();
}

// Diff the queue rows against world.craft: create/remove on change, update
// count + progress in place every frame so hover/cancel stays stable.
export function updateCraftQueue() {
  if (!G.craftQueueEl) return;
  let any = false;
  for (const id of Object.keys(GD.crafting.recipes)) {
    const job = G.world.craft && G.world.craft[id];
    let qi = G.queueItems[id];
    if (job && job.remaining > 0) {
      any = true;
      if (!qi) { qi = createQueueItem(id); G.queueItems[id] = qi; G.craftQueueEl.appendChild(qi.el); }
      qi.count.textContent = "x" + job.remaining;
      qi.fill.style.width = (job.charged ? Math.min(1, job.elapsed / GD.crafting.craftMs) : 0) * 100 + "%";
    } else if (qi) {
      qi.el.remove();
      delete G.queueItems[id];
    }
  }
  G.craftQueueHead.style.display = any ? "" : "none";
}

export function updateCraftedHud() {
  craftedHud.innerHTML = "";
  if (!G.world.tools) return;
  for (const toolType of Object.keys(GD.tools)) {
    const t = G.world.tools[toolType];
    if (!t || t.count <= 0) continue;
    const def = GD.tools[toolType];
    const item = document.createElement("div");
    item.className = "tc-crafted-item";
    const img = document.createElement("img");
    img.src = def.icon; img.alt = def.name; img.title = def.name;
    const count = document.createElement("span");
    count.className = "tc-crafted-count";
    count.textContent = t.count;
    const dura = document.createElement("div");
    dura.className = "tc-crafted-dura";
    const df = document.createElement("div");
    df.className = "tc-crafted-dura-fill";
    df.style.width = (t.dura / GD.harvest.toolDurability) * 100 + "%";
    dura.appendChild(df);
    item.append(img, count, dura);
    craftedHud.appendChild(item);
  }
}

export function toggleCraftPanel() {
  craftPanel.classList.toggle("hidden");
  if (!craftPanel.classList.contains("hidden")) updateCraftPanel();
}
