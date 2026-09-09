// Same shape as strategy-research-background.js, for the Strategy stage. Triggered by
// strategy-stage-approve.js once a human approves the Research stage's checkpoint.
"use strict";
const { runStrategyStage } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId } = body;
  if (!runId) return { statusCode: 400, body: "runId is required" };

  try {
    await runStrategyStage(runId);
  } catch (error) {
    console.error(`strategy-strategy-background failed for run ${runId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
