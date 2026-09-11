// A second runtime alongside runtime-openai.js — every Strategy OS agent (Columbus,
// Dora, Matilda, Barbie, Bob, and both refinement specialists) already runs through
// createRuntime() in pipeline.js, so adding "claude" as a selectable runtime value there
// (see strategy-run-start.js's `runtime` field) puts Claude behind the exact same
// interface every other stage already uses — nothing stage-specific to wire up per agent.
//
// Uses the Anthropic Messages API's structured-output helper (client.messages.parse() +
// zodOutputFormat()) to get the SAME kind of schema-validated result runtime-openai.js
// gets from the OpenAI Agents SDK's `outputType`. Tool-using stages (research's/creative-
// direction's web search) are handled in a first pass that gathers information in plain
// text, then a second call turns that plus the original payload into the schema-shaped
// result — the Anthropic docs show tools and output_config.format each on their own, not
// combined in one call, so this keeps every step to exactly what's documented rather than
// guessing at an undocumented combination.
//
// Not exercised against a live Anthropic account anywhere in this repo's test suite (no
// ANTHROPIC_API_KEY in this environment) — tests/strategy/runtime-claude.test.js instead
// injects a fake `client` to check the request/response wiring (schema pass-through, tool
// profile mapping, repair-block shape, the missing-output error path) without a real call.
"use strict";
const { ConfigurationError } = require("./errors");

// research and creative-direction are the two stages that call out to the web (see
// runtime-openai.js's own toolProfile handling) — Claude's web_search tool covers both;
// there's no separate "image search" server tool to mirror OpenAI's
// searchContentTypes/imageSettings for creative-direction's reference-search profile, so
// both profiles get the same web-search tool here.
function toolsForProfile(profile) {
  if (profile === "research" || profile === "reference-search") {
    return [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }];
  }
  return [];
}

// The SDK reads ANTHROPIC_API_KEY on its own, which is the name netlify.toml documents.
// CLAUDE_API_KEY is accepted as well because that is the name actually set in the Netlify
// dashboard (added 2026-04-04, and until now read by nothing — this runtime looked for
// ANTHROPIC_API_KEY, found nothing, and refused to start, which is why "Claude isn't
// connected" despite a key being present the whole time). Same both-names-accepted
// approach netlify.toml already documents for the GOOGLE_CALENDER_SERVICE_ACCOUNT
// misspelling: match whatever the dashboard really has rather than requiring someone to
// re-enter a working secret.
function anthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
}

class ClaudeRuntime {
  constructor(model, client) {
    const apiKey = anthropicApiKey();
    if (!client && !apiKey) {
      throw new ConfigurationError("ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is required for the Claude runtime.");
    }
    // `client` is an injection point for tests — production code always takes the
    // default branch and constructs a real SDK client.
    if (client) {
      this.client = client;
    } else {
      const Anthropic = require("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey });
    }
    this.model = model || process.env.STRATEGY_CLAUDE_MODEL || "claude-opus-5";
  }

  // request: { stage, agentName, instructions, input, outputSchema, toolProfile, repairIssues }
  async runStage(request) {
    const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");

    const repairBlock = request.repairIssues && request.repairIssues.length
      ? {
          mode: "repair",
          instruction:
            "Repair the previous stage output. Address every validation issue without weakening approved work or changing IDs.",
          validationIssues: request.repairIssues,
        }
      : { mode: "initial" };
    const payload = JSON.stringify({ task: request.stage, repair: repairBlock, payload: request.input });

    const tools = toolsForProfile(request.toolProfile);
    let researchNotes = "";
    if (tools.length) {
      const gathering = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: request.instructions,
        tools,
        messages: [{
          role: "user",
          content: `${payload}\n\nGather whatever real, current information you need via web search before the final structured output is produced in the next step. Respond with your findings in plain text — do not attempt to produce the final schema-shaped output yet.`,
        }],
      });
      researchNotes = gathering.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");
    }

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: request.instructions,
      output_config: { format: zodOutputFormat(request.outputSchema) },
      messages: [{
        role: "user",
        content: researchNotes ? `${payload}\n\nResearch notes gathered via web search:\n${researchNotes}` : payload,
      }],
    });
    if (!response.parsed_output) {
      throw new Error(`${request.agentName} returned no parseable structured output.`);
    }
    return response.parsed_output;
  }
}

module.exports = { ClaudeRuntime };
