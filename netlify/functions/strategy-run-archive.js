// POST { runId, action: "archive" | "restore" | "purge", actor, reason? } — replaces the
// legacy Hub's direct-Firebase-write pattern for this (see index.html's soArchiveRun/
// soRestoreRun/soPurgeRun and docs/strategy-os-touchpoints.md's "Direct Firebase access"
// table) with a real backend endpoint, for the new Strategy OS app to call instead of
// writing to Firebase from the browser directly — per the working-instructions doc's
// boundary rule.
//
// "archive"/"restore" only ever update the three archive fields — they never touch
// run.status, matching the legacy behavior exactly (see strategy-run-start.js's
// isActiveRun(), which already treats archivedAt as the signal, independent of status).
// "purge" removes the run and all run-scoped operational history — the UI's own typed-confirmation (matching the
// legacy Hub's soPurgeRun / the existing deleteMemberPermanently pattern) is what makes
// this hard to reach by accident; this endpoint trusts that the caller already did that,
// the same way strategy-stage-reopen.js trusts the caller's own confirm() dialog.
"use strict";
const { fbSet, fbUpdate } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

const VALID_ACTIONS = ["archive", "restore", "purge"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = await checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const runId = String(body.runId || "").trim();
  const action = String(body.action || "").trim();
  const actor = auth.actor;
  if (!runId) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId is required." }) };
  if (!VALID_ACTIONS.includes(action)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `action must be one of: ${VALID_ACTIONS.join(", ")}` }) };

  try {
    if (action === "archive") {
      const reason = body.reason ? String(body.reason).trim() : null;
      // One atomic PATCH, not three sequential writes — a live listener on strategy_runs
      // (the run list's own useRuns() hook, among others) would otherwise have a real
      // chance of rendering a moment where archivedAt is set but archivedBy/archiveReason
      // aren't yet.
      await fbUpdate(`strategy_runs/${runId}`, { archivedAt: new Date().toISOString(), archivedBy: actor, archiveReason: reason || null });
    } else if (action === "restore") {
      await fbUpdate(`strategy_runs/${runId}`, { archivedAt: null, archivedBy: null, archiveReason: null });
    } else {
      await Promise.all([
        fbSet(`strategy_runs/${runId}`, null),
        fbSet(`strategy_activity/${runId}`, null),
        fbSet(`strategy_stage_versions/${runId}`, null),
        fbSet(`strategy_feedback/${runId}`, null),
      ]);
      // strategy_learning_events is brand memory, not disposable run history. It stays
      // intentionally so a rejected concept cannot quietly return after a purge.
    }
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, action }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
