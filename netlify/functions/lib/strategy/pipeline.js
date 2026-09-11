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
const { ResearchSchema, StrategySchema, StrategyAssetSchema, CopySchema, CopyAssetSchema, CreativeDirectionSchema, DeckSpecSchema } = require("./contracts");
const { validateResearch, validateStrategy, validateCopy, validateDirection, validateDeck, allCopyText, checkNoteObedience } = require("./validation");
const { OpenAIAgentsRuntime } = require("./runtime-openai");
const { ClaudeRuntime } = require("./runtime-claude");
const { FixtureRuntime } = require("./runtime-fixture");
const { FailoverRuntime, isProviderError } = require("./runtime-failover");
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

// Two model tiers per provider. "standard" is the thinking tier every judgement stage
// runs on; "economy" is the cheap tier for stages that are assembly rather than judgement.
// Model ids stay in env vars, never hard-coded here, per the build brief — these are only
// the fallbacks for when nothing is configured (the same ones each runtime already
// defaulted to, plus an economy default per provider).
const MODEL_TIERS = {
  openai: {
    standard: () => process.env.STRATEGY_OPENAI_MODEL || "gpt-5.4",
    economy: () => process.env.STRATEGY_OPENAI_MODEL_ECONOMY || "gpt-4o-mini",
  },
  claude: {
    standard: () => process.env.STRATEGY_CLAUDE_MODEL || "claude-opus-5",
    economy: () => process.env.STRATEGY_CLAUDE_MODEL_ECONOMY || "claude-haiku-4-5-20251001",
  },
};

// Deck Builder is the one stage that decides nothing. Every judgement call — which concepts
// survive, what they say, how they look — was made and human-approved upstream; Bob's job is
// to lay approved content into deck pages against a fixed schema (toolProfile: "none", no
// web search, no new ideas). That's exactly the work a cheap model does as well as an
// expensive one, and it's the longest single output in the pipeline, so it's also where the
// spend actually is.
//
// Every other stage stays on the standard tier: research judges what's true, strategy and
// copy judge what's good, creative direction judges what's findable. Those are not places to
// save money.
const STAGE_MODEL_TIERS = {
  "deck-builder": "economy",
};

function tierForStage(stage) {
  return STAGE_MODEL_TIERS[stage] || "standard";
}

// Should a cheap stage move up to the standard model for this attempt? Yes exactly once,
// and only when the previous attempt produced a bad ANSWER — a schema or validation
// failure. Failover can't rescue those (they aren't provider errors), so without escalating
// the economy tier would burn every repair attempt against a model that already showed it
// can't do this job.
//
// Not when the provider simply couldn't answer: a pricier model of a provider that's out of
// credits fails identically, and FailoverRuntime has already tried the other provider.
function shouldEscalateTier({ tier, attempt, alreadyEscalated, lastError }) {
  if (attempt === 0 || alreadyEscalated) return false;
  if (tier !== "economy") return false;
  return Boolean(lastError) && !isProviderError(lastError);
}

function modelFor(provider, tier) {
  const tiers = MODEL_TIERS[provider];
  if (!tiers) return undefined;
  return (tiers[tier] || tiers.standard)();
}

const PROVIDER_FACTORIES = {
  openai: (tier) => new OpenAIAgentsRuntime(modelFor("openai", tier)),
  claude: (tier) => new ClaudeRuntime(modelFor("claude", tier)),
};

// Which provider a given stage prefers. `run.runtimes` is an optional per-stage map
// ({ research: "openai", copy: "claude", ... }) — set it and that stage runs on that
// model; leave it out and every stage falls back to the run's single `runtime`, which is
// what every run created before per-stage assignment existed does. There is deliberately
// no opinionated built-in map: both providers can do every stage (both have web search
// for Research and reference-search), so picking one per stage is a taste call for the
// team to make per brand, not something to hard-code here on a guess.
function providerForStage(run, stage) {
  const perStage = run.runtimes && stage ? run.runtimes[stage] : null;
  const chosen = perStage || run.runtime;
  return PROVIDER_FACTORIES[chosen] ? chosen : "openai";
}

