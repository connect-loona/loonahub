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

// The pipeline's own version of saveFeedbackEvent — a critic objecting, one model beating
// another, or a stage dying, recorded whether or not a human ever typed a note about it.
// saveFeedbackEvent only fires on a human's typed note, which meant every silent
// "Approve" click, every competitive round, and every failed run taught the system
// nothing at all — the exact waste this exists to close. Same collection and shape as
// saveFeedbackEvent (loadLearnings/store.js reads both together), actor is always
// "system" so loadLearnings can tell a real human decision from the pipeline noticing
// something on its own.
async function saveSystemLearningEvent(run, stage, decision, detail) {
  if (!detail || !String(detail).trim()) return null;
  return fbPush(`strategy_learning_events/${run.brandId}`, {
    runId: run.runId,
    month: run.month,
    stage,
    decision,
    notes: String(detail).trim(),
    actor: "system",
    createdAt: now(),
  });
}

module.exports = { saveStageVersion, saveStageMetrics, saveFeedbackEvent, saveSystemLearningEvent };

