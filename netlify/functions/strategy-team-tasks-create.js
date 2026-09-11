// POST { runId, actor } — replaces the legacy Hub's direct-Firebase writes for "Create
// team tasks" (see index.html's soCreateTeamTasks and docs/strategy-os-touchpoints.md's
// "Direct Firebase access" table: a push per deck page into `tasks`, then a
// `teamTasksCreatedAt` stamp on the run) with a real backend endpoint.
//
// Deliberately NOT calling the same helper Hub's own Task Board add-task flow uses — that
// helper's dedup/auto-task machinery is built for recurring brand-of-day tasks, not a
// one-off fan-out like this (same reasoning as the legacy function's own comment). Every
// page is assigned to the run's owner, since Strategy OS doesn't have its own member
// picker.
"use strict";
const { fbGet, fbPush, fbUpdate } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

// Same stamp format as index.html's fmtStamp() — "dd-mm-yy h:mm am/pm".
function fmtStamp(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  const h = d.getHours();
  const ap = h >= 12 ? "pm" : "am";
  const h12 = ((h + 11) % 12) + 1;
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}-${mm}-${yy} ${h12}:${mi} ${ap}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = await checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const runId = String(body.runId || "").trim();
  const actor = auth.actor;
  if (!runId) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId is required." }) };

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    const deckStage = run && run.stages && run.stages["deck-builder"];
    const pages = deckStage && deckStage.checkpoint && deckStage.checkpoint.pages;
    if (!run || !pages || !pages.length) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "This run has no finished deck to create tasks from." }) };

    const brand = await fbGet(`strategy_brands/${run.brandId}`);
    const brandName = (brand && brand.name) || run.brandId;
    const owner = run.owner || actor || "Unknown";
    const now = new Date();

    await Promise.all(pages.map((p) => fbPush("tasks", {
      member: owner, brand: run.brandId, brands: [run.brandId],
      task: `Produce ${p.format} — ${p.idea} (${brandName}, ${run.month})`,
      is_personal: false, priority: "Medium", status: "Not Started",
      due_date: "", assigned_by: actor, overseers: [],
      created_at: now.toISOString(), assigned_on: fmtStamp(now),
      strategy_run_id: run.runId, strategy_asset_id: p.assetId,
    })));
    await fbUpdate(`strategy_runs/${runId}`, { teamTasksCreatedAt: now.toISOString() });

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, tasksCreated: pages.length }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