// `tier` defaults to whatever the stage is configured for, and is passed explicitly when
// executeStage escalates a cheap stage to the standard tier after a failed attempt.
function createRuntime(run, stage, tier) {
  // Fixture runs never fail over: tests need one deterministic source of output, and the
  // whole point of the fixture runtime is that it can't fail for provider reasons anyway.
  if (run.runtime === "fixture") return new FixtureRuntime(run.fixtureDir);
  const resolvedTier = tier || tierForStage(stage);
  const primary = providerForStage(run, stage);
  const order = [primary, ...Object.keys(PROVIDER_FACTORIES).filter((name) => name !== primary)];
  const runtime = new FailoverRuntime(order.map((name) => ({ name, create: () => PROVIDER_FACTORIES[name](resolvedTier) })));
  runtime.tier = resolvedTier;
  return runtime;
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

// Small object helpers used by the section-scoped asset refine flow (see
// ASSET_STAGE_CONFIG.copy.sections, proposeAssetCandidate and acceptAssetCandidate).
function omit(obj, keys) {
  const result = {};
  for (const key of Object.keys(obj || {})) if (!keys.includes(key)) result[key] = obj[key];
  return result;
}
function pick(obj, keys) {
  const result = {};
  for (const key of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, key)) result[key] = obj[key];
  return result;
}

