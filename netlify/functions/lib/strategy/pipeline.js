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
const { loadBrandConfig, loadMonthInput, loadLearnings, loadBrandLibrary, loadPrompt } = require("./store");
const { ResearchSchema, StrategySchema, StrategyAssetSchema, CopySchema, CreativeDirectionSchema, DeckSpecSchema } = require("./contracts");
const { validateResearch, validateStrategy, validateCopy, validateDirection, validateDeck } = require("./validation");
const { OpenAIAgentsRuntime } = require("./runtime-openai");
const { FixtureRuntime } = require("./runtime-fixture");
const { StageValidationError } = require("./errors");
const { saveStageVersion, saveStageMetrics, saveFeedbackEvent } = require("./observability");

const MAX_REPAIRS = 2;

// Purely cosmetic — gives Hub's "Your next action" card a little personality while a
// stage is actually running, instead of the generic "Running agent." text. Keyed by
// def.stage, so a new stage just needs an entry here (falls back to a plain robot if one
// is ever missing). Concept refinement reuses Strategy's own persona since it's the same
// agent doing a smaller, scoped version of its regular job.
const STAGE_AGENTS = {
  research: { emoji: "👨🏻‍✈️", name: "Columbus" },
  strategy: { emoji: "🧕🏻", name: "Dora" },
  copy: { emoji: "👩‍🎨", name: "Matilda" },
  "creative-direction": { emoji: "👩🏼‍🎤", name: "Barbie" },
  "deck-builder": { emoji: "👷🏾", name: "Bob" },
};
function stageAgent(stage) {
  return STAGE_AGENTS[stage] || { emoji: "🤖", name: "The agent" };
}

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
  const startedAt = Date.now();
  const runtime = createRuntime(run);
  const instructions = def.fixedInstructions || loadPrompt(def.promptFile);
  let repairIssues = [];
  let previousOutput = null;
  let lastError = null;

  await fbUpdate(`strategy_runs/${runId}`, { status: def.runningStatus, updatedAt: new Date().toISOString() });

  const agent = stageAgent(def.stage);
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    await setStageStatus(runId, def.stage, {
      status: attempt === 0 ? "running" : "repairing",
      detail: attempt === 0
        ? `${agent.emoji} ${agent.name} is on it.`
        : `${agent.emoji} ${agent.name} is fixing an issue — attempt ${attempt} of ${MAX_REPAIRS}.`,
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
        await saveStageVersion(runId, def.stage, finalOutput, "generated", "system");
        await saveStageMetrics(runId, def.stage, {
          durationMs: Date.now() - startedAt,
          attempts: attempt + 1,
          repairs: attempt,
          outcome: "needs_review",
        });
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
  await saveStageMetrics(runId, def.stage, {
    durationMs: Date.now() - startedAt,
    attempts: MAX_REPAIRS + 1,
    repairs: MAX_REPAIRS,
    outcome: "failed",
  });
  await setStageStatus(runId, def.stage, { status: "failed", detail: message });
  await fbUpdate(`strategy_runs/${runId}`, { status: "failed", updatedAt: new Date().toISOString() });
  await logActivity(runId, "system", `${def.stage}.failed`, message);
  throw lastError;
}

async function runResearchStage(runId) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const config = await loadBrandConfig(run.brandId);
  const [monthInput, learnings, brandLibrary] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config, { force: true }),
  ]);
  const common = {
    brandConfig: config,
    monthInput,
    learnings,
    brandLibrary,
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
  const config = await loadBrandConfig(run.brandId);
  const [monthInput, learnings, brandLibrary] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config),
  ]);
  const common = {
    brandConfig: config,
    monthInput,
    learnings,
    brandLibrary,
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

async function runCopyStage(runId) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const strategy = run.stages && run.stages.strategy && run.stages.strategy.checkpoint;
  if (!strategy) throw new Error(`Run ${runId} has no approved strategy checkpoint yet.`);
  const config = await loadBrandConfig(run.brandId);
  const [monthInput, learnings, brandLibrary] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config),
  ]);
  const common = {
    brandConfig: config,
    monthInput,
    learnings,
    brandLibrary,
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
  const config = await loadBrandConfig(run.brandId);
  const [monthInput, learnings, brandLibrary] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config),
  ]);
  const common = {
    brandConfig: config,
    monthInput,
    learnings,
    brandLibrary,
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
  const config = await loadBrandConfig(run.brandId);
  const [monthInput, learnings, brandLibrary] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config),
  ]);
  const common = {
    brandConfig: config,
    monthInput,
    learnings,
    brandLibrary,
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

// ---------- Per-concept refine / suggest-similar / discard ----------
// Regenerates ONE asset within an already-produced (not yet approved) strategy plan,
// instead of the whole stage — brief section 9's "Kill + add to learnings, replacing just
// that one asset while keeping the rest", which strategy-stage-approve.js's header
// comment has flagged as a gap since the original vertical slice. Reuses the exact same
// full-array validateStrategy() on a plan with just that one slot swapped, rather than a
// separate partial validator — one source of truth for what a valid asset plan looks like,
// zero risk of the two checks drifting apart.
//
// Candidates are staged under stages/strategy/candidates/<assetId> rather than written
// straight into the checkpoint — "refine"/"similar" want a human to see the replacement
// before it's committed (see acceptConceptCandidate), while "discard" auto-accepts it
// immediately (see discardConcept) since there's nothing left to review: the old concept
// is already gone.
async function proposeConceptCandidate(runId, assetId, requestType, notes) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const strategyStage = run.stages && run.stages.strategy;
  const strategy = strategyStage && strategyStage.checkpoint;
  if (!strategy) throw new Error(`Run ${runId} has no strategy checkpoint yet.`);
  if (!["needs_review", "changes_requested"].includes(strategyStage.status)) {
    throw new Error(`Strategy is ${strategyStage.status}; concepts can only be refined while it's awaiting review.`);
  }
  const targetIndex = strategy.assets.findIndex((asset) => asset.assetId === assetId);
  if (targetIndex === -1) throw new Error(`Asset ${assetId} not found in this run's strategy.`);
  const targetAsset = strategy.assets[targetIndex];

  const research = run.stages.research && run.stages.research.checkpoint;
  const config = await loadBrandConfig(run.brandId);
  const [monthInput, learnings, brandLibrary] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config),
  ]);
  const runtime = createRuntime(run);
  const instructions = loadPrompt("06-concept-refine.md");
  const input = {
    brandConfig: config,
    monthInput,
    learnings,
    brandLibrary,
    research,
    currentAssetPlan: strategy.assets,
    targetAsset,
    request: { type: requestType, notes: notes || null },
  };

  const candidatePath = `strategy_runs/${runId}/stages/strategy/candidates/${assetId}`;
  const agent = stageAgent("strategy");
  await fbSet(candidatePath, {
    status: "running", requestType, notes: notes || null, updatedAt: new Date().toISOString(),
    detail: `${agent.emoji} ${agent.name} is sketching a replacement.`,
  });

  let repairIssues = [];
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    try {
      const raw = await runtime.runStage({
        // Suffixed with the request type — the fixture runtime maps `stage` straight to a
        // `<stage>.json` file (see runtime-fixture.js), so refine/similar/discard each get
        // their own offline fixture instead of colliding on one shared one; the real
        // runtime just sees this as the task label sent to the model, equally reasonable.
        stage: `strategy-concept-${requestType}`,
        agentName: "Loona Strategy — concept refinement",
        instructions,
        input,
        outputSchema: StrategyAssetSchema,
        toolProfile: "none",
        repairIssues,
      });
      const parsed = StrategyAssetSchema.parse(raw);
      // The model isn't choosing a new slot, only new content for this one — force the
      // structural fields back to the original regardless of what it returned, the same
      // way deck-builder's enrich() never trusts the model with fields it can't know.
      const candidate = Object.assign({}, parsed, {
        assetId: targetAsset.assetId,
        sequence: targetAsset.sequence,
        format: targetAsset.format,
        portfolioId: targetAsset.portfolioId,
        skuIds: targetAsset.skuIds,
      });
      const swappedAssets = strategy.assets.map((asset, i) => (i === targetIndex ? candidate : asset));
      const issues = validateStrategy(Object.assign({}, strategy, { assets: swappedAssets }), config, research, learnings, run.month);
      if (issues.length === 0) {
        await fbSet(candidatePath, { status: "ready", requestType, notes: notes || null, candidate, updatedAt: new Date().toISOString() });
        return candidate;
      }
      repairIssues = issues;
      lastError = new StageValidationError(`strategy-concept-${requestType}`, issues);
    } catch (error) {
      lastError = error;
      repairIssues = [`Schema or runtime failure: ${error && error.message ? error.message : String(error)}`];
    }
  }
  const message = lastError && lastError.message ? lastError.message : String(lastError);
  await fbSet(candidatePath, { status: "failed", requestType, notes: notes || null, detail: message, updatedAt: new Date().toISOString() });
  throw lastError;
}

