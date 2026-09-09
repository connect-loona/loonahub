"use strict";
const { fbPush, fbUpdate } = require("./firebase");

function now() { return new Date().toISOString(); }

async function saveStageVersion(runId, stage, checkpoint, reason, actor) {
  return fbPush(`strategy_stage_versions/${runId}/${stage}`, {
    checkpoint,
    reason,
    actor: actor || "system",
    createdAt: now(),
  });
}

async function saveStageMetrics(runId, stage, metrics) {
  return fbUpdate(`strategy_runs/${runId}/metrics/${stage}`, Object.assign({}, metrics, { updatedAt: now() }));
}

async function saveFeedbackEvent(run, stage, decision, notes, actor) {
  if (!notes || !String(notes).trim()) return null;
  return fbPush(`strategy_learning_events/${run.brandId}`, {
    runId: run.runId,
    month: run.month,
    stage,
    decision,
    notes: String(notes).trim(),
    actor: actor || "Unknown",
    createdAt: now(),
  });
}

module.exports = { saveStageVersion, saveStageMetrics, saveFeedbackEvent };