// Shared by both stage runners — identical shape to the original executeStage(), just
// backed by Firebase instead of a local checkpoint file.
async function executeStage(runId, run, def) {
  const startedAt = Date.now();
  let runtime = createRuntime(run, def.stage);
  const instructions = def.fixedInstructions || loadPrompt(def.promptFile);
  let repairIssues = [];
  let previousOutput = null;
  let lastError = null;

  await fbUpdate(`strategy_runs/${runId}`, { status: def.runningStatus, coordinator: { name: "BB Loona", currentStage: def.stage, specialist: def.agentName, status: "working" }, updatedAt: new Date().toISOString() });

  const agent = stageAgent(def.stage);
  let escalated = false;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    // A cheap model that can't satisfy the schema gets exactly one go. Failover doesn't
    // help here — a validation failure isn't a provider error (see runtime-failover.js), so
    // without this the economy tier would burn every repair attempt and fail the stage
    // outright. Escalating on the first repair means the saving is real when the cheap
    // model can do the job, and costs one wasted call when it can't.
    // See shouldEscalateTier() for exactly when, and why not on a provider outage.
    if (shouldEscalateTier({ tier: runtime.tier, attempt, alreadyEscalated: escalated, lastError })) {
      escalated = true;
      runtime = createRuntime(run, def.stage, "standard");
      console.warn(`[${def.stage}] the economy model couldn't produce a valid result — escalating to the standard model for the repair.`);
      await logActivity(runId, "system", `${def.stage}.model_escalated`, "The economy model's first attempt didn't validate — retried on the standard model.");
    }
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
          // Which provider actually produced this checkpoint — not necessarily the one the
          // run asked for, since FailoverRuntime may have moved on after an outage. Worth
          // recording: it's the only way to tell after the fact whether a month's work came
          // from the model the team picked.
          servedBy: runtime.servedBy || null,
          // Which price tier actually produced it, and whether a cheap stage had to be
          // escalated — the only way to tell later whether the saving is real or whether
          // this stage is paying for two calls every month and should go back to standard.
          modelTier: runtime.tier || null,
          escalated,
        });
        await setStageStatus(runId, def.stage, { status: "needs_review", detail: "Validated. Awaiting review.", checkpoint: finalOutput, error: null });
        await fbUpdate(`strategy_runs/${runId}`, { status: def.reviewStatus, coordinator: { name: "BB Loona", currentStage: def.stage, specialist: def.agentName, status: "awaiting_human_review" }, updatedAt: new Date().toISOString() });
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
  await fbUpdate(`strategy_runs/${runId}`, { status: "failed", coordinator: { name: "BB Loona", currentStage: def.stage, specialist: def.agentName, status: "blocked" }, updatedAt: new Date().toISOString() });
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
    agentName: "👨🏻‍✈️ Columbus — Research",
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
  // deliverablesOverride (set at run-start time, from the new-run intake wizard's
  // deliverables screen) is a per-run-only override of the brand's own stored deliverable
  // counts — never written back to the brand config, and only applied to what the
  // Strategy stage's prompt sees and what its output is validated against.
  const effectiveConfig = run.deliverablesOverride
    ? { ...config, deliverables: { ...config.deliverables, ...run.deliverablesOverride } }
    : config;
  const [monthInput, learnings, brandLibrary] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config),
  ]);
  const common = {
    brandConfig: effectiveConfig,
    monthInput,
    learnings,
    brandLibrary,
    sourceContext: run.sourceContext || [],
    currentDate: new Date().toISOString(),
  };
  return executeStage(runId, run, {
    stage: "strategy",
    agentName: "🧕🏻 Dora — Strategy",
    promptFile: "02-strategy.md",
    schema: StrategySchema,
    toolProfile: "none",
    input: Object.assign({}, common, { research: buildStrategyResearchBrief(research) }),
    validate: (output) => validateStrategy(output, effectiveConfig, research, learnings, run.month),
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
    agentName: "👩‍🎨 Matilda — Copy",
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
    agentName: "👩🏼‍🎤 Barbie — Creative Direction",
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
    agentName: "👷🏾 Bob — Deck Builder",
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
// Candidates are staged under stages/<stage>/candidates/<assetId> rather than written
// straight into the checkpoint — "refine"/"similar" want a human to see the replacement
// before it's committed (see acceptAssetCandidate), while each stage's "auto-accept" type
// (strategy's "discard", copy's "replace") skips straight to committing (see replaceAsset)
// since there's nothing left to review: the old content is already gone.
//
// Strategy and Copy both refine "one asset out of the whole batch" the same way — propose
// a replacement, validate the WHOLE array with it swapped in (same validator the full-stage
// generation uses, so there's never a second, drifting definition of "valid"), let a human
// review it (or auto-accept for the "kill it, no review" request types). Everything that
// differs between the two stages lives in this one table instead of two parallel copies of
// the function bodies below.
const ASSET_STAGE_CONFIG = {
  strategy: {
    label: "Strategy",
    schema: StrategyAssetSchema,
    promptFile: "06-concept-refine.md",
    autoAcceptType: "discard", // no review step — kill it and commit the replacement directly
    // The model isn't choosing a new slot, only new content for this one — force the
    // structural fields back to the original regardless of what it returned, the same way
    // deck-builder's enrich() never trusts the model with fields it can't know.
    lockedFields: (target) => ({
      assetId: target.assetId, sequence: target.sequence, format: target.format,
      portfolioId: target.portfolioId, skuIds: target.skuIds,
    }),
    loadContext: async (run) => ({ research: run.stages.research && run.stages.research.checkpoint }),
    callValidate: (swapped, config, context, learnings, month) => validateStrategy(swapped, config, context.research, learnings, month),
    describeChange: (oldAsset, newAsset) =>
      `Replaced "${oldAsset.conceptName}" (${oldAsset.hook}) with "${newAsset.conceptName}" (${newAsset.hook}).`,
    // See checkNoteObedience in validation.js — the plain text a refine's notes are
    // checked against.
    noteText: (candidate) => [candidate.conceptName, candidate.concept, candidate.hook, candidate.tension].filter(Boolean).join(" \n "),
    // A short line representing this candidate in the refine chat thread (see the
    // "history" comment on proposeAssetCandidate below) — just enough for a reviewer to
    // recognize which round of the conversation produced what, without repeating the full
    // concept card that's already shown above the chat.
    summarize: (candidate) => `${candidate.conceptName} — "${candidate.hook}"`,
  },
  copy: {
    label: "Copy",
    schema: CopyAssetSchema,
    promptFile: "07-copy-refine.md",
    autoAcceptType: "replace", // mirrors strategy's "discard" — kill this asset's copy and commit fresh copy directly
    // The hook is inherited from the approved strategy concept — a copy refine/replace
    // rewrites the SUPPORTING copy (on-creative, script, captions, claims), never the hook
    // or the asset's identity fields, so those get forced back too.
    lockedFields: (target) => ({
      assetId: target.assetId, format: target.format, portfolioId: target.portfolioId,
      portfolioName: target.portfolioName, skuIds: target.skuIds, skuNames: target.skuNames,
      hook: target.hook,
    }),
    loadContext: async (run) => ({ strategy: run.stages.strategy && run.stages.strategy.checkpoint }),
    callValidate: (swapped, config, context, learnings, month) => validateCopy(swapped, config, context.strategy, month),
    describeChange: (oldAsset, newAsset) =>
      `Refreshed the copy for ${oldAsset.assetId} (hook: "${oldAsset.hook}").`,
    noteText: (candidate) => allCopyText(candidate),
    summarize: (candidate) => candidate.captions?.[0]?.copy || candidate.hook,
    // Captions and script can each be refined/locked completely independently (see
    // proposeAssetCandidate's `section` param and CopyReview.tsx) — every field NOT listed
    // here for the section being edited is force-restored from the current asset
    // regardless of what the model returned, the same hard-enforcement lockedFields
    // already does for identity fields. `fields` includes claimAudit on both since either
    // section's rewrite can legitimately change the claim assessment for the asset as a
    // whole.
    sections: {
      captions: {
        label: "Captions",
        fields: ["captions", "claimAudit"],
        noteText: (candidate) => (candidate.captions || []).map((cap) => cap.copy).join(" \n "),
        summarize: (candidate) => candidate.captions?.[0]?.copy || "Captions updated.",
        describeChange: (oldAsset) => `Refreshed the captions for ${oldAsset.assetId}.`,
      },
      script: {
        label: "Script",
        fields: ["script", "claimAudit"],
        noteText: (candidate) => (candidate.script?.scenes || []).map((scene) => scene.voiceover).join(" \n "),
        summarize: (candidate) => candidate.script?.scenes?.[0]?.voiceover || "Script updated.",
        describeChange: (oldAsset) => `Refreshed the script for ${oldAsset.assetId}.`,
      },
    },
  },
};

async function proposeAssetCandidate(runId, stage, assetId, requestType, notes, focus, section) {
  const cfg = ASSET_STAGE_CONFIG[stage];
  if (!cfg) throw new Error(`Asset refinement isn't supported for stage "${stage}".`);
  const sectionCfg = section ? cfg.sections && cfg.sections[section] : null;
  if (section && !sectionCfg) throw new Error(`"${section}" isn't a refinable section of ${cfg.label}.`);
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const targetStage = run.stages && run.stages[stage];
  const checkpoint = targetStage && targetStage.checkpoint;
  if (!checkpoint) throw new Error(`Run ${runId} has no ${stage} checkpoint yet.`);
  if (!["needs_review", "changes_requested"].includes(targetStage.status)) {
    throw new Error(`${cfg.label} is ${targetStage.status}; assets can only be refined while it's awaiting review.`);
  }
  const targetIndex = checkpoint.assets.findIndex((asset) => asset.assetId === assetId);
  if (targetIndex === -1) throw new Error(`Asset ${assetId} not found in this run's ${stage}.`);
  const targetAsset = checkpoint.assets[targetIndex];

  // A section-scoped request (captions vs script) gets its own Firebase key, so the two
  // run as fully independent threads — refining captions and refining the script at the
  // same time never fight over the same "running" candidate or clobber each other's ready
  // result. See ASSET_STAGE_CONFIG.copy.sections and CopyReview.tsx.
  const candidateKey = section ? `${assetId}::${section}` : assetId;
  const candidatePath = `strategy_runs/${runId}/stages/${stage}/candidates/${candidateKey}`;
  const existingCandidate = await fbGet(candidatePath);
  // "refine" is the one request type meant to be a running conversation — sending a second
  // refine while a "ready" candidate is already sitting there builds on THAT candidate (so
  // "make it warmer" then "now add a CTA" compounds onto the same concept), instead of
  // restarting from the last-approved checkpoint every time and silently losing whatever
  // the first round changed. "similar"/"discard"/"replace" always restart fresh from the
  // checkpoint — they're a deliberately clean alternative, not a continuation of whatever's
  // currently on the table.
  const chaining = requestType === "refine" && existingCandidate && existingCandidate.status === "ready" && existingCandidate.candidate;
  const baseAsset = chaining ? existingCandidate.candidate : targetAsset;
  // The running chat thread for this candidate (see ConceptChatPanel.tsx) — a user turn is
  // appended immediately below; the matching assistant turn (cfg.summarize's short line for
  // whatever this round produced) is appended once generation actually succeeds, further
  // down. Starting fresh (not chaining) means starting a new thread, same as starting a new
  // candidate.
  const history = (chaining && Array.isArray(existingCandidate.history)) ? existingCandidate.history.slice() : [];
  history.push({ role: "user", notes: notes || null, focus: focus || null, requestType, at: new Date().toISOString() });

  const config = await loadBrandConfig(run.brandId);
  const [monthInput, learnings, brandLibrary, context] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config),
    cfg.loadContext(run),
  ]);
  const runtime = createRuntime(run, stage);
  const instructions = loadPrompt(cfg.promptFile);
  const input = Object.assign({
    brandConfig: config,
    monthInput,
    learnings,
    brandLibrary,
    currentAssetPlan: checkpoint.assets,
    targetAsset: baseAsset,
    // focus: an optional pointer at the specific part of targetAsset the reviewer means
    // (e.g. "Caption B", "Script") — see strategy-concept-propose.js's own header comment.
    request: { type: requestType, notes: notes || null, focus: focus || null },
  }, context);

  // Clicking Refine/Replace on an already-locked asset (or section) means it's back in
  // play — clear the lock now (at the moment the request is actually sent) rather than
  // waiting for the candidate to be accepted, so the "N locked" count in the UI reflects
  // reality the instant a person starts changing something, not a few seconds later.
  const lockKey = candidateKey;
  const agent = stageAgent(stage);
  await Promise.all([
    fbSet(`strategy_runs/${runId}/stages/${stage}/locks/${lockKey}`, null),
    fbSet(candidatePath, {
      status: "running", requestType, notes: notes || null, focus: focus || null, section: section || null, history, updatedAt: new Date().toISOString(),
      detail: `${agent.emoji} ${agent.name} is sketching a replacement.`,
    }),
  ]);

  let repairIssues = [];
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    try {
      const raw = await runtime.runStage({
        // Suffixed with the request type — the fixture runtime maps `stage` straight to a
        // `<stage>.json` file (see runtime-fixture.js), so refine/similar/discard/replace
        // each get their own offline fixture instead of colliding on one shared one; the
        // real runtime just sees this as the task label sent to the model, equally
        // reasonable.
        stage: `${stage}-asset-${requestType}`,
        agentName: `${agent.emoji} ${agent.name} — ${cfg.label} Refinement`,
        instructions,
        input,
        outputSchema: cfg.schema,
        toolProfile: "none",
        repairIssues,
      });
      const parsed = cfg.schema.parse(raw);
      // Sectioned requests get a much stronger lock than the identity-only one below: every
      // field EXCEPT the section's own (sectionCfg.fields) is forced back to baseAsset,
      // regardless of what the model returned — hard enforcement, not just prompt
      // compliance, that a captions-scoped refine can't silently touch the script and
      // vice versa.
      const forcedFields = sectionCfg
        ? omit(baseAsset, sectionCfg.fields)
        : cfg.lockedFields(baseAsset);
      const candidate = Object.assign({}, parsed, forcedFields);
      const swappedAssets = checkpoint.assets.map((asset, i) => (i === targetIndex ? candidate : asset));
      const noteText = sectionCfg ? sectionCfg.noteText(candidate) : cfg.noteText(candidate);
      const issues = cfg.callValidate(Object.assign({}, checkpoint, { assets: swappedAssets }), config, context, learnings, run.month)
        .concat(checkNoteObedience(requestType, notes, noteText));
      if (issues.length === 0) {
        const summary = sectionCfg ? sectionCfg.summarize(candidate) : cfg.summarize(candidate);
        const readyHistory = history.concat([{ role: "assistant", summary, at: new Date().toISOString() }]);
        await fbSet(candidatePath, { status: "ready", requestType, notes: notes || null, focus: focus || null, section: section || null, history: readyHistory, candidate, updatedAt: new Date().toISOString() });
        return candidate;
      }
      repairIssues = issues;
      lastError = new StageValidationError(`${stage}-asset-${requestType}`, issues);
    } catch (error) {
      lastError = error;
      repairIssues = [`Schema or runtime failure: ${error && error.message ? error.message : String(error)}`];
    }
  }
  const message = lastError && lastError.message ? lastError.message : String(lastError);
  await fbSet(candidatePath, { status: "failed", requestType, notes: notes || null, focus: focus || null, section: section || null, history, detail: message, updatedAt: new Date().toISOString() });
  throw lastError;
}

