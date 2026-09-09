// Actually generates the candidate concept — triggered by strategy-concept-propose.js.
// proposeConceptCandidate() writes its own running/ready/failed status directly to
// strategy_runs/<runId>/stages/strategy/candidates/<assetId>, so there's nothing more to
// do here on failure than log it (matching every other -background function's shape).
"use strict";
const { proposeConceptCandidate } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId, assetId, action, notes } = body;
  if (!runId || !assetId || !action) return { statusCode: 400, body: "runId, assetId and action are required" };

  try {
    await proposeConceptCandidate(runId, assetId, action, notes);
  } catch (error) {
    console.error(`strategy-concept-propose-background failed for run ${runId}, asset ${assetId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
