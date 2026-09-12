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
const { saveStageVersion, saveStageMetrics, saveFeedbackEvent, saveSystemLearningEvent } = require("./observability");
const { reviewStage, verdictToIssues, averageScore } = require("./critic");
const { mergeByScore } = require("./competition");

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
const PROVIDER_NAMES = Object.keys(PROVIDER_FACTORIES);

function otherProvider(name) {
  return PROVIDER_NAMES.find((p) => p !== name) || null;
}

// A single named provider, deliberately WITHOUT FailoverRuntime — used only by the
// competitive stage runner (executeCompetitiveStage, below), where knowing exactly which
// provider produced (or failed to produce) each entry is the whole point. createRuntime()'s
// ordinary failover would blur that: a "claude" slot that silently failed over to openai
// would make the two entries indistinguishable, and worse, could hand the critic step a
// runtime that's actually the SAME model that wrote the thing it's reviewing. If a solo
// runtime can't be constructed (missing key) or fails at call time, that's surfaced as a
// normal rejection — Promise.allSettled in the caller treats it exactly like "this provider
// didn't produce anything this round," the same outcome FailoverRuntime would reach by
// moving on, just without the moving-on.
function soloRuntime(providerName, tier) {
  return {
    name: providerName,
    async runStage(request) {
      const runtime = PROVIDER_FACTORIES[providerName](tier);
      return runtime.runStage(request);
    },
  };
}

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

// The two ways a stage's attempt loop can end, factored out so the competitive path
// (executeCompetitiveStage, below) can share them byte-for-byte with the solo path rather
// than keeping two copies of "how a stage finishes" that could quietly drift apart.
//
// `extraMetrics` lets a caller attach fields the solo path has no concept of (which
// provider's entry won, the critic's scores, whether a slot got swapped) without either
// path needing to know about the other's bookkeeping.
async function finalizeStage(runId, def, { parsed, attempt, escalated, servedBy, tier, startedAt, extraMetrics }) {
  // enrich() adds fields the model has no way to know (e.g. deck page owner/status) AFTER
  // validation passes — never asked of the model itself, so it can't fabricate a
  // plausible-looking owner or status. See contracts.js's DeckPageSchema comment.
  const finalOutput = def.enrich ? def.enrich(parsed) : parsed;
  await saveStageVersion(runId, def.stage, finalOutput, "generated", "system");
  await saveStageMetrics(runId, def.stage, Object.assign(
    {
      durationMs: Date.now() - startedAt,
      attempts: attempt + 1,
      repairs: attempt,
      outcome: "needs_review",
      // Which provider actually produced this checkpoint — not necessarily the one the run
      // asked for, since FailoverRuntime may have moved on after an outage (solo path), or
      // either provider may have won the slot (competitive path). Worth recording: it's the
      // only way to tell after the fact whether a month's work came from the model the team
      // picked.
      servedBy: servedBy || null,
      // Which price tier actually produced it, and whether a cheap stage had to be
      // escalated — the only way to tell later whether the saving is real or whether this
      // stage is paying for two calls every month and should go back to standard.
      modelTier: tier || null,
      escalated,
    },
    extraMetrics || {}
  ));
  await setStageStatus(runId, def.stage, { status: "needs_review", detail: "Validated. Awaiting review.", checkpoint: finalOutput, error: null });
  await fbUpdate(`strategy_runs/${runId}`, { status: def.reviewStatus, coordinator: { name: "BB Loona", currentStage: def.stage, specialist: def.agentName, status: "awaiting_human_review" }, updatedAt: new Date().toISOString() });
  await logActivity(runId, "system", `${def.stage}.completed`, `Passed on attempt ${attempt + 1}.`);
  return finalOutput;
}

