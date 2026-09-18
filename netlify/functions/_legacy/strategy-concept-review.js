"use strict";

// Records the team's decision separately from the strategy lock. A discard is a real
// decision (so the reviewer can move on) but must not be carried into copy production.
const { fbGet, fbSet } = require("../lib/strategy/firebase");
const { checkAuthorization } = require("../lib/strategy/auth");

const cors = () => ({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized" }) };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const runId = String(body.runId || "").trim();
  const assetId = String(body.assetId || "").trim();
  const actor = String(body.actor || "Unknown").trim();
  const decision = body.decision;
  const formats = Array.isArray(body.formats) ? body.formats.map((value) => String(value).toLowerCase()).filter((value) => ["reel", "carousel", "static", "story"].includes(value)).slice(0, 4) : [];
  if (!runId || !assetId || !["approved", "discarded"].includes(decision)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId, assetId and a valid decision are required." }) };
  if (decision === "approved" && !formats.length) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Choose at least one execution before approving." }) };
  try {
    const asset = await fbGet(`strategy_runs/${runId}/stages/strategy/checkpoint/assets`);
    if (!Array.isArray(asset) || !asset.some((item) => item && item.assetId === assetId)) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Concept not found." }) };
    await fbSet(`strategy_runs/${runId}/stages/strategy/reviews/${assetId}`, { decision, formats: decision === "approved" ? formats : [], decidedBy: actor, decidedAt: new Date().toISOString() });
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
  } catch (error) { return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) }; }
};