// Commits a "ready" candidate into the actual checkpoint. Re-validates the WHOLE resulting
// batch (not just the one asset) as a safety net in case anything changed between proposing
// and accepting, records a stage-version snapshot before and after the swap (matching
// strategy-stage-approve.js's own versioning), and folds the supersession into the brand's
// learnings so future months don't repeat the killed concept/copy.
async function acceptAssetCandidate(runId, stage, assetId, actor, section) {
  const cfg = ASSET_STAGE_CONFIG[stage];
  if (!cfg) throw new Error(`Asset refinement isn't supported for stage "${stage}".`);
  const sectionCfg = section ? cfg.sections && cfg.sections[section] : null;
  if (section && !sectionCfg) throw new Error(`"${section}" isn't a refinable section of ${cfg.label}.`);
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const checkpoint = run.stages && run.stages[stage] && run.stages[stage].checkpoint;
  if (!checkpoint) throw new Error(`Run ${runId} has no ${stage} checkpoint yet.`);
  const candidateKey = section ? `${assetId}::${section}` : assetId;
  const candidatePath = `strategy_runs/${runId}/stages/${stage}/candidates/${candidateKey}`;
  const candidateDoc = await fbGet(candidatePath);
  if (!candidateDoc || candidateDoc.status !== "ready" || !candidateDoc.candidate) {
    throw new Error(`No ready candidate for ${assetId}${section ? ` (${section})` : ""}.`);
  }
  const targetIndex = checkpoint.assets.findIndex((asset) => asset.assetId === assetId);
  if (targetIndex === -1) throw new Error(`Asset ${assetId} not found in this run's ${stage}.`);
  const oldAsset = checkpoint.assets[targetIndex];
  // A sectioned candidate only ever overlays its OWN fields (captions, or script) onto
  // whatever the checkpoint asset looks like RIGHT NOW — not the candidate's own baseAsset
  // snapshot for the untouched parts. Captions and script now run as fully independent
  // threads, so if the other section was accepted in between this candidate being
  // generated and now, using the candidate's stale copy of it here would silently revert
  // that other, unrelated change.
  const newAsset = sectionCfg ? Object.assign({}, oldAsset, pick(candidateDoc.candidate, sectionCfg.fields)) : candidateDoc.candidate;
  const newAssets = checkpoint.assets.map((asset, i) => (i === targetIndex ? newAsset : asset));
  const newCheckpoint = Object.assign({}, checkpoint, { assets: newAssets });

  const [config, learnings, context] = await Promise.all([loadBrandConfig(run.brandId), loadLearnings(run.brandId), cfg.loadContext(run)]);
  const issues = cfg.callValidate(newCheckpoint, config, context, learnings, run.month);
  if (issues.length) throw new StageValidationError(`${stage}-asset-${candidateDoc.requestType}`, issues);

  await saveStageVersion(runId, stage, checkpoint, `asset_${candidateDoc.requestType}_before`, actor || "system");
  await fbSet(`strategy_runs/${runId}/stages/${stage}/checkpoint`, newCheckpoint);
  await saveStageVersion(runId, stage, newCheckpoint, `asset_${candidateDoc.requestType}`, actor || "system");
  await fbSet(candidatePath, null);
  await saveFeedbackEvent(
    run,
    stage,
    `asset_${candidateDoc.requestType}`,
    (sectionCfg ? sectionCfg.describeChange(oldAsset, newAsset) : cfg.describeChange(oldAsset, newAsset)) + (candidateDoc.notes ? ` Notes: ${candidateDoc.notes}` : ""),
    actor || "system",
  );
  await logActivity(runId, actor || "system", `${stage}.asset_${candidateDoc.requestType}`, oldAsset.assetId);
  return newCheckpoint;
}

