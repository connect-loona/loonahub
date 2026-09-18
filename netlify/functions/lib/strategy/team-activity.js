// Loona Brain's second input: what the team is actually doing for this brand right now.
//
// Hub's task board already knows who is working on what, for which brand, and whether it's
// done. Strategy OS has never read it, so the agents plan every month as though nobody at
// Loona has touched the brand since the last run — and can happily propose work that someone
// is already halfway through, or ignore a deadline the team is visibly up against.
//
// Deliberately NOT distilled by a model, unlike the Drive material in brand-brain.js. Two
// reasons. It's short and already structured, so a model would add cost and latency to
// reformat a list it can read perfectly well itself. And it's live: a distillation is cached
// against a fingerprint, which is exactly the wrong behaviour for state that changes every
// time somebody ticks a task off. This is computed fresh each time it's asked for.
"use strict";
const { fbGet } = require("./firebase");

// Statuses that mean the task is off the board. Everything else — "Not Started", "In
// Progress", "Changes Required", "Pending Approval" — is live work someone is carrying.
const CLOSED_STATUSES = new Set(["completed", "deferred"]);
const MAX_ACTIVE = 25;
const MAX_RECENTLY_DONE = 10;

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Hub's tasks name their brand as free text ("RRO Foods"), while Strategy OS keys everything
// by id ("rro"). Matching on a shared slug of both the id and the configured name is what
// bridges them — the same rule findBrandFolder() uses for Drive folders, so a brand that
// resolves one way resolves the other.
function taskMatchesBrand(task, candidates) {
  const named = [task.brand, ...(Array.isArray(task.brands) ? task.brands : [])];
  return named.some((name) => {
    const s = slug(name);
    return s && candidates.has(s);
  });
}

function isClosed(task) {
  return CLOSED_STATUSES.has(String(task.status || "").toLowerCase());
}

function describe(task) {
  const who = task.member || task.assignee || "unassigned";
  const status = task.status || "Not Started";
  const due = task.due_date ? `, due ${task.due_date}` : "";
  const priority = task.priority && task.priority !== "Medium" ? `, ${String(task.priority).toLowerCase()} priority` : "";
  return `- ${task.task || "(untitled task)"} — ${who} (${status}${due}${priority})`;
}

// Everything the board knows about this brand, as a structure the caller can render or count.
// Separate from the text rendering below so the shape can be asserted directly in tests and
// reused by the app later without going through a string.
async function collectTeamActivity(brandId, brandName, deps = {}) {
  const get = deps.fbGet || fbGet;
  const raw = (await get("tasks")) || {};
  const candidates = new Set([slug(brandId), slug(brandName)].filter(Boolean));
  if (!candidates.size) return { active: [], recentlyDone: [], people: [], overdue: [] };

  const mine = Object.values(raw).filter((task) => task && taskMatchesBrand(task, candidates));
  const byNewest = (a, b) => String(b.created_at || b.assigned_on || "").localeCompare(String(a.created_at || a.assigned_on || ""));

  const active = mine.filter((task) => !isClosed(task)).sort(byNewest);
  const recentlyDone = mine.filter(isClosed).sort(byNewest).slice(0, MAX_RECENTLY_DONE);

  // "Overdue" is computed here rather than trusted from the record, because nothing writes an
  // overdue flag onto a task — it's simply a due date that has passed while the task is open.
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const overdue = active.filter((task) => task.due_date && String(task.due_date) < today);

  const people = [...new Set(active.map((task) => task.member || task.assignee).filter(Boolean))].sort();

  return { active: active.slice(0, MAX_ACTIVE), recentlyDone, people, overdue, activeCount: active.length };
}

