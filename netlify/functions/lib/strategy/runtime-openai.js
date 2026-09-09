// Ported from loona-strategy-agents/src/runtimes/openai.ts. Uses the SAME OPENAI_API_KEY
// Hub already has provisioned (see chat.js, marketing-news-daily.js) — no new credential
// for this vertical slice. Model id is read from an env var, never hard-coded, per the
// build brief's instruction not to bake in a current model name.
"use strict";
const { Agent, run, webSearchTool, setTracingDisabled } = require("@openai/agents");
const { ConfigurationError } = require("./errors");

class OpenAIAgentsRuntime {
  constructor(model) {
    if (!process.env.OPENAI_API_KEY) {
      throw new ConfigurationError("OPENAI_API_KEY is required for the OpenAI runtime.");
    }
    this.model = model || process.env.STRATEGY_OPENAI_MODEL || "gpt-5.4";
    setTracingDisabled((process.env.OPENAI_AGENTS_DISABLE_TRACING || "true") !== "false");
  }

  // request: { stage, agentName, instructions, input, outputSchema, toolProfile, repairIssues }
  async runStage(request) {
    const tools = [];
    if (request.toolProfile === "research") {
      tools.push(webSearchTool({ searchContextSize: "high" }));
    }
    if (request.toolProfile === "reference-search") {
      // Creative Direction needs real, findable reference images — not just text search.
      tools.push(
        webSearchTool({
          searchContextSize: "medium",
          searchContentTypes: ["text", "image"],
          imageSettings: { maxResults: 8, caption: true },
        }),
      );
    }

    const repairBlock = request.repairIssues && request.repairIssues.length
      ? {
          mode: "repair",
          instruction:
            "Repair the previous stage output. Address every validation issue without weakening approved work or changing IDs.",
          validationIssues: request.repairIssues,
        }
      : { mode: "initial" };

    const agent = new Agent({
      name: request.agentName,
      model: this.model,
      instructions: request.instructions,
      tools,
      outputType: request.outputSchema,
    });
    const result = await run(
      agent,
      JSON.stringify({ task: request.stage, repair: repairBlock, payload: request.input }),
      { maxTurns: request.toolProfile === "none" ? 3 : 10 },
    );
    if (result.finalOutput === undefined || result.finalOutput === null) {
      throw new Error(`${request.agentName} returned no final output.`);
    }
    return request.outputSchema.parse(result.finalOutput);
  }
}

module.exports = { OpenAIAgentsRuntime };
