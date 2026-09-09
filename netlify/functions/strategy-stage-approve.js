// POST { runId, stage, decision, actor, notes? } — records a human decision on a stage
// that's sitting in "needs_review", and on approval unlocks + triggers the next stage.
// decision is "approved" or "changes_requested". Every mutation records the acting user
// and timestamp (brief section 20: "All mutations must record the acting user and
// timestamp") into strategy_runs/<runId>/approvals/<stage> and the activity log.
//
// Killing an individual concept (brief section 9's "Kill + add to learnings", replacing
// just that one asset while keeping the rest) is NOT implemented yet — this endpoint only
// approves or flags the whole stage. Re-running a stage after "changes_requested" is also
// a manual next step for now (re-POST to strategy-run-start's sibling trigger), not
// automatic. Both are natural fast-follows once this slice is confirmed working.
"use strict";
const { fbGet, fbUpdate } = require("./lib/strategy/firebase");
const { logActivity } = require("./lib/strategy/pipeline");
const { checkAuthorization } = require("./lib/strategy/auth");

const NEXT_STAGE = { research: "strategy" };
const STAGE_ORDER = ["research", "strategy"];

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { runId, stage, decision, notes } = body;
  const actor = String(body.actor || "Unknown").trim();
  if (!runId || !STAGE_ORDER.includes(stage)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId and a valid stage are required." }) };
  if (decision !== "approved" && decision !== "changes_requested") {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'decision must be "approved" or "changes_requested".' }) };
  }

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    if (!run) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Run not found." }) };
    const stageState = run.stages && run.stages[stage];
    if (!stageState || stageState.status !== "needs_review") {
      return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `${stage} is not currently awaiting review (status: ${stageState ? stageState.status : "unknown"}).` }) };
    }

    const now = new Date().toISOString();
    await fbUpdate(`strategy_runs/${runId}/approvals`, {
      [stage]: { decision, decidedBy: actor, decidedAt: now, notes: notes || null },
    });
    await logActivity(runId, actor, `${stage}.${decision}`, notes || null);

    if (decision === "changes_requested") {
      await fbUpdate(`strategy_runs/${runId}`, { status: `${stage}_changes_requested`, updatedAt: now });
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, status: `${stage}_changes_requested` }) };
    }

    // Approved.
    await fbUpdate(`strategy_runs/${runId}/stages/${stage}`, { status: "approved", updatedAt: now });
    const nextStage = NEXT_STAGE[stage];
    if (!nextStage) {
      // Last stage in this slice (strategy) — nothing further to trigger yet.
      await fbUpdate(`strategy_runs/${runId}`, { status: `${stage}_approved`, updatedAt: now });
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, status: `${stage}_approved` }) };
    }

    await fbUpdate(`strategy_runs/${runId}/stages/${nextStage}`, { status: "queued", updatedAt: now });
    await fbUpdate(`strategy_runs/${runId}`, { status: `${stage}_approved`, updatedAt: now });

    const base = process.env.URL || process.env.DEPLOY_URL || "";
    await fetch(`${base}/.netlify/functions/strategy-${nextStage}-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    }).catch((e) => console.error(`Failed to trigger ${nextStage} background function:`, e));

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, status: `${stage}_approved` }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
