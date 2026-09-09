// Same shape as strategy-research-background.js / strategy-strategy-background.js, for the
// Deck Builder stage. Triggered by strategy-stage-approve.js once a human approves the
// Creative Direction stage's checkpoint. This is also the stage that attempts a Canva
// publish once its own JSON output validates — see pipeline.js's runDeckStage().
"use strict";
const { runDeckStage } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
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
