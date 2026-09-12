// An independent second model grading work the first one produced.
//
// The problem this exists for is at validation.js's concept-gate check:
//
//   if (!asset.gate.logoSwapPass || !asset.gate.killListPass || ...)
//
// Those four booleans are fields the WRITING model fills in about its own work. Every other
// check in validation.js is real — counts, regex patterns, research-id matching, exhausted
// territory — but the four gates that decide whether a concept is any good are pure
// self-report. A model that writes a weak concept and ticks `tensionPass: true` sails
// through untouched.
//
// So a different provider re-applies the same gates to the same assets, without being told
// what the writer claimed. Its verdicts are what feed back into the repair loop, and its
// scores are what decide the winner when both models have written a version of the same
// stage (see competition.js).
"use strict";
const { z } = require("zod");

const NonEmpty = z.string().min(1);

// One judgement per asset. `score` exists so two models' attempts at the same slot can be
// compared; the gates exist so a failure can be named and repaired. Both are needed —
// a score alone can't be fed back as a fixable issue, and a pass/fail alone can't rank.
const AssetVerdictSchema = z
  .object({
    assetId: NonEmpty,
    logoSwapPass: z.boolean(),
    killListPass: z.boolean(),
    tensionPass: z.boolean(),
    overheardPass: z.boolean(),
    // 0-10. Deliberately not derived from the gates: a concept can clear every gate and
    // still be forgettable, which is exactly the distinction a competition needs.
    score: z.number().min(0).max(10),
    // Required, and required to be specific — a verdict nobody can act on is noise.
    reasoning: NonEmpty,
    // What would have to change for a failing gate to pass. Empty when everything passed.
    fixes: z.array(NonEmpty).default([]),
  })
  .strict();

const CriticVerdictSchema = z
  .object({
    assets: z.array(AssetVerdictSchema),
    // A portfolio-level read: repetition across concepts, imbalance, a month that says one
    // thing five times. Per-asset grading can't see any of that.
    portfolioNotes: z.array(NonEmpty).default([]),
  })
  .strict();

const STRATEGY_CRITIC_INSTRUCTIONS = [
  "You are reviewing another strategist's concepts for a brand's month of content. You did not write them.",
  "Apply the four non-negotiable gates honestly and independently. Be strict: your job is to catch what the writer let through, not to agree with them.",
  "",
  "1. LOGO SWAP — could a competitor publish this unchanged after swapping the logo? If yes, it fails. The concept must rest on at least two concrete anchors specific to THIS brand.",
  "2. KILL LIST — does it repeat exhausted territory (given to you as a structured list), or a previously killed concept or client rejection recorded in the brand's learnings notes (given to you as free text)? If it does, it fails.",
  "3. TENSION — is there a real human friction stated in one sentence? \"It teaches something useful\", \"people want quality\" and other category truisms are failures.",
  "4. OVERHEARD — is there a specific person or relationship who would send this to someone? A vague audience is a failure.",
  "",
  "Then score each concept 0-10 on how much it would actually be worth publishing. Scoring is separate from the gates: a concept can pass all four and still be forgettable. Reserve 8+ for work you would defend to a client, and use the low end — most concepts are not 8s.",
  "",
  "For every failed gate, say in `fixes` what would specifically have to change. Vague advice is useless to whoever has to act on it.",
  "In `portfolioNotes`, flag anything only visible across the whole set: repeated structure, the same tension wearing different clothes, a month that is really one idea five times.",
].join("\n");

const COPY_CRITIC_INSTRUCTIONS = [
  "You are reviewing another writer's captions and scripts. You did not write them.",
  "Judge each asset's copy against the same four gates the concept had to pass, as they apply to the words actually on the page:",
  "",
  "1. LOGO SWAP — could a competitor run this caption unchanged? Generic copy fails however good the concept behind it was.",
  "2. KILL LIST — does it use banned words or prohibited claims from the brand config, repeat exhausted territory (a structured list), or repeat something the brand's learnings notes record as already killed or rejected? Any of those is a failure.",
  "3. TENSION — does the hook open a real human friction in its first line, or does it describe a product benefit?",
  "4. OVERHEARD — would a person send this to someone specific? If it reads like an advertisement talking at everyone, it fails.",
  "",
  "Score 0-10 on whether this copy is worth publishing as written. Be strict, and use the low end.",
  "For every failure, say in `fixes` exactly what would have to change, quoting the offending line.",
].join("\n");

function instructionsFor(stage) {
  if (stage === "copy") return COPY_CRITIC_INSTRUCTIONS;
  return STRATEGY_CRITIC_INSTRUCTIONS;
}

// What the critic is shown. Deliberately NOT the writer's own gate booleans or rationale:
// being told "the writer says this passes" is exactly the anchor an independent review has
// to avoid. It gets the work and the standards, nothing about the verdict it's re-deriving.
function buildCriticInput(stage, output, context) {
  const assets = (output.assets || []).map((asset) => {
    const copy = Object.assign({}, asset);
    delete copy.gate;
    return copy;
  });
  return {
    task: `Review this ${stage} output`,
    brand: context.brandConfig ? {
      name: context.brandConfig.name,
      oneLineTruth: context.brandConfig.oneLineTruth,
      voice: context.brandConfig.voice,
      products: context.brandConfig.products,
    } : null,
    exhaustedTerritory: (context.research && context.research.exhaustedTerritory) || [],
    // loadLearnings() (store.js) returns free-form markdown — the brand's seed learnings
    // plus an appended "Recent human review feedback" log of past kills/rejections/
    // corrections — not a structured killedConcepts/clientRejections array. That's the same
    // text the writer itself was given, so the critic is checking against the same record
    // of "don't repeat this" the writer was supposed to have already honoured.
    learnings: context.learnings || null,
    monthThesis: output.monthThesis || null,
    assets,
  };
}

// Turns failed gates into the same shape executeStage()'s repair loop already speaks, so a
// critic objection travels exactly like a validator issue.
function verdictToIssues(verdict) {
  const issues = [];
  for (const asset of verdict.assets || []) {
    const failed = [];
    if (!asset.logoSwapPass) failed.push("logo swap");
    if (!asset.killListPass) failed.push("kill list");
    if (!asset.tensionPass) failed.push("tension");
    if (!asset.overheardPass) failed.push("overheard");
    if (!failed.length) continue;
    const fixes = (asset.fixes || []).join(" ");
    issues.push(
      `${asset.assetId} fails the ${failed.join(" and ")} gate on independent review: ${asset.reasoning}` +
      (fixes ? ` Fix: ${fixes}` : "")
    );
  }
  return issues;
}

function averageScore(verdict) {
  const scores = (verdict.assets || []).map((a) => a.score).filter((s) => typeof s === "number");
  if (!scores.length) return 0;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

// runtime: anything with runStage(). The caller is responsible for handing in a runtime
// pointed at a DIFFERENT provider than the one that wrote the work — see criticProviderFor()
// in pipeline.js. A model grading itself is the problem, not the solution.
async function reviewStage(runtime, stage, output, context) {
  const verdict = await runtime.runStage({
    stage: `${stage}-critic`,
    agentName: "Independent review",
    instructions: instructionsFor(stage),
    input: buildCriticInput(stage, output, context),
    outputSchema: CriticVerdictSchema,
    toolProfile: "none",
    repairIssues: [],
  });
  return verdict;
}

module.exports = {
  CriticVerdictSchema, AssetVerdictSchema,
  reviewStage, buildCriticInput, verdictToIssues, averageScore, instructionsFor,
};