// Commits a "ready" candidate into the actual strategy checkpoint. Re-validates the WHOLE
// resulting plan (not just the one asset) as a safety net in case anything about the plan
// changed between proposing and accepting, records a stage-version snapshot before and
// after the swap (matching strategy-stage-approve.js's own versioning), and folds the
// supersession into the brand's learnings so future months don't repeat the killed concept.
async function acceptConceptCandidate(runId, assetId, actor) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const strategy = run.stages && run.stages.strategy && run.stages.strategy.checkpoint;
  if (!strategy) throw new Error(`Run ${runId} has no strategy checkpoint yet.`);
  const candidatePath = `strategy_runs/${runId}/stages/strategy/candidates/${assetId}`;
  const candidateDoc = await fbGet(candidatePath);
  if (!candidateDoc || candidateDoc.status !== "ready" || !candidateDoc.candidate) {
    throw new Error(`No ready candidate for ${assetId}.`);
  }
  const targetIndex = strategy.assets.findIndex((asset) => asset.assetId === assetId);
  if (targetIndex === -1) throw new Error(`Asset ${assetId} not found in this run's strategy.`);
  const oldAsset = strategy.assets[targetIndex];
  const newAssets = strategy.assets.map((asset, i) => (i === targetIndex ? candidateDoc.candidate : asset));
  const newStrategy = Object.assign({}, strategy, { assets: newAssets });

  const research = run.stages.research && run.stages.research.checkpoint;
  const [config, learnings] = await Promise.all([loadBrandConfig(run.brandId), loadLearnings(run.brandId)]);
  const issues = validateStrategy(newStrategy, config, research, learnings, run.month);
  if (issues.length) throw new StageValidationError(`strategy-concept-${candidateDoc.requestType}`, issues);

  await saveStageVersion(runId, "strategy", strategy, `concept_${candidateDoc.requestType}_before`, actor || "system");
  await fbSet(`strategy_runs/${runId}/stages/strategy/checkpoint`, newStrategy);
  await saveStageVersion(runId, "strategy", newStrategy, `concept_${candidateDoc.requestType}`, actor || "system");
  await fbSet(candidatePath, null);
  await saveFeedbackEvent(
    run,
    "strategy",
    `concept_${candidateDoc.requestType}`,
    `Replaced "${oldAsset.conceptName}" (${oldAsset.hook}) with "${candidateDoc.candidate.conceptName}" (${candidateDoc.candidate.hook}).` +
      (candidateDoc.notes ? ` Notes: ${candidateDoc.notes}` : ""),
    actor || "system",
  );
  await logActivity(runId, actor || "system", `strategy.concept_${candidateDoc.requestType}`, oldAsset.assetId);
  return newStrategy;
}

// "Discard" has no review step — the old concept is already gone, so propose + accept
// happen together as one action. If generation fails after every repair attempt, the
// original concept is left in place (never silently removed) and the candidate sits in
// "failed" with the real error, same as any other stage's failed+Retry state — re-running
// this same function is the retry.
async function discardConcept(runId, assetId, notes, actor) {
  await proposeConceptCandidate(runId, assetId, "discard", notes);
  return acceptConceptCandidate(runId, assetId, actor);
}

module.exports = {
  runResearchStage, runStrategyStage, runCopyStage, runDirectionStage, runDeckStage,
  proposeConceptCandidate, acceptConceptCandidate, discardConcept,
  logActivity, buildStrategyResearchBrief,
};

