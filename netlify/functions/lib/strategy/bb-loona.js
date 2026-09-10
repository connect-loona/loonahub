"use strict";
const {
  LOONA_SOUL,
  BB_LOONA_SOUL,
  RESEARCH_SOUL,
  STRATEGY_SOUL,
  COPY_SOUL,
  CREATIVE_DIRECTION_SOUL,
  DECK_BUILDER_SOUL,
  CONCEPT_REFINEMENT_SOUL,
  COPY_REFINEMENT_SOUL,
} = require("./souls-data");
const { STAGE_ORDER, AGENT_REGISTRY, agentForPrompt, renderAgentAnatomy } = require("./agents/agent-registry");

const SOUL_BY_KEY = {
  RESEARCH_SOUL,
  STRATEGY_SOUL,
  COPY_SOUL,
  CREATIVE_DIRECTION_SOUL,
  DECK_BUILDER_SOUL,
  CONCEPT_REFINEMENT_SOUL,
  COPY_REFINEMENT_SOUL,
};

const ASSIGNMENTS = Object.fromEntries(Object.values(AGENT_REGISTRY).map((agent) => [
  agent.promptFile,
  { agentName: agent.displayName, role: agent.role, soul: SOUL_BY_KEY[agent.soulKey], anatomy: renderAgentAnatomy(agent) },
]));

function assignmentFor(promptFile) {
  const assignment = ASSIGNMENTS[promptFile];
  if (!assignment) throw new Error(`BB Loona has no specialist assignment for ${promptFile}.`);
  if (!assignment.soul) throw new Error(`BB Loona assignment for ${promptFile} has no soul.`);
  return assignment;
}

function composeAgentInstructions(promptFile, houseRules, stagePrompt) {
  const assignment = assignmentFor(promptFile);
  const agent = agentForPrompt(promptFile);
  return [
    LOONA_SOUL,
    "---",
    BB_LOONA_SOUL,
    "---",
    `# BB Loona assignment\n\nYou are the ${assignment.role} specialist reporting to BB Loona. Own this stage. Do not act as the master agent, approve your own output, or bypass a human review gate.`,
    "---",
    assignment.soul,
    "---",
    assignment.anatomy,
    "---",
    `# Stage boundary\n\nStable stage ID: ${agent ? agent.stage : "unknown"}\nStable agent ID: ${agent ? agent.id : "unknown"}\nUse these IDs exactly in reasoning, validation and handoff discipline. Display names may be warm; IDs must stay stable.`,
    "---",
    houseRules,
    "---",
    stagePrompt,
  ].join("\n\n");
}

function coordinatorSnapshot(run) {
  const stages = run && run.stages ? run.stages : {};
  const active = STAGE_ORDER.find((stage) => {
    const status = stages[stage] && stages[stage].status;
    return status && !["approved", "locked"].includes(status);
  }) || STAGE_ORDER.find((stage) => !stages[stage] || stages[stage].status !== "approved") || null;
  return {
    name: "BB Loona",
    runId: run && run.runId,
    currentStage: active,
    status: run && run.status,
    humanApprovalRequired: Boolean(active && stages[active] && stages[active].status === "needs_review"),
  };
}

module.exports = { ASSIGNMENTS, assignmentFor, composeAgentInstructions, coordinatorSnapshot };
