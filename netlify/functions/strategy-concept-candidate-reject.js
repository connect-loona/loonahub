// POST { runId, stage, assetId } — replaces the legacy Hub's direct-Firebase remove for
// "Discard suggestion" on a ready refine/similar candidate (see index.html's
// soRejectConceptCandidate and docs/strategy-os-touchpoints.md's "Direct Firebase access"
// table) with a real backend endpoint, per the working-instructions doc's boundary rule.
//
// Nothing's been committed to the stage's checkpoint yet at this point (see
// strategy-concept-accept.js for the endpoint that does that) — this just clears the
// pending candidate so the concept card goes back to showing its current, unchanged
// content.
"use strict";
const { fbSet } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = await checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const runId = String(body.runId || "").trim();
  const stage = String(body.stage || "").trim();
  const assetId = String(body.assetId || "").trim();
  if (!runId || !stage || !assetId) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId, stage, and assetId are required." }) };

  try {
    await fbSet(`strategy_runs/${runId}/stages/${stage}/candidates/${assetId}`, null);
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
