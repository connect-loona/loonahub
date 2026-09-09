// Replaces loona-strategy-agents/src/core/pipeline.ts's runPipeline() (which runs all
// five stages back-to-back with no pause for human approval) with two independently
// invokable stage runners. Each one runs its own repair loop (2 retries, same as the
// original), writes progress to Firebase as it goes so the Hub UI's live listener can
// show it, checkpoints the validated output, and then STOPS — the next stage only starts
// when a human approves via strategy-stage-approve.js. That pause is the whole point of
// splitting this apart: the brief requires review-and-approve between every stage, and
// the original runPipeline() has no such gate built in.
"use strict";
const { fbGet, fbSet, fbUpdate } = require("./firebase");
const { loadBrandConfig, loadMonthInput, loadLearnings, loadPrompt } = require("./store");
const { ResearchSchema, StrategySchema } = require("./contracts");
const { validateResearch, validateStrategy } = require("./validation");
const { OpenAIAgentsRuntime } = require("./runtime-openai");
const { FixtureRuntime } = require("./runtime-fixture");
const { StageValidationError } = require("./errors");

const MAX_REPAIRS = 2;

function createRuntime(run) {
  if (run.runtime === "fixture") return new FixtureRuntime(run.fixtureDir);
  return new OpenAIAgentsRuntime();
}

// Strategy needs the evidence and tensions that survived Research, not its full working
// transcript. Keeping the handoff explicit makes the prompt smaller and prevents source
// metadata/research notes from crowding out concept development.
function buildStrategyResearchBrief(research) {
  const usedSourceIds = new Set();
  const groups = ["liveQuestions", "arguments", "unspokenBehaviours", "exhaustedTerritory", "calendar", "whitespace", "verifiedFacts"];
  for (const group of groups) {
    for (const item of research[group] || []) {
      for (const id of item.sourceIds || []) usedSourceIds.add(id);
    }
  }
  return {
    brandId: research.brandId,
    month: research.month,
    categoryFrame: research.categoryFrame,
    sources: (research.sources || []).filter((source) => usedSourceIds.has(source.id)).map((source) => ({
      id: source.id,
      title: source.title,
      evidence: source.evidence,
    })),
    liveQuestions: research.liveQuestions,
    arguments: research.arguments,
    unspokenBehaviours: research.unspokenBehaviours,
    exhaustedTerritory: research.exhaustedTerritory,
    calendar: research.calendar,
    whitespace: research.whitespace,
    verifiedFacts: research.verifiedFacts,
    unknowns: research.unknowns,
  };
}

async function logActivity(runId, actor, action, detail) {
  const { fbPush } = require("./firebase");
  await fbPush(`strategy_activity/${runId}`, { actor, action, detail: detail || null, at: new Date().toISOString() });
}

async function setStageStatus(runId, stage, patch) {
  await fbUpdate(`strategy_runs/${runId}/stages/${stage}`, Object.assign({ updatedAt: new Date().toISOString() }, patch));
}

// Shared by both stage runners — identical shape to the original executeStage(), just
// backed by Firebase instead of a local checkpoint file.
async function executeStage(runId, run, def) {
  const runtime = createRuntime(run);
  const instructions = def.fixedInstructions || loadPrompt(def.promptFile);
  let repairIssues = [];
  let previousOutput = null;
  let lastError = null;

  await fbUpdate(`strategy_runs/${runId}`, { status: def.runningStatus, updatedAt: new Date().toISOString() });

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    await setStageStatus(runId, def.stage, {
      status: attempt === 0 ? "running" : "repairing",
      detail: attempt === 0 ? "Running agent." : `Repair attempt ${attempt} of ${MAX_REPAIRS}.`,
    });
    try {
      const input = previousOutput ? { originalInput: def.input, previousOutput } : def.input;
      const candidate = await runtime.runStage({
        stage: def.stage,
        agentName: def.agentName,
        instructions,
        input,
        outputSchema: def.schema,
        toolProfile: def.toolProfile,
        repairIssues,
      });
      const parsed = def.schema.parse(candidate);
      const issues = def.validate(parsed);
      await fbSet(`strategy_runs/${runId}/attempts/${def.stage}/${attempt + 1}`, { issues, output: parsed });
      if (issues.length === 0) {
        await setStageStatus(runId, def.stage, { status: "needs_review", detail: "Validated. Awaiting review.", checkpoint: parsed, error: null });
        await fbUpdate(`strategy_runs/${runId}`, { status: def.reviewStatus, updatedAt: new Date().toISOString() });
        await logActivity(runId, "system", `${def.stage}.completed`, `Passed on attempt ${attempt + 1}.`);
        return parsed;
      }
      previousOutput = parsed;
      repairIssues = issues;
      lastError = new StageValidationError(def.stage, issues);
    } catch (error) {
      lastError = error;
      repairIssues = [`Schema or runtime failure: ${error && error.message ? error.message : String(error)}`];
      await fbSet(`strategy_runs/${runId}/attempts/${def.stage}/${attempt + 1}`, { issues: repairIssues, error: true });
    }
  }

  const message = lastError && lastError.message ? lastError.message : String(lastError);
  await setStageStatus(runId, def.stage, { status: "failed", detail: message });
  await fbUpdate(`strategy_runs/${runId}`, { status: "failed", updatedAt: new Date().toISOString() });
  await logActivity(runId, "system", `${def.stage}.failed`, message);
  throw lastError;
}

async function runResearchStage(runId) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const [config, monthInput, learnings] = await Promise.all([
    loadBrandConfig(run.brandId),
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
  ]);
  const common = {
    brandConfig: config,
    monthInput,
    learnings,
    sourceContext: run.sourceContext || [],
    currentDate: new Date().toISOString(),
  };
  return executeStage(runId, run, {
    stage: "research",
    agentName: "Loona Research",
    promptFile: "01-research.md",
    schema: ResearchSchema,
    toolProfile: "research",
    input: common,
    validate: (output) => validateResearch(output, config, run.month),
    runningStatus: "research_running",
    reviewStatus: "research_needs_review",
  });
}

async function runStrategyStage(runId) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const research = run.stages && run.stages.research && run.stages.research.checkpoint;
  if (!research) throw new Error(`Run ${runId} has no approved research checkpoint yet.`);
  const [config, monthInput, learnings] = await Promise.all([
    loadBrandConfig(run.brandId),
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
  ]);
  const common = {
    brandConfig: config,
    monthInput,
    learnings,
    sourceContext: run.sourceContext || [],
    currentDate: new Date().toISOString(),
  };
  return executeStage(runId, run, {
    stage: "strategy",
    agentName: "Loona Strategy",
    promptFile: "02-strategy.md",
    schema: StrategySchema,
    toolProfile: "none",
    input: Object.assign({}, common, { research: buildStrategyResearchBrief(research) }),
    validate: (output) => validateStrategy(output, config, research, learnings, run.month),
    runningStatus: "strategy_running",
    reviewStatus: "strategy_needs_review",
  });
}

module.exports = { runResearchStage, runStrategyStage, logActivity, buildStrategyResearchBrief };