async function failStage(runId, def, { run, lastError, attempts, startedAt }) {
  const message = lastError && lastError.message ? lastError.message : String(lastError);
  await saveStageMetrics(runId, def.stage, {
    durationMs: Date.now() - startedAt,
    attempts,
    repairs: attempts - 1,
    outcome: "failed",
  });
  await setStageStatus(runId, def.stage, { status: "failed", detail: message });
  await fbUpdate(`strategy_runs/${runId}`, { status: "failed", coordinator: { name: "BB Loona", currentStage: def.stage, specialist: def.agentName, status: "blocked" }, updatedAt: new Date().toISOString() });
  await logActivity(runId, "system", `${def.stage}.failed`, message);
  // A dead run used to just vanish into "failed" with nothing to show for the attempt — no
  // trace of why once the run itself got retried or archived. This is the one exception to
  // "operational, not content" living outside the brand's actual learnings text: it's kept
  // there anyway (own section — see loadLearnings) purely so a REPEATING failure pattern
  // for this brand becomes visible to a person, not because the writing models should act
  // on it.
  if (run) await saveSystemLearningEvent(run, def.stage, "stage_failed", message);
  throw lastError;
}

// Independent gate review for one already-schema-valid output, by whichever provider did
// NOT write it. Returns { verdict: null, skippedReason } rather than throwing when no
// genuinely different provider is available or reachable — a missing critic degrades the
// stage back to today's self-report-only behaviour, it never blocks the stage outright.
async function reviewWithCritic(stage, output, writerProvider, criticContext, tier) {
  const other = otherProvider(writerProvider);
  if (!other) return { verdict: null, criticProvider: null, skippedReason: "Only one model provider is configured." };
  try {
    const verdict = await reviewStage(soloRuntime(other, tier), stage, output, criticContext || {});
    return { verdict, criticProvider: other, skippedReason: null };
  } catch (error) {
    console.warn(`[${stage}] independent critic review unavailable (asked ${other}): ${error.message || error}`);
    return { verdict: null, criticProvider: other, skippedReason: error.message || String(error) };
  }
}

// Both providers write this stage; an independent critic scores both, and the better
// concept wins each slot. Exists for two reasons at once:
//
// 1. validation.js's concept-gate check (`if (!asset.gate.logoSwapPass || ...)`) reads
//    booleans the WRITING model fills in about its own work — every other check in that
//    file is real, but those four are pure self-report. An independent critic re-derives
//    them without being shown what the writer claimed (see critic.js).
// 2. "Both models write, the best options win" — see competition.js for why a slot is only
//    contested when both sides agree on its shape, so a merge can't silently break the
//    exact per-format counts validateStrategy/validateCopy enforce.
//
// Gate enforcement is hybrid, by design: a critic objection blocks and triggers ONE repair
// round (`criticRepairUsed`). If the critic still objects after that, the stage finishes
// anyway with the objections attached as review notes rather than deadlocking a run over an
// unresolved disagreement between two models — a human sees exactly what was flagged and
// decides, the same way they already decide everything else in this pipeline.
//
// Deliberately NOT used for research, creative-direction or deck-builder: research and
// creative-direction aren't judged against a self-reported gate the way concepts and copy
// are, and deck-builder is assembly of already-approved decisions, not judgement — doubling
// its cost would buy nothing. Fixture runs never reach this function (see executeStage).
//
// A one-line summary of who won a contested round, purely from the already-computed
// `competitionInfo` (see the finalize call below) — no extra state to thread through. This
// is the "which model tends to do better here" signal that used to disappear the moment a
// run finished: recorded via saveSystemLearningEvent so it accumulates in the brand's own
// learnings over many runs, not just this one review screen.
function describeCompetitionOutcome(stage, competitionInfo) {
  if (!competitionInfo || !competitionInfo.contested) return null; // one provider, nothing to compare
  if (competitionInfo.criticUnavailable) {
    return `Only one independent critic was available for ${stage} — ${competitionInfo.servedBy} won by self-report only, not a real comparison.`;
  }
  if (competitionInfo.mergeRejected) {
    return `${competitionInfo.servedBy}'s ${stage} output shipped as-is — a merge with the challenger scored better in places but failed whole-portfolio validation (${(competitionInfo.mergeIssues || []).join("; ")}).`;
  }
  if (typeof competitionInfo.swapsFromChallenger === "number") {
    return competitionInfo.swapsFromChallenger > 0
      ? `${competitionInfo.basedOn}'s version served as the base for ${stage}, with ${competitionInfo.swapsFromChallenger} slot(s) swapped in from the challenger where the critic scored it higher.`
      : `${competitionInfo.basedOn}'s version won every contested ${stage} slot outright — the challenger's version never out-scored it.`;
  }
  return null;
}

