// POST { runId, stage, assetId, actor, locked, section? } — replaces the legacy Hub's
// direct-Firebase read/write for the per-asset lock toggle (see index.html's
// soToggleAssetLock and docs/strategy-os-touchpoints.md's "Direct Firebase access" table)
// with a real backend endpoint, per the working-instructions doc's boundary rule that the
// new app never writes Firebase directly.
//
// `section` ("captions" | "script", copy only) locks just that section independently — see
// CopyReview.tsx and strategy-stage-approve.js's own comment on what "locked" means per
// stage. `locked: true` sets it, `locked: false` clears it.
//
// Locking now has a real, load-bearing effect: strategy-stage-approve.js only carries
// LOCKED assets forward to the next stage whenever anything in the stage is locked (see its
// own header comment) — this is no longer just a soft human checkpoint with zero downstream
// effect.
"use strict";
const { fbSet } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

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
  const runId = String(body.runId || "").trim();
  const stage = String(body.stage || "").trim();
  const assetId = String(body.assetId || "").trim();
  const actor = String(body.actor || "Unknown").trim();
  const locked = !!body.locked;
  const section = String(body.section || "").trim() || null;
  if (!runId || !stage || !assetId) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId, stage, and assetId are required." }) };

  try {
    const lockKey = section ? `${assetId}::${section}` : assetId;
    await fbSet(`strategy_runs/${runId}/stages/${stage}/locks/${lockKey}`, locked ? { lockedAt: new Date().toISOString(), lockedBy: actor } : null);
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, locked }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
