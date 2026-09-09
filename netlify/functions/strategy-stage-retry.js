// POST { runId, stage, actor } — manually retries a stage that's sitting in "failed" after
// exhausting its automatic repair attempts (pipeline.js's executeStage: 1 attempt + 2
// repairs, then "failed"). This starts that stage fresh — a brand new 3-attempt cycle, not
// a continuation of the failed one — by re-triggering the same background function the
// approval flow uses (strategy-stage-approve.js), just without requiring a fresh approval
// since the stage was already approved to run once; it simply didn't complete.
//
// Only "failed" stages can be retried this way. A stage that's still running, awaiting
// review, or genuinely locked behind an earlier unapproved stage isn't a valid retry target
// — those have their own flows (wait for it to finish, approve/request changes, or approve
// the earlier stage first).
"use strict";
const { fbGet, fbSet, fbUpdate } = require("./lib/strategy/firebase");
const { logActivity } = require("./lib/strategy/pipeline");
const { checkAuthorization } = require("./lib/strategy/auth");

const STAGE_ORDER = ["research", "strategy", "copy", "creative-direction", "deck-builder"];

// See strategy-run-start.js's siteBaseUrl() — process.env.URL/DEPLOY_URL aren't reliably
// present at Function runtime, so build the base URL from the incoming request's own Host
// header instead.
function siteBaseUrl(event) {
  const host = (event.headers && (event.headers.host || event.headers.Host || event.headers["x-forwarded-host"])) || "";
  if (!host) return process.env.URL || process.env.DEPLOY_URL || "";
  const proto = (event.headers && event.headers["x-forwarded-proto"]) || "https";
  return `${proto}://${host}`;
}

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

  const { runId, stage } = body;
  const actor = String(body.actor || "Unknown").trim();
  if (!runId || !STAGE_ORDER.includes(stage)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId and a valid stage are required." }) };

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    if (!run) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Run not found." }) };
    const stageState = run.stages && run.stages[stage];
    if (!stageState || stageState.status !== "failed") {
      return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `${stage} is not currently failed (status: ${stageState ? stageState.status : "unknown"}), so there's nothing to retry.` }) };
    }

    const now = new Date().toISOString();
    // Clear the failure — a fresh 3-attempt cycle starts as if this were the first try,
    // same as the original run. The old attempts stay under attempts/<stage>/ for history.
    await fbUpdate(`strategy_runs/${runId}/stages/${stage}`, { status: "queued", detail: "Retry requested.", error: null, updatedAt: now });
    await fbUpdate(`strategy_runs/${runId}`, { status: "draft", updatedAt: now });
    await logActivity(runId, actor, `${stage}.retry`, null);

    const base = siteBaseUrl(event);
    try {
      await fetch(`${base}/.netlify/functions/strategy-${stage}-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
    } catch (e) {
      console.error(`Failed to trigger ${stage} retry background function:`, e);
      await fbSet(`strategy_runs/${runId}/stages/${stage}`, { status: "failed", detail: `Could not restart the ${stage} stage: ${e.message || e}` });
      await fbSet(`strategy_runs/${runId}/status`, "failed");
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: `Could not restart the ${stage} stage: ${e.message || e}` }) };
    }

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, status: "queued" }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
