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
const { ResearchSchema, StrategySchema, CopySchema, CreativeDirectionSchema, DeckSpecSchema } = require("./contracts");
const { validateResearch, validateStrategy, validateCopy, validateDirection, validateDeck } = require("./validation");
const { OpenAIAgentsRuntime } = require("./runtime-openai");
const { FixtureRuntime } = require("./runtime-fixture");
const { StageValidationError } = require("./errors");

const MAX_REPAIRS = 2;

function createRuntime(run) {
  if (run.runtime === "fixture") return new FixtureRuntime(run.fixtureDir);
  return new OpenAIAgentsRuntime();
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
        // enrich() adds fields the model has no way to know (e.g. deck page owner/status)
        // AFTER validation passes — never asked of the model itself, so it can't fabricate
        // a plausible-looking owner or status. See contracts.js's DeckPageSchema comment.
        const finalOutput = def.enrich ? def.enrich(parsed) : parsed;
        await setStageStatus(runId, def.stage, { status: "needs_review", detail: "Validated. Awaiting review.", checkpoint: finalOutput, error: null });
        await fbUpdate(`strategy_runs/${runId}`, { status: def.reviewStatus, updatedAt: new Date().toISOString() });
        await logActivity(runId, "system", `${def.stage}.completed`, `Passed on attempt ${attempt + 1}.`);
        return finalOutput;
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
    input: Object.assign({}, common, { research }),
    validate: (output) => validateStrategy(output, config, research, learnings, run.month),
    runningStatus: "strategy_running",
    reviewStatus: "strategy_needs_review",
  });
}

async function runCopyStage(runId) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const strategy = run.stages && run.stages.strategy && run.stages.strategy.checkpoint;
  if (!strategy) throw new Error(`Run ${runId} has no approved strategy checkpoint yet.`);
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
    stage: "copy",
    agentName: "Loona Copy",
    promptFile: "03-copy.md",
    schema: CopySchema,
    toolProfile: "none",
    input: Object.assign({}, common, { strategy }),
    validate: (output) => validateCopy(output, config, strategy, run.month),
    runningStatus: "copy_running",
    reviewStatus: "copy_needs_review",
  });
}

async function runDirectionStage(runId) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const strategy = run.stages && run.stages.strategy && run.stages.strategy.checkpoint;
  const copy = run.stages && run.stages.copy && run.stages.copy.checkpoint;
  if (!strategy || !copy) throw new Error(`Run ${runId} has no approved strategy/copy checkpoint yet.`);
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
    stage: "creative-direction",
    agentName: "Loona Creative Direction",
    promptFile: "04-creative-direction.md",
    schema: CreativeDirectionSchema,
    toolProfile: "reference-search",
    input: Object.assign({}, common, { strategy, copy }),
    validate: (output) => validateDirection(output, config, strategy, run.month),
    // Prefixed with the exact stage key ("creative-direction"), matching every other
    // stage's runningStatus/reviewStatus naming and strategy-stage-approve.js's own
    // `${stage}_approved` / `${stage}_changes_requested` — so run.status always follows
    // one consistent `${stageKey}_${state}` shape the UI can rely on everywhere.
    runningStatus: "creative-direction_running",
    reviewStatus: "creative-direction_needs_review",
  });
}

async function runDeckStage(runId) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const strategy = run.stages && run.stages.strategy && run.stages.strategy.checkpoint;
  const copy = run.stages && run.stages.copy && run.stages.copy.checkpoint;
  const direction = run.stages && run.stages["creative-direction"] && run.stages["creative-direction"].checkpoint;
  if (!strategy || !copy || !direction) throw new Error(`Run ${runId} has no approved strategy/copy/direction checkpoint yet.`);
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
  const result = await executeStage(runId, run, {
    stage: "deck-builder",
    agentName: "Loona Deck Builder",
    promptFile: "05-deck-builder.md",
    schema: DeckSpecSchema,
    toolProfile: "none",
    input: Object.assign({}, common, { strategy, copy, creativeDirection: direction }),
    validate: (output) => validateDeck(output, config, strategy, copy, direction, run.month),
    // See the creative-direction stage's comment above — kept as `${stageKey}_${state}`
    // ("deck-builder_running"/"deck-builder_needs_review") for the same reason.
    runningStatus: "deck-builder_running",
    reviewStatus: "deck-builder_needs_review",
    // Owner/production status aren't something the model can know — see contracts.js.
    // Every page starts unassigned and not started; a human assigns/advances them later.
    enrich: (deck) => Object.assign({}, deck, {
      pages: deck.pages.map((page) => Object.assign({ owner: null, productionStatus: "not_started" }, page)),
    }),
  });

  // Canva publish is attempted automatically once the deck spec itself is valid — there's
  // no separate approval gate for it (nothing further is being decided; it's assembly of
  // already-approved content). If Canva isn't configured for this brand, this stays a
  // clean, visible "not configured" state rather than a failure — the brief's own fallback
  // is to ship the review stages and keep deck assembly manual until Canva's ready.
  const config2 = await loadBrandConfig(run.brandId);
  if (config2.canva && config2.canva.enabled) {
    try {
      const { CanvaPublisher } = require("./canva");
      const canvaResult = await new CanvaPublisher().publish(config2, result);
      await fbSet(`strategy_runs/${runId}/stages/deck-builder/canva`, { status: "published", url: canvaResult.designUrl, publishedAt: new Date().toISOString() });
    } catch (error) {
      await fbSet(`strategy_runs/${runId}/stages/deck-builder/canva`, { status: "failed", detail: error.message || String(error) });
    }
  } else {
    await fbSet(`strategy_runs/${runId}/stages/deck-builder/canva`, { status: "not_configured", detail: "Canva isn't enabled for this brand yet — the deck content above is ready; publishing to an actual Canva deck needs Canva credentials and a tagged template configured first." });
  }

  return result;
}

module.exports = { runResearchStage, runStrategyStage, runCopyStage, runDirectionStage, runDeckStage, logActivity };
