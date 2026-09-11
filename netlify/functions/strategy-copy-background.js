// Same shape as strategy-research-background.js / strategy-strategy-background.js, for the
// Copy stage. Triggered by strategy-stage-approve.js once a human approves the Strategy
// stage's checkpoint.
"use strict";
const { verifyInternalRequest } = require("./lib/strategy/internal-auth");
const { runCopyStage } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  const auth = verifyInternalRequest(event);
  if (!auth.ok) return { statusCode: 401, body: auth.reason };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId } = body;
  if (!runId) return { statusCode: 400, body: "runId is required" };

  try {
    await runCopyStage(runId);
  } catch (error) {
    console.error(`strategy-copy-background failed for run ${runId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
