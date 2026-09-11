// POST { runId, stage, assetId, actor, locked } — replaces the legacy Hub's direct-Firebase
// read/write for the per-asset lock toggle (see index.html's soToggleAssetLock and
// docs/strategy-os-touchpoints.md's "Direct Firebase access" table) with a real backend
// endpoint, per the working-instructions doc's boundary rule that the new app never writes
// Firebase directly.
//
// A lock is purely a human checkpoint ("I've looked at this one, it's good") with no effect
// on the stage's own Approve/Send back flow — see strategy-app.js's own comment on
// soToggleAssetLock for the full picture. `locked: true` sets it, `locked: false` clears it.
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
  const actor = auth.actor;
  const locked = !!body.locked;
  if (!runId || !stage || !assetId) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId, stage, and assetId are required." }) };

  try {
    await fbSet(`strategy_runs/${runId}/stages/${stage}/locks/${assetId}`, locked ? { lockedAt: new Date().toISOString(), lockedBy: actor } : null);
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, locked }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