async function executeCompetitiveStage(runId, run, def) {
  const startedAt = Date.now();
  const instructions = def.fixedInstructions || loadPrompt(def.promptFile);
  const agent = stageAgent(def.stage);
  const tier = "standard"; // every stage this applies to is judgement, never the cheap tier

  await fbUpdate(`strategy_runs/${runId}`, { status: def.runningStatus, coordinator: { name: "BB Loona", currentStage: def.stage, specialist: def.agentName, status: "working" }, updatedAt: new Date().toISOString() });

  // Each provider keeps its OWN prior output and repair issues across rounds — a fix one
  // model needs may be irrelevant to the other, and feeding a provider someone else's
  // complaint about someone else's output would just confuse it.
  const providerState = {};
  for (const name of PROVIDER_NAMES) providerState[name] = { previousOutput: null, repairIssues: [] };

  let criticRepairUsed = false;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    await setStageStatus(runId, def.stage, {
      status: attempt === 0 ? "running" : "repairing",
      detail: attempt === 0
        ? `${agent.emoji} ${agent.name} is on it — two models are drafting this stage, and the stronger concept in each slot wins.`
        : `${agent.emoji} ${agent.name} is fixing an issue — attempt ${attempt} of ${MAX_REPAIRS}.`,
    });

    // Each provider gets its own request (its own repairIssues/previousOutput), so this
    // can't reuse competition.js's generateBoth() as-is — that assumes one shared request.
    const settled = await Promise.allSettled(PROVIDER_NAMES.map((name) => {
      const state = providerState[name];
      const input = state.previousOutput ? { originalInput: def.input, previousOutput: state.previousOutput } : def.input;
      return soloRuntime(name, tier).runStage({
        stage: def.stage, agentName: def.agentName, instructions, input,
        outputSchema: def.schema, toolProfile: def.toolProfile, repairIssues: state.repairIssues,
      });
    }));

    const usable = [];
    for (let i = 0; i < PROVIDER_NAMES.length; i += 1) {
      const name = PROVIDER_NAMES[i];
      const result = settled[i];
      if (result.status === "rejected") {
        const error = result.reason;
        providerState[name] = { previousOutput: null, repairIssues: [`Schema or runtime failure: ${error && error.message ? error.message : String(error)}`] };
        await fbSet(`strategy_runs/${runId}/attempts/${def.stage}/${attempt + 1}/${name}`, { issues: providerState[name].repairIssues, error: true });
        continue;
      }
      let parsed;
      let issues;
      try {
        parsed = def.schema.parse(result.value);
        issues = def.validate(parsed);
      } catch (error) {
        providerState[name] = { previousOutput: null, repairIssues: [`Schema or runtime failure: ${error && error.message ? error.message : String(error)}`] };
        await fbSet(`strategy_runs/${runId}/attempts/${def.stage}/${attempt + 1}/${name}`, { issues: providerState[name].repairIssues, error: true });
        continue;
      }
      await fbSet(`strategy_runs/${runId}/attempts/${def.stage}/${attempt + 1}/${name}`, { issues, output: parsed });
      if (issues.length) {
        providerState[name] = { previousOutput: parsed, repairIssues: issues };
        lastError = new StageValidationError(def.stage, issues);
        continue;
      }
      providerState[name] = { previousOutput: null, repairIssues: [] };
      usable.push({ provider: name, parsed });
    }

    if (usable.length === 0) {
      // Surface what actually happened to EACH provider, not a generic "neither worked" —
      // that was the failure a human actually saw on strategy-run-start.js's very first
      // real (non-fixture) competitive run: a top-level "Neither model produced a usable
      // result this round." with zero indication of whether it was a repeatable content
      // problem or (as runtime-failover.js's own history shows has happened before) one
      // provider being out of credits — and, without failover on this path, that alone is
      // enough to explain it if the OTHER provider also stumbled that round. Always
      // overwrite with the LATEST round's reasons (not just the first) — a later round is
      // what actually decided the stage's fate.
      const perProviderDetail = PROVIDER_NAMES.map((name) => {
        const issues = providerState[name].repairIssues;
        return `${name}: ${issues.length ? issues.join("; ") : "no result"}`;
      });
      lastError = new StageValidationError(def.stage, perProviderDetail);
      continue;
    }

    let finalParsed;
    let finalVerdict = null;
    let criticSkippedReason = null;
    let competitionInfo;

    if (usable.length === 1) {
      const winner = usable[0];
      finalParsed = winner.parsed;
      const review = await reviewWithCritic(def.stage, finalParsed, winner.provider, def.criticContext, tier);
      finalVerdict = review.verdict;
      criticSkippedReason = review.skippedReason;
      competitionInfo = { servedBy: winner.provider, contested: false, criticProvider: review.criticProvider };
    } else {
      // Both usable, and — because soloRuntime never fails over — always the two genuinely
      // distinct PROVIDER_NAMES. Review each independently, as if it were the sole
      // submission, before comparing: a joint review would anchor on whichever one the
      // critic saw first.
      const [a, b] = usable;
      const reviewA = await reviewWithCritic(def.stage, a.parsed, a.provider, def.criticContext, tier);
      const reviewB = await reviewWithCritic(def.stage, b.parsed, b.provider, def.criticContext, tier);

      if (reviewA.verdict && reviewB.verdict) {
        const avgA = averageScore(reviewA.verdict);
        const avgB = averageScore(reviewB.verdict);
        // An exact tie goes to whichever provider the run/brand is actually configured to
        // prefer for this stage, rather than an arbitrary array-order pick.
        const preferred = providerForStage(run, def.stage);
        const aWins = avgA > avgB || (avgA === avgB && a.provider === preferred);
        const base = aWins ? a : b;
        const baseVerdict = aWins ? reviewA.verdict : reviewB.verdict;
        const challenger = aWins ? b : a;
        const challengerVerdict = aWins ? reviewB.verdict : reviewA.verdict;

        const { merged, swaps } = mergeByScore(base.parsed, challenger.parsed, baseVerdict, challengerVerdict);
        // mergeByScore only swaps same-shape slots, which keeps exact per-format counts
        // intact — but a recombination is still new enough to re-check against every OTHER
        // whole-portfolio rule (research-id references, deliverable totals, pillar spread)
        // that a same-shape swap doesn't touch. Never ship a merge that broke one of those
        // on the strength of an assumption; fall back to the known-valid base instead.
        const mergeIssues = def.validate(merged);
        if (mergeIssues.length) {
          console.warn(`[${def.stage}] merged output failed whole-portfolio validation (${mergeIssues.join(" | ")}) — using ${base.provider}'s own output instead of the merge.`);
          finalParsed = base.parsed;
          finalVerdict = baseVerdict;
          competitionInfo = { servedBy: base.provider, contested: true, mergeRejected: true, mergeIssues };
        } else {
          finalParsed = merged;
          const swappedIds = new Set(swaps.map((s) => s.assetId));
          // The merged output's own verdict is reconstructed rather than re-derived with a
          // third critic call: every surviving asset's content is byte-for-byte whichever
          // side it was already scored as, so that score and those gates still describe it
          // exactly.
          finalVerdict = {
            assets: (merged.assets || []).map((asset) => {
              const source = swappedIds.has(asset.assetId) ? challengerVerdict : baseVerdict;
              return (source.assets || []).find((a2) => a2.assetId === asset.assetId) || null;
            }).filter(Boolean),
            portfolioNotes: [...(baseVerdict.portfolioNotes || []), ...(challengerVerdict.portfolioNotes || [])],
          };
          competitionInfo = { servedBy: `${base.provider}+${challenger.provider}`, contested: true, basedOn: base.provider, swapsFromChallenger: swaps.length, swaps };
        }
      } else {
        // No independent critic available for at least one side — nothing to score or
        // merge with. Fall back entirely to the pre-critic mechanism: whichever entry the
        // model itself claims passed more of its own gates wins, exactly like every run
        // before this feature existed. No critic-driven repair round happens in this
        // branch — there's no genuinely independent verdict to trust.
        const selfGateFailures = (entry) => (entry.parsed.assets || []).filter((asset) => (
          asset.gate && (!asset.gate.logoSwapPass || !asset.gate.killListPass || !asset.gate.tensionPass || !asset.gate.overheardPass)
        )).length;
        const winner = selfGateFailures(a) <= selfGateFailures(b) ? a : b;
        finalParsed = winner.parsed;
        finalVerdict = null;
        criticSkippedReason = reviewA.skippedReason || reviewB.skippedReason || "Independent critic unavailable.";
        competitionInfo = { servedBy: winner.provider, contested: true, criticUnavailable: true };
      }
    }

    const gateIssues = finalVerdict ? verdictToIssues(finalVerdict) : [];

    if (gateIssues.length && !criticRepairUsed) {
      // Hybrid enforcement, blocking half: one repair round. Feed the SAME issues to
      // whichever provider(s) validated cleanly this round (their own repairIssues are
      // empty, so they'd otherwise just repeat themselves) — a provider that already had
      // real schema/business issues keeps fixing those first; a quality note comes second.
      criticRepairUsed = true;
      for (const name of PROVIDER_NAMES) {
        if (!providerState[name].repairIssues.length) {
          providerState[name] = { previousOutput: finalParsed, repairIssues: gateIssues };
        }
      }
      lastError = new StageValidationError(def.stage, gateIssues);
      await fbSet(`strategy_runs/${runId}/attempts/${def.stage}/${attempt + 1}/critic`, { issues: gateIssues });
      continue;
    }

    // Either clean, or the critic already used its one blocking round and still objects —
    // hybrid's advisory half: finish anyway, with whatever's left attached as review notes
    // rather than deadlocking the stage over two models' disagreement.
    //
    // Neither of these is gated on a human typing anything — see saveSystemLearningEvent's
    // own comment on why that used to mean most runs taught the brand's learnings nothing
    // at all, good or bad.
    if (gateIssues.length) {
      await saveSystemLearningEvent(run, def.stage, "critic_objection", gateIssues.join(" | "));
    }
    const competitionOutcome = describeCompetitionOutcome(def.stage, competitionInfo);
    if (competitionOutcome) {
      await saveSystemLearningEvent(run, def.stage, "competition_outcome", competitionOutcome);
    }
    return finalizeStage(runId, def, {
      parsed: finalParsed, attempt, escalated: false, startedAt,
      servedBy: competitionInfo.servedBy, tier,
      extraMetrics: {
        competition: competitionInfo,
        // The full per-asset verdict, not just the score — a review screen showing "6/10"
        // with no reasoning tells a human nothing they can act on. This is exactly what the
        // critic itself produced (see AssetVerdictSchema in critic.js), stored verbatim so
        // the UI can show WHY, not just a number.
        criticVerdicts: finalVerdict ? finalVerdict.assets : null,
        criticPortfolioNotes: finalVerdict ? finalVerdict.portfolioNotes : [],
        // Non-null only when the critic still objected but the hybrid gate let it through
        // anyway — the trace of "this shipped over an unresolved objection," for review.
        gateWarnings: gateIssues.length ? gateIssues : null,
        criticSkippedReason,
      },
    });
  }

  return failStage(runId, def, { run, lastError, attempts: MAX_REPAIRS + 1, startedAt });
}

