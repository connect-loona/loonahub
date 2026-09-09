// Actually generates AND auto-accepts a discarded concept's replacement — triggered by
// strategy-concept-discard.js. discardConcept() writes its own running/ready(committed)/
// failed status; on failure the original concept is left in place (never silently removed)
// and the candidate sits in "failed" for a person to see and retry.
"use strict";
const { discardConcept } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId, assetId, notes, actor } = body;
  if (!runId || !assetId) return { statusCode: 400, body: "runId and assetId are required" };

  try {
    await discardConcept(runId, assetId, notes, actor);
  } catch (error) {
    console.error(`strategy-concept-discard-background failed for run ${runId}, asset ${assetId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
