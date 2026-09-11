// Same shape as strategy-research-background.js / strategy-strategy-background.js, for the
// Deck Builder stage. Triggered by strategy-stage-approve.js once a human approves the
// Creative Direction stage's checkpoint. JSON and PPTX exports are requested separately
// from the finished, validated checkpoint.
"use strict";
const { verifyInternalRequest } = require("./lib/strategy/internal-auth");
const { runDeckStage } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  const auth = verifyInternalRequest(event);
  if (!auth.ok) return { statusCode: 401, body: auth.reason };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId } = body;
  if (!runId) return { statusCode: 400, body: "runId is required" };

  try {
    await runDeckStage(runId);
  } catch (error) {
    console.error(`strategy-deck-builder-background failed for run ${runId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
