// Actually generates AND auto-accepts a replacement — triggered by
// strategy-concept-discard.js. replaceAsset() writes its own running/ready(committed)/
// failed status; on failure the original asset is left in place (never silently removed)
// and the candidate sits in "failed" for a person to see and retry.
"use strict";
const { verifyInternalRequest } = require("./lib/strategy/internal-auth");
const { replaceAsset } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  const auth = verifyInternalRequest(event);
  if (!auth.ok) return { statusCode: 401, body: auth.reason };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId, assetId, notes, actor } = body;
  const stage = body.stage || "strategy";
  if (!runId || !assetId) return { statusCode: 400, body: "runId and assetId are required" };

  try {
    await replaceAsset(runId, stage, assetId, notes, actor);
  } catch (error) {
    console.error(`strategy-concept-discard-background failed for run ${runId}, stage ${stage}, asset ${assetId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
