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
} = require("./souls-data");

const ASSIGNMENTS = {
  "01-research.md": { agentName: "Loona Research", role: "Research", soul: RESEARCH_SOUL },
  "02-strategy.md": { agentName: "Loona Strategy", role: "Strategy", soul: STRATEGY_SOUL },
  "03-copy.md": { agentName: "Loona Copy", role: "Copy", soul: COPY_SOUL },
  "04-creative-direction.md": { agentName: "Loona Creative Direction", role: "Creative Direction", soul: CREATIVE_DIRECTION_SOUL },
  "05-deck-builder.md": { agentName: "Loona Deck Builder", role: "Deck Builder", soul: DECK_BUILDER_SOUL },
  "06-concept-refine.md": { agentName: "Loona Strategy — concept refinement", role: "Concept Refinement", soul: CONCEPT_REFINEMENT_SOUL },
};

function assignmentFor(promptFile) {
  const assignment = ASSIGNMENTS[promptFile];
  if (!assignment) throw new Error(`BB Loona has no specialist assignment for ${promptFile}.`);
  return assignment;
}

function composeAgentInstructions(promptFile, houseRules, stagePrompt) {
  const assignment = assignmentFor(promptFile);
  return [
    LOONA_SOUL,
    "---",
    BB_LOONA_SOUL,
    "---",
    `# BB Loona assignment\n\nYou are the ${assignment.role} specialist reporting to BB Loona. Own this stage. Do not act as the master agent, approve your own output, or bypass a human review gate.`,
    "---",
    assignment.soul,
    "---",
    houseRules,
    "---",
    stagePrompt,
  ].join("\n\n");
}

function coordinatorSnapshot(run) {
  const order = ["research", "strategy", "copy", "creative-direction", "deck-builder"];
  const stages = run && run.stages ? run.stages : {};
  const active = order.find((stage) => {
    const status = stages[stage] && stages[stage].status;
    return status && !["approved", "locked"].includes(status);
  }) || order.find((stage) => !stages[stage] || stages[stage].status !== "approved") || null;
  return {
    name: "BB Loona",
    runId: run && run.runId,
    currentStage: active,
    status: run && run.status,
    humanApprovalRequired: Boolean(active && stages[active] && stages[active].status === "needs_review"),
  };
}

module.exports = { ASSIGNMENTS, assignmentFor, composeAgentInstructions, coordinatorSnapshot };
