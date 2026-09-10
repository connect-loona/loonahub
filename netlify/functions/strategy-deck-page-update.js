// POST { runId, pageIndex, field, value } — replaces the legacy Hub's direct-Firebase
// update for editing one deck page's Owner/Production status fields (see index.html's
// soUpdateDeckPage and docs/strategy-os-touchpoints.md's "Direct Firebase access" table)
// with a real backend endpoint, per the working-instructions doc's boundary rule.
"use strict";
const { fbUpdate } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

const ALLOWED_FIELDS = ["owner", "productionStatus"];

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
  const pageIndex = Number(body.pageIndex);
  const field = String(body.field || "").trim();
  if (!runId || !Number.isInteger(pageIndex) || pageIndex < 0) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId and a valid pageIndex are required." }) };
  if (!ALLOWED_FIELDS.includes(field)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `field must be one of: ${ALLOWED_FIELDS.join(", ")}` }) };

  try {
    await fbUpdate(`strategy_runs/${runId}/stages/deck-builder/checkpoint/pages/${pageIndex}`, { [field]: body.value });
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
