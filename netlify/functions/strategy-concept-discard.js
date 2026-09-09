// POST { runId, stage, assetId, notes?, actor } — kills an asset's current content and
// immediately generates its replacement (no separate accept step — the old content is
// already gone, there's nothing to review before committing). This is each stage's
// "auto-accept" request type: strategy's "discard", copy's "replace". Same
// foreground-validate / background-generate split as strategy-concept-propose.js, since
// this also makes a real model call.
"use strict";
const { fbGet, fbSet } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

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
  const { runId, assetId } = body;
  const stage = body.stage || "strategy";
  const notes = String(body.notes || "").trim();
  const actor = String(body.actor || "Unknown").trim();
  if (!runId || !assetId) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId and assetId are required." }) };

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    if (!run) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Run not found." }) };
    const targetStage = run.stages && run.stages[stage];
    if (!targetStage || !["needs_review", "changes_requested"].includes(targetStage.status)) {
      return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `${stage} is ${targetStage ? targetStage.status : "unknown"}; assets can only be replaced while it's awaiting review.` }) };
    }
    const existing = targetStage.checkpoint && targetStage.checkpoint.assets.find((asset) => asset.assetId === assetId);
    if (!existing) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: `Asset ${assetId} not found in this run's ${stage}.` }) };
    const existingCandidate = await fbGet(`strategy_runs/${runId}/stages/${stage}/candidates/${assetId}`);
    if (existingCandidate && existingCandidate.status === "running") {
      return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `A replacement for ${assetId} is already being generated.` }) };
    }

    const base = siteBaseUrl(event);
    try {
      await fetch(`${base}/.netlify/functions/strategy-concept-discard-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, stage, assetId, notes, actor }),
      });
    } catch (e) {
      console.error("Failed to trigger strategy-concept-discard-background:", e);
      await fbSet(`strategy_runs/${runId}/stages/${stage}/candidates/${assetId}`, { status: "failed", requestType: stage === "copy" ? "replace" : "discard", notes: notes || null, detail: `Could not start: ${e.message || e}` });
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: `Could not start: ${e.message || e}` }) };
    }

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, status: "running" }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