// The stage's "auto-accept" request type (strategy's "discard", copy's "replace") has no
// review step — the old content is already being thrown out, so propose + accept happen
// together as one action. If generation fails after every repair attempt, the original
// asset is left in place (never silently removed) and the candidate sits in "failed" with
// the real error, same as any other stage's failed+Retry state — re-running this same
// function is the retry.
async function replaceAsset(runId, stage, assetId, notes, actor) {
  const cfg = ASSET_STAGE_CONFIG[stage];
  if (!cfg) throw new Error(`Asset refinement isn't supported for stage "${stage}".`);
  await proposeAssetCandidate(runId, stage, assetId, cfg.autoAcceptType, notes);
  return acceptAssetCandidate(runId, stage, assetId, actor);
}

const REOPEN_STAGE_ORDER = ["research", "strategy", "copy", "creative-direction", "deck-builder"];

// "Going back" to an already-approved stage — a genuinely destructive action, not a soft
// undo: every stage AFTER the one being reopened gets wiped back to "locked" (checkpoint,
// candidates and locks all cleared), because their content was built against what the
// reopened stage used to say and can no longer be trusted once it might change again. The
// reopened stage itself keeps its own checkpoint (nothing regenerated) but goes back to
// "needs_review" with a clean candidates/locks slate, ready for another review round —
// Refine/Replace/Suggest-similar, Send back with notes, or Approve again to re-run
// everything downstream exactly like the first time through.
//
// Nothing is silently lost: every stage that gets wiped is snapshotted via
// saveStageVersion() first, same as every other checkpoint mutation in this file, so the
// full history is still there in strategy_stage_versions if anyone needs to see what a
// wiped stage used to contain.
async function reopenStage(runId, stage, actor, notes) {
  const stageIndex = REOPEN_STAGE_ORDER.indexOf(stage);
  if (stageIndex === -1) throw new Error(`"${stage}" isn't a stage that can be reopened.`);
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const targetState = run.stages && run.stages[stage];
  if (!targetState || targetState.status !== "approved") {
    throw new Error(`${stage} is ${targetState ? targetState.status : "unknown"}; only an already-approved stage can be reopened.`);
  }

  const now = new Date().toISOString();
  const downstream = REOPEN_STAGE_ORDER.slice(stageIndex + 1);
  for (const laterStage of downstream) {
    const laterState = run.stages && run.stages[laterStage];
    if (laterState && laterState.checkpoint) {
      await saveStageVersion(runId, laterStage, laterState.checkpoint, `reopened_${stage}_cascade`, actor || "system");
    }
    await fbSet(`strategy_runs/${runId}/stages/${laterStage}`, { status: "locked", updatedAt: now });
  }

  await saveStageVersion(runId, stage, targetState.checkpoint, "reopened_before", actor || "system");
  await fbSet(`strategy_runs/${runId}/stages/${stage}`, { status: "needs_review", checkpoint: targetState.checkpoint, updatedAt: now });
  await fbUpdate(`strategy_runs/${runId}`, { status: `${stage}_needs_review`, updatedAt: now });
  if (notes) await saveFeedbackEvent(run, stage, "reopened", notes, actor || "system");
  await logActivity(runId, actor || "system", `${stage}.reopened`, notes || (downstream.length ? `Reset ${downstream.join(", ")} back to locked.` : null));
  return { stage, resetDownstream: downstream };
}

