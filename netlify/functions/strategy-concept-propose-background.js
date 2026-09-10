// Actually generates the candidate — triggered by strategy-concept-propose.js.
// proposeAssetCandidate() writes its own running/ready/failed status directly to
// strategy_runs/<runId>/stages/<stage>/candidates/<assetId>, so there's nothing more to do
// here on failure than log it (matching every other -background function's shape).
"use strict";
const { proposeAssetCandidate } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId, assetId, action, notes, focus } = body;
  const stage = body.stage || "strategy";
  if (!runId || !assetId || !action) return { statusCode: 400, body: "runId, assetId and action are required" };

  try {
    await proposeAssetCandidate(runId, stage, assetId, action, notes, focus);
  } catch (error) {
    console.error(`strategy-concept-propose-background failed for run ${runId}, stage ${stage}, asset ${assetId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
