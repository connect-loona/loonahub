// POST { runId, role, text, actor } — persists the visible Strategy OS conversation.
// The generated checkpoints remain the source of truth for strategy data; this transcript
// is the human-friendly history that makes a run reopen like a ChatGPT project.
"use strict";
const { fbGet, fbPush } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const runId = String(body.runId || "").trim();
  const role = body.role === "user" ? "user" : "assistant";
  const text = String(body.text || "").trim();
  const actor = String(body.actor || "Unknown").trim();
  if (!runId || !text || text.length > 12000) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId and a message under 12,000 characters are required." }) };
  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    if (!run) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Run not found." }) };
    const id = await fbPush(`strategy_runs/${runId}/chatMessages`, { role, text, actor, createdAt: new Date().toISOString() });
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, id }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
