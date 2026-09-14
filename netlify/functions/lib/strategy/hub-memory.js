// What is happening across the whole Hub, rather than inside one brand.
//
// Mani could already answer deep questions about a single brand, but every question had to
// name one first. That makes the questions people actually ask unanswerable: "what is Anjali
// working on?", "who has made anything for Casa this week?", "what's overdue across
// everything?" — none of those belong to one brand, and all of them have exact recorded
// answers sitting in Hub.
//
// So this is the wide view: every active brand, who is on it, what is open and overdue, and
// who has been making what in Visual Studio. Deliberately a ROLL-UP rather than every brand's
// full memory concatenated — that would be enormous, mostly irrelevant to any given question,
// and would push the useful part out of the model's attention.
//
// A boundary worth stating plainly: this wide view is for a HUMAN asking Mani a question. The
// stage prompts stay brand-scoped, exactly as they are. One client's specifics have no
// business leaking into another client's brief just because both live in the same Hub.
"use strict";
const { fbGet } = require("./firebase");
const { collectTeamActivity } = require("./team-activity");
const { loadVisualHistory } = require("./visual-memory");
const { loadBrain } = require("./brand-brain");

const MAX_BRANDS = 40;
const MAX_VISUAL_PER_BRAND = 5;
const MAX_TASKS_PER_BRAND = 8;

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Every brand Hub currently considers live. Retired brands are left out: a question about what
// the studio is doing now shouldn't be answered with work that stopped a year ago.
async function activeBrands() {
  const raw = (await fbGet("brands")) || {};
  const seen = new Set();
  const brands = [];
  for (const record of Object.values(raw)) {
    if (!record || !record.brand || record.inactive) continue;
    const id = slug(record.brand);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    brands.push({ id, name: record.brand });
  }
  return brands.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_BRANDS);
}

// One brand's line in the wide view: who is on it, what is live, and what has been made for it
// recently. Enough to answer a question about the studio, or to tell Mani which brand to
// recommend looking at in depth.
async function brandSnapshot(brand, options = {}) {
  const [activity, visual, brain] = await Promise.all([
    collectTeamActivity(brand.id, brand.name, options).catch(() => null),
    loadVisualHistory(brand.id, options).catch(() => []),
    loadBrain(brand.id).catch(() => null),
  ]);

  const recentVisual = (visual || []).slice(0, MAX_VISUAL_PER_BRAND).map((round) => ({
    when: String(round.createdAt || "").slice(0, 10),
    prompt: round.prompt,
    by: round.actor,
    picked: round.pickedIndex !== null && round.pickedIndex !== undefined,
    pickedBy: round.pickedBy || null,
  }));

  // Who has touched this brand at all — from the task board and from Visual Studio. These are
  // different groups: a designer generating images may have no task assigned, and somebody
  // carrying three tasks may never open Visual Studio.
  const people = new Set([
    ...((activity && activity.people) || []),
    ...(visual || []).map((r) => r.actor).filter((a) => a && a !== "unknown"),
  ]);

  return {
    id: brand.id,
    name: brand.name,
    people: [...people].sort(),
    openTasks: (activity && activity.activeCount) || 0,
    overdue: ((activity && activity.overdue) || []).length,
    tasks: ((activity && activity.active) || []).slice(0, MAX_TASKS_PER_BRAND).map((t) => ({
      task: t.task, who: t.member || t.assignee || "unassigned", status: t.status, due: t.due_date || null,
    })),
    recentVisual,
    // Whether there is anything distilled to go deep on, so Mani can say "ask me about RRO
    // specifically" rather than implying he already told you everything he knows.
    hasDistilledMemory: Boolean(brain && brain.sections && Object.values(brain.sections).some((s) => s && s.text)),
  };
}

async function collectHubMemory(options = {}) {
  const brands = await activeBrands();
  const snapshots = await Promise.all(brands.map((brand) => brandSnapshot(brand, options)));
  return { brands: snapshots };
}

function hubMemoryToPromptText(hub) {
  const brands = (hub && hub.brands) || [];
  if (!brands.length) return null;

  const lines = [];
  for (const brand of brands) {
    const bits = [`## ${brand.name}`];
    bits.push(brand.people.length ? `Working on it: ${brand.people.join(", ")}.` : "Nobody is currently recorded working on it.");
    if (brand.openTasks) {
      bits.push(`${brand.openTasks} open task${brand.openTasks === 1 ? "" : "s"}${brand.overdue ? `, ${brand.overdue} overdue` : ""}.`);
      bits.push(brand.tasks.map((t) => `- ${t.task} — ${t.who} (${t.status}${t.due ? `, due ${t.due}` : ""})`).join("\n"));
    } else {
      bits.push("No open tasks.");
    }
    if (brand.recentVisual.length) {
      bits.push("Recent work in Visual Studio:");
      bits.push(brand.recentVisual.map((v) => `- ${v.when} "${v.prompt}" — ${v.by}${v.picked ? `, kept${v.pickedBy && v.pickedBy !== v.by ? ` by ${v.pickedBy}` : ""}` : ", nothing kept"}`).join("\n"));
    }
    if (!brand.hasDistilledMemory) bits.push("(Nothing distilled from this brand's Drive folder yet.)");
    lines.push(bits.join("\n"));
  }

  return [
    "# What is happening across Loona right now",
    "Every active brand in Hub: who is working on it, what is open and overdue, and what has recently been made for it in Visual Studio.",
    "This is a roll-up, not the full memory of any one brand. When a question needs depth on a single brand, say which brand to ask about.",
    "",
    lines.join("\n\n"),
  ].join("\n");
}

async function loadHubMemoryText(options) {
  try {
    return hubMemoryToPromptText(await collectHubMemory(options));
  } catch (error) {
    console.error("Could not load Hub-wide memory:", error.message);
    return null;
  }
}

module.exports = {
  collectHubMemory, hubMemoryToPromptText, loadHubMemoryText, activeBrands, brandSnapshot,
};