// Stages whose checkpoint holds a flat, lockable `.assets` array — deck-builder's own
// `.pages` array is trimmed too (see applyLockFilterOnApprove below), but deck-builder is
// never itself the stage BEING approved into a next stage (there is none), so it never
// determines a surviving-ids set of its own.
const LOCKABLE_STAGES = ["strategy", "copy", "creative-direction"];

// Which assetIds are "locked" for the given stage. Copy's captions and script are locked
// independently (see ASSET_STAGE_CONFIG.copy.sections / CopyReview.tsx) — an asset only
// counts as locked here once BOTH sections are; every other lockable stage is a single
// flat lock per asset.
function lockedAssetIds(stage, locksMap, allAssetIds) {
  const locks = locksMap || {};
  if (stage === "copy") {
    return allAssetIds.filter((id) => !!locks[`${id}::captions`] && !!locks[`${id}::script`]);
  }
  return allAssetIds.filter((id) => !!locks[id]);
}

// Drops entries for any assetId not in `survivors` — keys may be a plain assetId or a
// compound `<assetId>::<section>` one (copy's locks/candidates).
function filterMapByAssetId(map, survivors) {
  if (!map) return map;
  const result = {};
  for (const key of Object.keys(map)) {
    if (survivors.has(key.split("::")[0])) result[key] = map[key];
  }
  return result;
}

