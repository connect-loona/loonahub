// Reconciles the legacy Hub task collection into Mani's append-only ledger. Most task edits
// still happen directly in the browser, so there is no server endpoint where a recorder can
// be attached. This scheduled diff closes that gap until task writes are moved server-side.
"use strict";

const crypto = require("crypto");
const { fbGet, fbSet } = require("./firebase");
const { recordManiEvent } = require("./mani-events");

function brandId(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || null; }
function fingerprint(task) {
  const stable = {
    task: task && task.task, brand: task && task.brand, member: task && (task.member || task.assignee),
    status: task && task.status, due: task && (task.due_date || task.dueDate), priority: task && task.priority,
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function reconcileTasks() {
  const tasks = (await fbGet("tasks")) || {};
  const previous = (await fbGet("mani_snapshots/tasks")) || null;
  const next = {};
  for (const [id, task] of Object.entries(tasks)) next[id] = { fingerprint: fingerprint(task), task };

  // First run establishes the baseline without turning every historical task into a fresh
  // notification. The source records remain readable; new changes become ledger events.
  if (!previous) {
    await fbSet("mani_snapshots/tasks", next);
    await recordManiEvent({ type: "tasks_baselined", source: "hub_tasks", entityType: "task_collection", action: "baseline", summary: `Mani began continuous task tracking with ${Object.keys(next).length} existing task(s).` });
    return { baseline: true, changes: 0 };
  }

  let changes = 0;
  for (const [id, current] of Object.entries(next)) {
    const before = previous[id];
    if (before && before.fingerprint === current.fingerprint) continue;
    const task = current.task || {};
    const created = !before;
    await recordManiEvent({
      type: created ? "task_created" : "task_updated", source: "hub_tasks", brandId: brandId(task.brand),
      actor: task.updated_by || task.created_by || "Hub team", entityType: "task", entityId: id,
      action: created ? "created" : "updated",
      summary: `${created ? "Created" : "Updated"} task “${task.task || id}”${task.member || task.assignee ? ` for ${task.member || task.assignee}` : ""}${task.status ? ` · ${task.status}` : ""}${task.due_date || task.dueDate ? ` · due ${task.due_date || task.dueDate}` : ""}.`,
      data: { before: before ? before.task : null, after: task },
    });
    changes += 1;
  }
  for (const [id, before] of Object.entries(previous)) {
    if (next[id]) continue;
    const task = before.task || {};
    await recordManiEvent({ type: "task_removed", source: "hub_tasks", brandId: brandId(task.brand), actor: "Hub team", entityType: "task", entityId: id, action: "removed", summary: `Removed task “${task.task || id}”.`, data: { before: task } });
    changes += 1;
  }
  await fbSet("mani_snapshots/tasks", next);
  return { baseline: false, changes };
}

module.exports = { reconcileTasks, fingerprint };
