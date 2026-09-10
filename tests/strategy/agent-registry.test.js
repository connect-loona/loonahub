"use strict";
const assert = require("assert");
const { AGENT_REGISTRY, STAGE_ORDER, agentForPrompt, renderAgentAnatomy, assertCompleteRegistry } = require("../../netlify/functions/lib/strategy/agents/agent-registry");
const { composeAgentInstructions } = require("../../netlify/functions/lib/strategy/bb-loona");

function includes(haystack, needle) {
  assert.ok(haystack.includes(needle), `Expected text to include: ${needle}`);
}

assertCompleteRegistry();

for (const stage of STAGE_ORDER) {
  const agent = AGENT_REGISTRY[stage];
  assert.ok(agent, `${stage} must have an agent definition`);
  assert.strictEqual(agent.stage, stage, `${stage} must use its stable stage id`);
  assert.ok(agent.objective.length > 40, `${stage} needs a real objective`);
  assert.ok(agent.inputs.length >= 3, `${stage} needs explicit inputs`);
  assert.ok(agent.memory.length >= 3, `${stage} needs memory rules`);
  assert.ok(agent.guardrails.length >= 3, `${stage} needs guardrails`);
  assert.ok(agent.qualityChecks.length >= 3, `${stage} needs quality checks`);

  const anatomy = renderAgentAnatomy(agent);
  includes(anatomy, `Formal agent anatomy — ${agent.displayName}`);
  includes(anatomy, "## Objective");
  includes(anatomy, "## Inputs");
  includes(anatomy, "## Memory to retrieve");
  includes(anatomy, "## Guardrails");
  includes(anatomy, "## Quality checks");

  const composed = composeAgentInstructions(agent.promptFile, "HOUSE RULES", "STAGE PROMPT");
  includes(composed, agent.displayName);
  includes(composed, agent.objective);
  includes(composed, `Stable stage ID: ${agent.stage}`);
  includes(composed, `Stable agent ID: ${agent.id}`);
  includes(composed, "HOUSE RULES");
  includes(composed, "STAGE PROMPT");
}

for (const promptFile of ["06-concept-refine.md", "07-copy-refine.md"]) {
  const agent = agentForPrompt(promptFile);
  assert.ok(agent, `${promptFile} must resolve to a refinement agent`);
  assert.ok(agent.guardrails.includes("Do not change unrelated assets."), `${promptFile} must stay single-asset scoped`);
  const composed = composeAgentInstructions(promptFile, "HOUSE RULES", "STAGE PROMPT");
  includes(composed, "Do not change unrelated assets.");
}

console.log("agent-registry.test.js passed");
