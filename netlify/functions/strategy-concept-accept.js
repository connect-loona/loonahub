// POST { runId, stage, assetId, actor, section?, variationIndex? } — commits a "ready"
// candidate (see strategy-concept-propose.js) into the given stage's checkpoint. `section`
// accepts just that section's own ready candidate. `variationIndex` picks which of a
// "variations" request's (up to four) options to commit — required for that request type,
// ignored otherwise (see pipeline.js's acceptAssetCandidate). No model call here, so this
// runs synchronously in the foreground rather than needing a -background counterpart.
"use strict";
const { acceptAssetCandidate } = require("./lib/strategy/pipeline");
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
  const { runId, assetId } = body;
  const stage = body.stage || "strategy";
  const actor = String(body.actor || "Unknown").trim();
  const section = String(body.section || "").trim() || null;
  // Only meaningful for a "variations" candidate — acceptAssetCandidate ignores it entirely
  // for every other request type, which still resolves its one obvious candidate as before.
  const variationIndex = Number.isInteger(body.variationIndex) ? body.variationIndex : undefined;
  if (!runId || !assetId) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId and assetId are required." }) };

  try {
    await acceptAssetCandidate(runId, stage, assetId, actor, section, variationIndex);
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