// "Only the stuff you lock should go to the next stage": approving a stage with ANYTHING
// locked carries forward only the locked subset — every other concept is cut from the run
// entirely. Approving with NOTHING locked advances everything unchanged (today's
// behavior — a team that never uses locks sees no difference at all). Applies at every
// handoff with a lockable `.assets` array: Strategy→Copy, Copy→Creative-Direction,
// Creative-Direction→Deck-builder.
//
// Cutting an asset means cutting it from the WHOLE run, not just the stage being approved:
// every downstream validator (validateCopy/validateDirection/validateDeck) checks its own
// asset count against the STRATEGY checkpoint's count specifically, so strategy's own
// `.assets` (and copy's, if creative-direction is what's being approved) gets
// cascade-trimmed to the same surviving set too, keeping every stage's asset list — and
// count — mutually consistent no matter which stage the trim actually happened at.
//
// Pure function (no I/O) — strategy-stage-approve.js is responsible for snapshotting and
// persisting whatever `updatedStages` comes back.
function applyLockFilterOnApprove(run, stage) {
  const stageState = run.stages && run.stages[stage];
  const checkpoint = stageState && stageState.checkpoint;
  const noop = {
    droppedAssetIds: [],
    survivingIds: checkpoint && Array.isArray(checkpoint.assets) ? checkpoint.assets.map((a) => a.assetId) : [],
    totalCount: checkpoint && Array.isArray(checkpoint.assets) ? checkpoint.assets.length : 0,
    updatedStages: {},
  };
  if (!checkpoint || !Array.isArray(checkpoint.assets) || !LOCKABLE_STAGES.includes(stage)) return noop;

  const allIds = checkpoint.assets.map((a) => a.assetId);
  const locked = lockedAssetIds(stage, stageState.locks, allIds);
  if (locked.length === 0) return noop; // opt-in: nothing locked, nothing dropped

  const survivors = new Set(locked);
  const droppedAssetIds = allIds.filter((id) => !survivors.has(id));
  const updatedStages = {};
  for (const s of LOCKABLE_STAGES) {
    const st = run.stages && run.stages[s];
    if (!st || !st.checkpoint || !Array.isArray(st.checkpoint.assets)) continue;
    const keptAssets = st.checkpoint.assets.filter((a) => survivors.has(a.assetId));
    if (keptAssets.length === st.checkpoint.assets.length) continue; // nothing to trim here
    updatedStages[s] = {
      checkpoint: Object.assign({}, st.checkpoint, { assets: keptAssets }),
      locks: filterMapByAssetId(st.locks, survivors),
      candidates: filterMapByAssetId(st.candidates, survivors),
    };
  }
  const deck = run.stages && run.stages["deck-builder"];
  if (deck && deck.checkpoint && Array.isArray(deck.checkpoint.pages)) {
    const keptPages = deck.checkpoint.pages
      .filter((p) => survivors.has(p.assetId))
      .map((p, i) => Object.assign({}, p, { pageNumber: i + 1 }));
    if (keptPages.length !== deck.checkpoint.pages.length) {
      updatedStages["deck-builder"] = { checkpoint: Object.assign({}, deck.checkpoint, { pages: keptPages }) };
    }
  }
  return { droppedAssetIds, survivingIds: locked, totalCount: allIds.length, updatedStages };
}

module.exports = {
  runResearchStage, runStrategyStage, runCopyStage, runDirectionStage, runDeckStage,
  proposeAssetCandidate, acceptAssetCandidate, replaceAsset, reopenStage,
  applyLockFilterOnApprove,
  logActivity, buildStrategyResearchBrief,
  // Exported for tests only — FailoverRuntime builds its providers lazily, so the returned
  // runtime can be inspected for provider ORDER without any key being configured.
  createRuntime, providerForStage, tierForStage, modelFor, shouldEscalateTier,
};

