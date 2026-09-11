// POST { runId, stage, actor, notes? } — "go back" to an already-approved stage. No model
// call here (nothing regenerates on reopen itself), so this runs synchronously in the
// foreground, same as strategy-concept-accept.js. See pipeline.js's reopenStage() for what
// actually happens: the reopened stage goes back to needs_review with its existing
// checkpoint intact, and every stage after it is wiped back to locked (snapshotted first)
// since their content was built against what the reopened stage used to say.
"use strict";
const { reopenStage } = require("./lib/strategy/pipeline");
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
  const { runId, stage } = body;
  const notes = String(body.notes || "").trim();
  const actor = auth.actor;
  if (!runId || !stage) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "runId and stage are required." }) };

  try {
    const result = await reopenStage(runId, stage, actor, notes);
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, stage: result.stage, resetDownstream: result.resetDownstream }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
