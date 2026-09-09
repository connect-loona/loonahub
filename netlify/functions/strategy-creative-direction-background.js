// Same shape as strategy-research-background.js / strategy-strategy-background.js, for the
// Creative Direction stage. Triggered by strategy-stage-approve.js once a human approves the
// Copy stage's checkpoint.
"use strict";
const { runDirectionStage } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId } = body;
  if (!runId) return { statusCode: 400, body: "runId is required" };

  try {
    await runDirectionStage(runId);
  } catch (error) {
    console.error(`strategy-creative-direction-background failed for run ${runId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
