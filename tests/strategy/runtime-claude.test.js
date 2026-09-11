// Tests runtime-claude.js's request/response wiring against a fake injected Anthropic
// client — there's no ANTHROPIC_API_KEY in this environment, so this can't (and doesn't
// try to) exercise a real call; it checks that ClaudeRuntime builds the request the same
// way runtime-openai.js's equivalent does (schema pass-through, repair-block shape, tool
// profile mapping) and handles the documented response/error shapes correctly.
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { ClaudeRuntime } = require(path.join(HUB, "netlify/functions/lib/strategy/runtime-claude"));
const { z } = require("zod");
const { ConfigurationError } = require(path.join(HUB, "netlify/functions/lib/strategy/errors"));

const TestSchema = z.object({ ok: z.boolean() }).strict();

(async () => {
  // ---- Missing ANTHROPIC_API_KEY (and no injected client) throws ConfigurationError ----
  const hadKey = "ANTHROPIC_API_KEY" in process.env;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let threw = null;
  try {
    // eslint-disable-next-line no-new
    new ClaudeRuntime();
  } catch (e) {
    threw = e;
  }
  check("throws without ANTHROPIC_API_KEY and no injected client", threw instanceof ConfigurationError, threw && threw.message);
  if (hadKey) process.env.ANTHROPIC_API_KEY = savedKey;

  // ---- Basic (toolProfile: "none") request shape ----
  let lastParseCall = null;
  const fakeClientBasic = {
    messages: {
      parse: async (params) => { lastParseCall = params; return { parsed_output: { ok: true } }; },
      create: async () => { throw new Error("messages.create should not be called for toolProfile: none"); },
    },
  };
  const basicRuntime = new ClaudeRuntime("claude-opus-5", fakeClientBasic);
  const basicResult = await basicRuntime.runStage({
    stage: "strategy", agentName: "🧕🏻 Dora — Strategy", instructions: "Be Dora.",
    input: { brandConfig: { id: "rro" } }, outputSchema: TestSchema, toolProfile: "none", repairIssues: [],
  });
  check("returns the client's parsed_output", basicResult && basicResult.ok === true, basicResult);
  check("passes the model through", lastParseCall.model === "claude-opus-5", lastParseCall.model);
  check("passes instructions as the system prompt", lastParseCall.system === "Be Dora.", lastParseCall.system);
  check("no tools declared for toolProfile: none", !lastParseCall.tools, lastParseCall.tools);
  const basicPayload = JSON.parse(lastParseCall.messages[0].content);
  check("payload carries the stage as task", basicPayload.task === "strategy", basicPayload.task);
  check("payload carries the actual input", basicPayload.payload.brandConfig.id === "rro", basicPayload.payload);
  check("repair.mode is \"initial\" with no repairIssues", basicPayload.repair.mode === "initial", basicPayload.repair);
  check("output_config.format carries a JSON schema converted from the Zod schema", lastParseCall.output_config.format.schema.properties.ok, lastParseCall.output_config.format);

  // ---- Repair path ----
  const repairRuntime = new ClaudeRuntime("claude-opus-5", fakeClientBasic);
  await repairRuntime.runStage({
    stage: "copy", agentName: "Matilda", instructions: "Be Matilda.",
    input: {}, outputSchema: TestSchema, toolProfile: "none", repairIssues: ["Fix the thing."],
  });
  const repairPayload = JSON.parse(lastParseCall.messages[0].content);
  check("repair.mode is \"repair\" when repairIssues is non-empty", repairPayload.repair.mode === "repair", repairPayload.repair);
  check("repair carries the actual validation issues", repairPayload.repair.validationIssues.includes("Fix the thing."), repairPayload.repair);

  // ---- Tool-using profile ("research"): a gathering pass, then the structured pass ----
  let createCall = null;
  const fakeClientWithTools = {
    messages: {
      create: async (params) => { createCall = params; return { content: [{ type: "text", text: "Found some real evidence via search." }] }; },
      parse: async (params) => { lastParseCall = params; return { parsed_output: { ok: true } }; },
    },
  };
  const researchRuntime = new ClaudeRuntime("claude-opus-5", fakeClientWithTools);
  await researchRuntime.runStage({
    stage: "research", agentName: "Columbus", instructions: "Be Columbus.",
    input: { brandConfig: { id: "rro" } }, outputSchema: TestSchema, toolProfile: "research", repairIssues: [],
  });
  check("the gathering pass declares the web_search tool", createCall.tools.some((t) => t.type === "web_search_20260209"), createCall.tools);
  check("the structured pass carries the gathered research notes forward", lastParseCall.messages[0].content.includes("Found some real evidence via search."), lastParseCall.messages[0].content);

  // ---- reference-search profile also gets the web_search tool ----
  createCall = null;
  const directionRuntime = new ClaudeRuntime("claude-opus-5", fakeClientWithTools);
  await directionRuntime.runStage({
    stage: "creative-direction", agentName: "Barbie", instructions: "Be Barbie.",
    input: {}, outputSchema: TestSchema, toolProfile: "reference-search", repairIssues: [],
  });
  check("reference-search also gets the web_search tool", createCall.tools.some((t) => t.type === "web_search_20260209"), createCall.tools);

  // ---- Missing parsed_output surfaces a clear error, not a silent undefined ----
  const emptyOutputClient = { messages: { parse: async () => ({ parsed_output: null }) } };
  const emptyRuntime = new ClaudeRuntime("claude-opus-5", emptyOutputClient);
  let emptyError = null;
  try {
    await emptyRuntime.runStage({ stage: "strategy", agentName: "Dora", instructions: "x", input: {}, outputSchema: TestSchema, toolProfile: "none", repairIssues: [] });
  } catch (e) {
    emptyError = e;
  }
  check("throws a clear error when parsed_output is missing", emptyError && emptyError.message.includes("no parseable structured output"), emptyError && emptyError.message);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