// The block the stage prompts see. Returns null when the board has nothing for this brand, so
// a brand nobody has tasks for simply doesn't get the section rather than getting an empty one.
function teamActivityToPromptText(activity) {
  if (!activity) return null;
  const { active, recentlyDone, people, overdue } = activity;
  if (!active.length && !recentlyDone.length) return null;

  const parts = ["# What the Loona team is currently doing for this brand",
    "Live from Hub's task board. Use it to avoid proposing work that is already underway, and to respect what the team is already committed to this month. It is not a brief, and nothing here is content to write about."];

  if (people.length) parts.push(`\nWorking on this brand right now: ${people.join(", ")}.`);
  if (active.length) parts.push(`\n## Open tasks (${activity.activeCount || active.length})\n${active.map(describe).join("\n")}`);
  if (overdue.length) parts.push(`\n## Already overdue\n${overdue.map(describe).join("\n")}`);
  if (recentlyDone.length) {
    parts.push(`\n## Recently finished\n${recentlyDone.map((task) => `- ${task.task || "(untitled task)"} — ${task.member || task.assignee || "unassigned"}`).join("\n")}`);
  }
  return parts.join("\n");
}

async function loadTeamActivityText(brandId, brandName, deps) {
  return teamActivityToPromptText(await collectTeamActivity(brandId, brandName, deps));
}

const MAX_ACTIVE_HUBWIDE = 60;

// The Hub-wide counterpart to collectTeamActivity — every task on the board, not just one
// brand's. For Global BB (browser and WhatsApp): "what's open", "who owns what", "what's
// overdue" as genuine standing questions about the whole team, not just a recent-activity
// glimpse. Nothing here comes near payroll — Hub's task board and Petpooja's payroll system
// are entirely separate data sources, and a task record never carries pay information to
// begin with.
async function collectAllTeamActivity(deps = {}) {
  const get = deps.fbGet || fbGet;
  const raw = (await get("tasks")) || {};
  const all = Object.values(raw).filter(Boolean);
  const byNewest = (a, b) => String(b.created_at || b.assigned_on || "").localeCompare(String(a.created_at || a.assigned_on || ""));

  const active = all.filter((task) => !isClosed(task)).sort(byNewest);
  const recentlyDone = all.filter(isClosed).sort(byNewest).slice(0, MAX_RECENTLY_DONE);
  // Same reasoning as collectTeamActivity: nothing writes an overdue flag onto a task, so this
  // is computed here from whatever due date it carries plus today's date.
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const overdue = active.filter((task) => task.due_date && String(task.due_date) < today);
  const people = [...new Set(active.map((task) => task.member || task.assignee).filter(Boolean))].sort();

  return { active: active.slice(0, MAX_ACTIVE_HUBWIDE), recentlyDone, people, overdue, activeCount: active.length };
}

// Unlike describe() above, the brand isn't implicit here — there's no single brand this list
// is already scoped to, so each line has to name it.
function describeHubWide(task) {
  const who = task.member || task.assignee || "unassigned";
  const status = task.status || "Not Started";
  const brand = task.brand || "no brand";
  const due = task.due_date ? `, due ${task.due_date}` : "";
  const priority = task.priority && task.priority !== "Medium" ? `, ${String(task.priority).toLowerCase()} priority` : "";
  return `- ${task.task || "(untitled task)"} — ${brand} · ${who} (${status}${due}${priority})`;
}

function hubTaskBoardToPromptText(activity) {
  if (!activity) return null;
  const { active, recentlyDone, overdue } = activity;
  if (!active.length && !recentlyDone.length) return null;

  const parts = ["# Hub task board (all brands)",
    "Live from Hub's task board — the current state of every open and recently finished task across every brand. This is the same board the team edits directly; it is not a brief, and nothing here is content to write about."];

  if (active.length) parts.push(`\n## Open tasks (${activity.activeCount || active.length})\n${active.map(describeHubWide).join("\n")}`);
  if (overdue.length) parts.push(`\n## Already overdue\n${overdue.map(describeHubWide).join("\n")}`);
  if (recentlyDone.length) {
    parts.push(`\n## Recently finished\n${recentlyDone.map((task) => `- ${task.task || "(untitled task)"} — ${task.brand || "no brand"} · ${task.member || task.assignee || "unassigned"}`).join("\n")}`);
  }
  return parts.join("\n");
}

async function loadHubTaskBoardText(deps) {
  return hubTaskBoardToPromptText(await collectAllTeamActivity(deps));
}

module.exports = {
  collectTeamActivity, teamActivityToPromptText, loadTeamActivityText,
  collectAllTeamActivity, hubTaskBoardToPromptText, loadHubTaskBoardText,
  taskMatchesBrand, slug, CLOSED_STATUSES,
};
