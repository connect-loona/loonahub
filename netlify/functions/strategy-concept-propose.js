// POST { runId, stage, assetId, action, notes? } — kicks off a candidate replacement for
// ONE asset in an awaiting-review stage ("refine" with notes on any supported stage, or
// "similar" for an alternative in the same spirit — strategy only). Fires the actual model
// call as a background function (real model calls can run long, same reason every other
// stage does this) and returns immediately; the candidate's progress (running/ready/failed)
// lives at strategy_runs/<runId>/stages/<stage>/candidates/<assetId>, watched live the same
// way everything else in this run is.
"use strict";
const { fbGet, fbSet } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

// Which review-first request types each stage supports (its "kill it, no review needed"
// type — strategy's "discard", copy's "replace" — goes through strategy-concept-discard.js
// instead, since that one auto-accepts).
const VALID_ACTIONS_BY_STAGE = {
  strategy: ["refine", "similar"],
  copy: ["refine"],
};

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
  const { runId, assetId, action } = body;
  const stage = body.stage || "strategy"; // default keeps any stale cached frontend working
  const notes = String(body.notes || "").trim();
  const validActions = VALID_ACTIONS_BY_STAGE[stage];
  if (!runId || !assetId || !validActions || !validActions.includes(action)) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `runId, assetId and a valid action (${validActions ? validActions.map((a) => `"${a}"`).join(" or ") : "unsupported stage"}) are required.` }) };
  }
  if (action === "refine" && !notes) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Refining needs notes on what should change." }) };
  }

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    if (!run) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Run not found." }) };
    const targetStage = run.stages && run.stages[stage];
    if (!targetStage || !["needs_review", "changes_requested"].includes(targetStage.status)) {
      return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `${stage} is ${targetStage ? targetStage.status : "unknown"}; assets can only be refined while it's awaiting review.` }) };
    }
    const existing = targetStage.checkpoint && targetStage.checkpoint.assets.find((asset) => asset.assetId === assetId);
    if (!existing) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: `Asset ${assetId} not found in this run's ${stage}.` }) };
    const existingCandidate = await fbGet(`strategy_runs/${runId}/stages/${stage}/candidates/${assetId}`);
    if (existingCandidate && existingCandidate.status === "running") {
      return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `A replacement for ${assetId} is already being generated.` }) };
    }

    const base = siteBaseUrl(event);
    try {
      await fetch(`${base}/.netlify/functions/strategy-concept-propose-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, stage, assetId, action, notes }),
      });
    } catch (e) {
      console.error("Failed to trigger strategy-concept-propose-background:", e);
      await fbSet(`strategy_runs/${runId}/stages/${stage}/candidates/${assetId}`, { status: "failed", requestType: action, notes: notes || null, detail: `Could not start: ${e.message || e}` });
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: `Could not start: ${e.message || e}` }) };
    }

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, status: "running" }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
