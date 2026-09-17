// Bridges legacy browser-written operational collections into Mani's event ledger.
// Raw transcripts, guest emails and HR/attendance data are deliberately excluded.
"use strict";

const crypto = require("crypto");
const { fbGet, fbSet } = require("./firebase");
const { recordManiEvent } = require("./mani-events");

function slug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || null; }
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

const SOURCES = [
  {
    name: "calendar_events", path: "calendarEvents", brand: (v) => slug(v.brand), actor: (v) => v.organizer || "Hub team",
    safe: (v) => ({ title: v.title || "Untitled event", brand: v.brand || "", start: v.start || "", end: v.end || "", eventKind: v.eventKind || "meeting", organizer: v.organizer || "", location: v.location || "" }),
    summary: (v, action) => `${action === "created" ? "Scheduled" : "Updated"} ${v.eventKind || "meeting"} “${v.title || "Untitled event"}”${v.start ? ` for ${v.start}` : ""}.`,
  },
  {
    name: "meeting_notes", path: "meetingNotes", brand: (v) => slug(v.brand), actor: (v) => v.recordedBy || v.createdBy || "Hub team",
    safe: (v) => ({ title: v.title || "Untitled meeting", brand: v.brand || "", summary: v.summary || "", decisions: Array.isArray(v.decisions) ? v.decisions.slice(0, 8) : [], actionItems: Array.isArray(v.actionItems) ? v.actionItems.slice(0, 20).map((item) => ({ task: item.task || "", assignee: item.assignee || "", dueDate: item.dueDate || "" })) : [], createdAt: v.createdAt || v.timestamp || "" }),
    summary: (v, action) => `${action === "created" ? "Saved" : "Updated"} meeting notes “${v.title || "Untitled meeting"}”${v.summary ? `: ${String(v.summary).slice(0, 600)}` : "."}`,
  },
  {
    name: "hub_brands", path: "brands", brand: (v) => slug(v.brand), actor: () => "Hub team",
    safe: (v) => ({ brand: v.brand || "", inactive: Boolean(v.inactive) }),
    summary: (v, action) => `${action === "created" ? "Added" : "Updated"} brand “${v.brand || "Unnamed brand"}”${v.inactive ? " (inactive)" : ""}.`,
  },
];

async function reconcileSource(source) {
  const currentRaw = (await fbGet(source.path)) || {};
  const snapshotPath = `mani_snapshots/${source.name}`;
  const previous = (await fbGet(snapshotPath)) || null;
  const next = {};
  for (const [id, raw] of Object.entries(currentRaw)) {
    if (!raw || typeof raw !== "object") continue;
    const safe = source.safe(raw);
    next[id] = { fingerprint: fingerprint(safe), value: safe };
  }
  if (!previous) {
    await fbSet(snapshotPath, next);
    await recordManiEvent({ type: `${source.name}_baselined`, source: source.name, entityType: "collection", action: "baseline", summary: `Mani began tracking ${Object.keys(next).length} existing ${source.name.replace(/_/g, " ")} record(s).` });
    return { source: source.name, baseline: true, changes: 0 };
  }
  let changes = 0;
  for (const [id, item] of Object.entries(next)) {
    const before = previous[id];
    if (before && before.fingerprint === item.fingerprint) continue;
    const action = before ? "updated" : "created";
    await recordManiEvent({ type: `${source.name}_${action}`, source: source.name, brandId: source.brand(item.value), actor: source.actor(item.value), entityType: source.name, entityId: id, action, summary: source.summary(item.value, action), data: { before: before ? before.value : null, after: item.value } });
    changes += 1;
  }
  for (const [id, before] of Object.entries(previous)) {
    if (next[id]) continue;
    await recordManiEvent({ type: `${source.name}_removed`, source: source.name, brandId: source.brand(before.value || {}), actor: "Hub team", entityType: source.name, entityId: id, action: "removed", summary: `Removed ${source.name.replace(/_/g, " ")} record “${id}”.`, data: { before: before.value } });
    changes += 1;
  }
  await fbSet(snapshotPath, next);
  return { source: source.name, baseline: false, changes };
}

async function reconcileOperationalActivity() {
  const results = [];
  for (const source of SOURCES) results.push(await reconcileSource(source));
  return { changes: results.reduce((sum, result) => sum + result.changes, 0), results };
}

module.exports = { reconcileOperationalActivity, reconcileSource, SOURCES, fingerprint, slug };