// Shared by both stage runners — identical shape to the original executeStage(), just
// backed by Firebase instead of a local checkpoint file.
async function executeStage(runId, run, def) {
  // Fixture runs stay on the solo path even for a def.compete stage: tests depend on one
  // deterministic source of output, and there's nothing to compete against a fixed JSON
  // file with. Every existing fixture-based test can stay exactly as it is.
  if (def.compete && run.runtime !== "fixture") return executeCompetitiveStage(runId, run, def);

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
        return finalizeStage(runId, def, {
          parsed, attempt, escalated, startedAt,
          servedBy: runtime.servedBy, tier: runtime.tier,
        });
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

  return failStage(runId, def, { run, lastError, attempts: MAX_REPAIRS + 1, startedAt });
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
    // Both models draft the month's concepts, an independent critic re-applies the four
    // concept gates instead of trusting the writer's own self-report, and the stronger
    // concept in each slot wins — see executeCompetitiveStage's own header comment.
    compete: true,
    criticContext: { brandConfig: effectiveConfig, research, learnings },
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
    // Same reasoning as the strategy stage above: both models draft the copy, an
    // independent critic re-applies the four gates to the actual words on the page, and
    // the stronger version of each asset's copy wins.
    compete: true,
    // Copy's own input doesn't need the research checkpoint (it works from the strategy
    // handoff), but the critic can still usefully cross-check a caption against exhausted
    // territory — it's already sitting on `run` from earlier in the pipeline, so this costs
    // nothing extra to pass through.
    criticContext: { brandConfig: config, research: run.stages && run.stages.research && run.stages.research.checkpoint, learnings },
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

// One independent attempt at a fresh variation, from a single named provider — its own
// repair loop, its own failure, entirely unrelated to any other slot's outcome. Shares the
// same generate → parse → force-lock-fields → validate shape proposeAssetCandidate uses
// for a single candidate; a variation is graded no differently from an ordinary refine
// result, just never shown as the only option.
// `runtime`/`providerLabel` are supplied by the caller rather than looked up here, so a
// fixture run can hand this the SAME FixtureRuntime createRuntime() would (see
// proposeAssetVariations below) instead of ever reaching a real provider — the same
// fixture-never-reaches-a-real-model guarantee executeStage's own fixture check gives the
// main pipeline.
async function generateOneVariation(providerLabel, runtime, stage, cfg, sectionCfg, baseAsset, checkpoint, targetIndex, input, config, context, learnings, run) {
  let repairIssues = [];
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    try {
      const raw = await runtime.runStage({
        stage: `${stage}-asset-variations`,
        agentName: `${stageAgent(stage).emoji} ${stageAgent(stage).name} — ${cfg.label} Variation`,
        instructions: loadPrompt(cfg.promptFile),
        input,
        outputSchema: cfg.schema,
        toolProfile: "none",
        repairIssues,
      });
      const parsed = cfg.schema.parse(raw);
      const forcedFields = sectionCfg ? omit(baseAsset, sectionCfg.fields) : cfg.lockedFields(baseAsset);
      const candidate = Object.assign({}, parsed, forcedFields);
      const swappedAssets = checkpoint.assets.map((asset, i) => (i === targetIndex ? candidate : asset));
      const issues = cfg.callValidate(Object.assign({}, checkpoint, { assets: swappedAssets }), config, context, learnings, run.month);
      if (issues.length === 0) return { provider: providerLabel, candidate };
      repairIssues = issues;
      lastError = new StageValidationError(`${stage}-asset-variations`, issues);
    } catch (error) {
      lastError = error;
      repairIssues = [`Schema or runtime failure: ${error && error.message ? error.message : String(error)}`];
    }
  }
  console.warn(`[${stage}] a ${providerLabel} variation never validated: ${lastError && lastError.message}`);
  return null;
}

