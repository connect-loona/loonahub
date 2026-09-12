// POST { runId, stage, assetId, action, notes?, focus?, section? } — kicks off a candidate
// replacement for ONE asset in an awaiting-review stage ("refine" with notes on any
// supported stage, "similar"/"suggest another" for a single alternative in the same spirit,
// or "variations" for up to four fresh takes at once — two from each configured model
// provider, see pipeline.js's proposeAssetVariations — strategy and copy). `focus` is an
// optional free-text pointer at the specific part of the
// asset the reviewer means (e.g. "Caption B", "Script") — passed straight through to the
// refine prompt as a hint, it doesn't change what shape the model has to return.
//
// `section` ("captions" | "script", copy only) is a stronger version of the same idea: it
// scopes the candidate to a fully INDEPENDENT thread — its own Firebase key, its own lock,
// hard-enforced so only that section's fields can actually change (see pipeline.js's
// ASSET_STAGE_CONFIG.copy.sections) — so refining captions and refining the script can run
// at the same time without either clobbering the other. See CopyReview.tsx.
//
// Fires the actual model call as a background function (real model calls can run long,
// same reason every other stage does this) and returns immediately; the candidate's
// progress (running/ready/failed) lives at strategy_runs/<runId>/stages/<stage>/candidates/
// <assetId>, or <assetId>::<section> when sectioned — watched live the same way everything
// else in this run is.
"use strict";
const { fbGet, fbSet } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

// Which review-first request types each stage supports (its "kill it, no review needed"
// type — strategy's "discard", copy's "replace" — goes through strategy-concept-discard.js
// instead, since that one auto-accepts).
const VALID_ACTIONS_BY_STAGE = {
  strategy: ["refine", "similar", "variations"],
  copy: ["refine", "similar", "variations"],
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
  // Optional: which specific part of the asset the reviewer flagged — e.g. "Caption B" or
  // "Script" on a copy asset (see CopyReview.tsx's per-caption/script "Refine this" links).
  // Purely a prompt hint threaded through to proposeAssetCandidate/the refine prompts; it
  // doesn't change validation or the schema the model must still return a full asset
  // against.
  const focus = String(body.focus || "").trim() || null;
  const section = String(body.section || "").trim() || null;
  const validActions = VALID_ACTIONS_BY_STAGE[stage];
  if (!runId || !assetId || !validActions || !validActions.includes(action)) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `runId, assetId and a valid action (${validActions ? validActions.map((a) => `"${a}"`).join(" or ") : "unsupported stage"}) are required.` }) };
  }
  if (action === "refine" && !notes) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Refining needs notes on what should change." }) };
  }
  const candidateKey = section ? `${assetId}::${section}` : assetId;

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    if (!run) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Run not found." }) };
    const targetStage = run.stages && run.stages[stage];
    if (!targetStage || !["needs_review", "changes_requested"].includes(targetStage.status)) {
      return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `${stage} is ${targetStage ? targetStage.status : "unknown"}; assets can only be refined while it's awaiting review.` }) };
    }
    const existing = targetStage.checkpoint && targetStage.checkpoint.assets.find((asset) => asset.assetId === assetId);
    if (!existing) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: `Asset ${assetId} not found in this run's ${stage}.` }) };
    const existingCandidate = await fbGet(`strategy_runs/${runId}/stages/${stage}/candidates/${candidateKey}`);
    if (existingCandidate && existingCandidate.status === "running") {
      return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `A replacement for ${assetId}${section ? ` (${section})` : ""} is already being generated.` }) };
    }

    const base = siteBaseUrl(event);
    try {
      await fetch(`${base}/.netlify/functions/strategy-concept-propose-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, stage, assetId, action, notes, focus, section }),
      });
    } catch (e) {
      console.error("Failed to trigger strategy-concept-propose-background:", e);
      await fbSet(`strategy_runs/${runId}/stages/${stage}/candidates/${candidateKey}`, { status: "failed", requestType: action, notes: notes || null, detail: `Could not start: ${e.message || e}` });
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: `Could not start: ${e.message || e}` }) };
    }

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, status: "running" }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
