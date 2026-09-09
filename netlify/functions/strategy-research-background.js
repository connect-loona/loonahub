// Netlify Background Function (the "-background" filename suffix is what makes Netlify
// treat it as one: caller gets an immediate 202 and this keeps running up to 15 minutes).
// Invoked by strategy-run-start.js with { runId }. All progress/results are written to
// Firebase as they happen — there is no result returned to the original caller, by
// Netlify's own design for background functions (see docs/DEPLOYMENT.md in the supplied
// package), which is exactly why the Hub UI has to watch strategy_runs/<runId> live
// instead of waiting on this call.
"use strict";
const { runResearchStage } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const { runId } = body;
  if (!runId) return { statusCode: 400, body: "runId is required" };

  try {
    await runResearchStage(runId);
  } catch (error) {
    // Already recorded to Firebase (status: failed, detail: message) inside
    // runResearchStage/executeStage — logged here too so it shows in Netlify's function
    // logs for debugging.
    console.error(`strategy-research-background failed for run ${runId}:`, error);
  }
  return { statusCode: 202, body: "" };
};