// Two variations from each configured provider (four total) instead of one from whichever
// model the run happens to be pointed at — "let both models work and come up with the best
// options," applied to the per-asset refine flow the same way executeCompetitiveStage
// applies it to a whole stage. Always fresh from the checkpoint (like "similar"), never a
// continuation of an existing chat thread — asking for four fresh takes isn't "keep
// building on this one," it's "show me what else is possible."
//
// A provider that's down or unconfigured simply contributes zero variations rather than
// failing the whole request — soloRuntime's rejection is caught per-slot inside
// generateOneVariation, so this degrades to "2 variations instead of 4," and only throws
// if EVERY slot from BOTH providers failed, leaving nothing to show.
async function proposeAssetVariations(runId, stage, assetId, focus, section) {
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

  const candidateKey = section ? `${assetId}::${section}` : assetId;
  const candidatePath = `strategy_runs/${runId}/stages/${stage}/candidates/${candidateKey}`;
  const history = [{ role: "user", notes: null, focus: focus || null, requestType: "variations", at: new Date().toISOString() }];

  const config = await loadBrandConfig(run.brandId);
  const [monthInput, learnings, brandLibrary, context] = await Promise.all([
    loadMonthInput(run.brandId, run.month),
    loadLearnings(run.brandId),
    loadBrandLibrary(config),
    cfg.loadContext(run),
  ]);
  const input = Object.assign({
    brandConfig: config, monthInput, learnings, brandLibrary,
    currentAssetPlan: checkpoint.assets, targetAsset,
    request: { type: "variations", notes: null, focus: focus || null },
  }, context);

  const lockKey = candidateKey;
  const agent = stageAgent(stage);
  await Promise.all([
    fbSet(`strategy_runs/${runId}/stages/${stage}/locks/${lockKey}`, null),
    fbSet(candidatePath, {
      status: "running", requestType: "variations", notes: null, focus: focus || null, section: section || null, history, updatedAt: new Date().toISOString(),
      detail: `${agent.emoji} ${agent.name} is sketching four options — two per model.`,
    }),
  ]);

  // Fixture runs need one deterministic source of output, same as everywhere else in this
  // pipeline — a single fixture-backed attempt stands in for the whole 2-per-provider fan
  // out below, so tests never reach a real provider through this path.
  const jobs = run.runtime === "fixture"
    ? [generateOneVariation("fixture", new FixtureRuntime(run.fixtureDir), stage, cfg, sectionCfg, targetAsset, checkpoint, targetIndex, input, config, context, learnings, run)]
    : PROVIDER_NAMES.flatMap((name) => [
        generateOneVariation(name, soloRuntime(name, "standard"), stage, cfg, sectionCfg, targetAsset, checkpoint, targetIndex, input, config, context, learnings, run),
        generateOneVariation(name, soloRuntime(name, "standard"), stage, cfg, sectionCfg, targetAsset, checkpoint, targetIndex, input, config, context, learnings, run),
      ]);
  const settled = await Promise.allSettled(jobs);
  const variations = settled
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);

  if (variations.length === 0) {
    const message = "Neither model produced a usable variation.";
    await fbSet(candidatePath, { status: "failed", requestType: "variations", notes: null, focus: focus || null, section: section || null, history, detail: message, updatedAt: new Date().toISOString() });
    throw new Error(message);
  }

  const byProvider = variations.reduce((acc, v) => { acc[v.provider] = (acc[v.provider] || 0) + 1; return acc; }, {});
  const providerLabel = (p) => (p === "openai" ? "ChatGPT" : p === "claude" ? "Claude" : p);
  const summary = `${variations.length} variation${variations.length === 1 ? "" : "s"} ready (${Object.entries(byProvider).map(([p, n]) => `${n} ${providerLabel(p)}`).join(", ")}).`;
  const readyHistory = history.concat([{ role: "assistant", summary, at: new Date().toISOString() }]);
  await fbSet(candidatePath, { status: "ready", requestType: "variations", notes: null, focus: focus || null, section: section || null, history: readyHistory, variations, updatedAt: new Date().toISOString() });
  return variations;
}

// Commits a "ready" candidate into the actual checkpoint. Re-validates the WHOLE resulting
// batch (not just the one asset) as a safety net in case anything changed between proposing
// and accepting, records a stage-version snapshot before and after the swap (matching
// strategy-stage-approve.js's own versioning), and folds the supersession into the brand's
// learnings so future months don't repeat the killed concept/copy.
async function acceptAssetCandidate(runId, stage, assetId, actor, section, variationIndex) {
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
  // A "variations" candidate carries no single `.candidate` field — the reviewer picks
  // which of the (up to four) it actually wants, by index, rather than there being one
  // obvious thing to accept. Everything below this point operates on `chosenCandidate`
  // exactly as it always has, whichever request type it came from.
  const isVariations = candidateDoc && candidateDoc.requestType === "variations";
  if (isVariations) {
    if (!candidateDoc || candidateDoc.status !== "ready" || !Array.isArray(candidateDoc.variations) || !candidateDoc.variations.length) {
      throw new Error(`No ready variations for ${assetId}${section ? ` (${section})` : ""}.`);
    }
    if (!Number.isInteger(variationIndex) || variationIndex < 0 || variationIndex >= candidateDoc.variations.length) {
      throw new Error(`variationIndex must name one of the ${candidateDoc.variations.length} ready variations.`);
    }
  } else if (!candidateDoc || candidateDoc.status !== "ready" || !candidateDoc.candidate) {
    throw new Error(`No ready candidate for ${assetId}${section ? ` (${section})` : ""}.`);
  }
  const chosenCandidate = isVariations ? candidateDoc.variations[variationIndex].candidate : candidateDoc.candidate;
  const targetIndex = checkpoint.assets.findIndex((asset) => asset.assetId === assetId);
  if (targetIndex === -1) throw new Error(`Asset ${assetId} not found in this run's ${stage}.`);
  const oldAsset = checkpoint.assets[targetIndex];
  // A sectioned candidate only ever overlays its OWN fields (captions, or script) onto
  // whatever the checkpoint asset looks like RIGHT NOW — not the candidate's own baseAsset
  // snapshot for the untouched parts. Captions and script now run as fully independent
  // threads, so if the other section was accepted in between this candidate being
  // generated and now, using the candidate's stale copy of it here would silently revert
  // that other, unrelated change.
  const newAsset = sectionCfg ? Object.assign({}, oldAsset, pick(chosenCandidate, sectionCfg.fields)) : chosenCandidate;
  const newAssets = checkpoint.assets.map((asset, i) => (i === targetIndex ? newAsset : asset));
  const newCheckpoint = Object.assign({}, checkpoint, { assets: newAssets });

  const [config, learnings, context] = await Promise.all([loadBrandConfig(run.brandId), loadLearnings(run.brandId), cfg.loadContext(run)]);
  const issues = cfg.callValidate(newCheckpoint, config, context, learnings, run.month);
  if (issues.length) throw new StageValidationError(`${stage}-asset-${candidateDoc.requestType}`, issues);

  await saveStageVersion(runId, stage, checkpoint, `asset_${candidateDoc.requestType}_before`, actor || "system");
  await fbSet(`strategy_runs/${runId}/stages/${stage}/checkpoint`, newCheckpoint);
  await saveStageVersion(runId, stage, newCheckpoint, `asset_${candidateDoc.requestType}`, actor || "system");
  await fbSet(candidatePath, null);
  // Which provider's take actually got picked, when there was a real choice — the
  // variations flow is the one place a human directly compares full outputs from both
  // models side by side and picks a winner, which is exactly the kind of "learn something
  // from this" signal saveSystemLearningEvent's siblings exist to stop discarding. This
  // rides the existing human-attributed saveFeedbackEvent below rather than a separate
  // system event, since it's the actor's own choice, not the pipeline noticing something.
  const variationChoiceNote = isVariations
    ? ` Chose ${candidateDoc.variations[variationIndex].provider}'s take over ${candidateDoc.variations.length - 1} other generated option(s).`
    : "";
  await saveFeedbackEvent(
    run,
    stage,
    `asset_${candidateDoc.requestType}`,
    (sectionCfg ? sectionCfg.describeChange(oldAsset, newAsset) : cfg.describeChange(oldAsset, newAsset)) + (candidateDoc.notes ? ` Notes: ${candidateDoc.notes}` : "") + variationChoiceNote,
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
  proposeAssetCandidate, proposeAssetVariations, acceptAssetCandidate, replaceAsset, reopenStage,
  applyLockFilterOnApprove,
  logActivity, buildStrategyResearchBrief,
  // Exported for tests only — FailoverRuntime builds its providers lazily, so the returned
  // runtime can be inspected for provider ORDER without any key being configured.
  createRuntime, providerForStage, tierForStage, modelFor, shouldEscalateTier,
  // Exported for tests only — the competitive strategy/copy path's building blocks, each
  // small and pure enough to verify without a real model call. PROVIDER_FACTORIES is the
  // live object (not a copy): a test substitutes .openai/.claude with fakes and
  // executeCompetitiveStage picks them up immediately, since soloRuntime reads from this
  // object at call time rather than capturing it at module load.
  soloRuntime, otherProvider, reviewWithCritic, executeCompetitiveStage, PROVIDER_FACTORIES,
};

