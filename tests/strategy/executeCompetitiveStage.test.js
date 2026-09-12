// Integration test for executeCompetitiveStage — the control flow that wires critic.js and
// competition.js into an actual stage run: attempts, per-provider repair, the hybrid gate
// (block once, then advisory), status writes, and metrics. critic.js/competition.js's own
// correctness (merge rules, verdict shape, scoring) is already covered by competition.test.js
// against fakes with no pipeline involved — this test's job is specifically "does the stage
// runner call those pieces correctly and finish in the right state."
//
// No real providers: PROVIDER_FACTORIES is the live object pipeline.js exports, and
// soloRuntime() reads from it at call time — so substituting .openai/.claude with fakes here
// takes effect immediately, with no network and no keys. Each test file runs as its own
// process (see tests/run-all.js), so mutating this shared object is safely isolated to this
// file alone.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { z } = require("zod");
const { HUB, wipeFirebase, check, finish } = require("../harness/shared");
const { fbSet, fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { ConfigurationError, StageValidationError } = require(path.join(HUB, "netlify/functions/lib/strategy/errors"));
const pipeline = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));
const { executeCompetitiveStage, PROVIDER_FACTORIES } = pipeline;

const StageSchema = z.object({
  assets: z.array(z.object({
    assetId: z.string(),
    value: z.string(),
    gate: z.object({ logoSwapPass: z.boolean(), killListPass: z.boolean(), tensionPass: z.boolean(), overheardPass: z.boolean() }).optional(),
  }).strict()),
}).strict();

// Reads a fake asset's intended score/gate-failure back out of its own `value` string
// ("provider:score" or "provider:score:BADGATE") so a fake critic can be fully generic —
// it just reflects whatever the test baked into the data, regardless of which physical
// provider actually gets asked to grade it.
function scoreOf(value) { return Number(/:(\d+)/.exec(value)[1]); }
function badGate(value) { return value.endsWith(":BADGATE"); }

// Every scenario below shares brandId "test" (see seedRun), so strategy_learning_events/test
// accumulates across the whole file rather than resetting per scenario — sorted by
// createdAt so "does the event I expect exist by now" reads the same regardless of
// Firebase's own key ordering.
async function learningEvents(brandId) {
  const raw = await fbGet(`strategy_learning_events/${brandId}`);
  return Object.values(raw || {}).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function fakeCritique(request) {
  const assets = request.input.assets.map((a) => ({
    assetId: a.assetId,
    logoSwapPass: !badGate(a.value), killListPass: true, tensionPass: true, overheardPass: true,
    score: scoreOf(a.value),
    reasoning: badGate(a.value) ? "Could run for any competitor." : "Specific and well-anchored.",
    fixes: badGate(a.value) ? ["Name a concrete brand anchor."] : [],
  }));
  return { assets, portfolioNotes: [] };
}

function fakeProvider(name, onWrite) {
  return () => ({ async runStage(request) {
    if (request.stage.endsWith("-critic")) return fakeCritique(request);
    return onWrite(request);
  } });
}

function baseDef(overrides) {
  return Object.assign({
    stage: "strategy",
    agentName: "Test Agent",
    fixedInstructions: "Test instructions.",
    schema: StageSchema,
    toolProfile: "none",
    input: { seed: true },
    validate: () => [],
    runningStatus: "strategy_running",
    reviewStatus: "strategy_needs_review",
    compete: true,
    criticContext: {},
  }, overrides);
}

async function seedRun(runId) {
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "test", month: "2026-11", runtime: "openai", runtimes: null,
    owner: "Test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "draft",
    stages: { strategy: { status: "queued" } },
    approvals: {},
  });
}

(async () => {
  await wipeFirebase();
  const savedOpenai = PROVIDER_FACTORIES.openai;
  const savedClaude = PROVIDER_FACTORIES.claude;
  function restore() { PROVIDER_FACTORIES.openai = savedOpenai; PROVIDER_FACTORIES.claude = savedClaude; }

  // ---- A. Both providers healthy, a real swap AND a real kept-slot in the same run ----
  {
    const runId = "compete-a";
    await seedRun(runId);
    PROVIDER_FACTORIES.openai = fakeProvider("openai", () => ({ assets: [
      { assetId: "A-01", value: "openai:9" }, { assetId: "A-02", value: "openai:3" },
    ] }));
    PROVIDER_FACTORIES.claude = fakeProvider("claude", () => ({ assets: [
      { assetId: "A-01", value: "claude:5" }, { assetId: "A-02", value: "claude:9" },
    ] }));

    const result = await executeCompetitiveStage(runId, { runId, brandId: "test", runtime: "openai" }, baseDef());
    check("A-01 (openai scored higher, 9 vs 5) is openai's version", result.assets.find((a) => a.assetId === "A-01").value === "openai:9", result.assets);
    check("A-02 (claude scored higher, 9 vs 3) stays claude's version", result.assets.find((a) => a.assetId === "A-02").value === "claude:9", result.assets);

    const run = await fbGet(`strategy_runs/${runId}`);
    check("the run reaches needs_review", run.status === "strategy_needs_review", run.status);
    check("the stage checkpoint is stored", run.stages.strategy.checkpoint && run.stages.strategy.checkpoint.assets.length === 2);
    const metrics = run.metrics.strategy;
    check("metrics record a contested (both-usable) outcome", metrics.competition.contested === true, metrics.competition);
    check("metrics record exactly one swap", metrics.competition.swapsFromChallenger === 1, metrics.competition);
    check("metrics carry the full per-asset critic verdict, not just a score", metrics.criticVerdicts.length === 2 && metrics.criticVerdicts.every((v) => typeof v.reasoning === "string" && v.reasoning.length > 0), metrics.criticVerdicts);
    check("no gate warnings when everything passed", metrics.gateWarnings === null, metrics.gateWarnings);
    const eventsAfterA = await learningEvents("test");
    check(
      "a contested round with a real swap is auto-recorded as a learning signal, with no human note involved",
      eventsAfterA.some((e) => e.decision === "competition_outcome" && e.actor === "system" && e.notes.includes("swapped in from the challenger")),
      eventsAfterA,
    );
    restore();
  }

  // ---- B. One provider is unconfigured (down for both writing AND critiquing) ----
  {
    const runId = "compete-b";
    await seedRun(runId);
    PROVIDER_FACTORIES.openai = fakeProvider("openai", () => ({ assets: [{ assetId: "A-01", value: "openai:7", gate: { logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true } }] }));
    PROVIDER_FACTORIES.claude = () => { throw new ConfigurationError("ANTHROPIC_API_KEY is required for the Claude runtime."); };

    const result = await executeCompetitiveStage(runId, { runId, brandId: "test", runtime: "openai" }, baseDef());
    check("the lone healthy provider's output is used", result.assets[0].value === "openai:7", result.assets);
    const run = await fbGet(`strategy_runs/${runId}`);
    check("still reaches needs_review with only one provider alive", run.status === "strategy_needs_review", run.status);
    check("metrics say the critic was unavailable, not silently skipped", typeof run.metrics.strategy.criticSkippedReason === "string" && run.metrics.strategy.criticSkippedReason.length > 0, run.metrics.strategy.criticSkippedReason);
    check("no critic verdicts when no independent critic could run", run.metrics.strategy.criticVerdicts === null, run.metrics.strategy.criticVerdicts);
    check("servedBy names the one provider that actually wrote it", run.metrics.strategy.servedBy === "openai", run.metrics.strategy.servedBy);
    const eventsAfterB = await learningEvents("test");
    check(
      "a solo win (nothing to compare) does NOT log a competition_outcome — there was no real contest",
      !eventsAfterB.some((e) => e.decision === "competition_outcome" && e.notes.includes("self-report only")),
      eventsAfterB,
    );
    restore();
  }

  // ---- C. Critic objects on attempt 1, both providers fix it on attempt 2 ----
  {
    const runId = "compete-c";
    await seedRun(runId);
    PROVIDER_FACTORIES.openai = fakeProvider("openai", (request) => ({
      assets: [{ assetId: "A-01", value: request.repairIssues.length ? "openai:9" : "openai:9:BADGATE" }],
    }));
    PROVIDER_FACTORIES.claude = fakeProvider("claude", (request) => ({
      assets: [{ assetId: "A-01", value: request.repairIssues.length ? "claude:6" : "claude:6:BADGATE" }],
    }));

    const result = await executeCompetitiveStage(runId, { runId, brandId: "test", runtime: "openai" }, baseDef());
    check("the fixed version is what ships", result.assets[0].value === "openai:9", result.assets);
    const run = await fbGet(`strategy_runs/${runId}`);
    check("it took the one critic-driven repair round", run.metrics.strategy.attempts === 2, run.metrics.strategy.attempts);
    check("nothing is left to warn about once fixed", run.metrics.strategy.gateWarnings === null, run.metrics.strategy.gateWarnings);
    const criticAttempt = await fbGet(`strategy_runs/${runId}/attempts/strategy/1/critic`);
    check("the critic's objection on attempt 1 was persisted", criticAttempt && criticAttempt.issues.length === 1, criticAttempt);
    const eventsAfterC = await learningEvents("test");
    check(
      "once the repair actually fixed it, no critic_objection is recorded — nothing left to remember as a problem",
      !eventsAfterC.some((e) => e.decision === "critic_objection"),
      eventsAfterC,
    );
    check(
      "the contested (if now clean) round still records who won, for the model-preference signal",
      eventsAfterC.some((e) => e.decision === "competition_outcome" && e.notes.includes("won every contested")),
      eventsAfterC,
    );
    restore();
  }

  // ---- D. Critic still objects after its one blocking repair round — hybrid: ship anyway ----
  {
    const runId = "compete-d";
    await seedRun(runId);
    PROVIDER_FACTORIES.openai = fakeProvider("openai", () => ({ assets: [{ assetId: "A-01", value: "openai:9:BADGATE" }] }));
    PROVIDER_FACTORIES.claude = fakeProvider("claude", () => ({ assets: [{ assetId: "A-01", value: "claude:6:BADGATE" }] }));

    const result = await executeCompetitiveStage(runId, { runId, brandId: "test", runtime: "openai" }, baseDef());
    check("the stage still finishes rather than looping forever", result.assets[0].assetId === "A-01");
    const run = await fbGet(`strategy_runs/${runId}`);
    check("it reaches needs_review, not failed", run.status === "strategy_needs_review", run.status);
    check("it used exactly its one critic repair round, no more", run.metrics.strategy.attempts === 2, run.metrics.strategy.attempts);
    check("the unresolved objection is attached for human review", Array.isArray(run.metrics.strategy.gateWarnings) && run.metrics.strategy.gateWarnings.length === 1, run.metrics.strategy.gateWarnings);
    const eventsAfterD = await learningEvents("test");
    check(
      "an unresolved critic objection IS auto-recorded as a durable learning signal, whether or not a human ever types a note",
      eventsAfterD.some((e) => e.decision === "critic_objection" && e.actor === "system" && e.notes === run.metrics.strategy.gateWarnings.join(" | ")),
      eventsAfterD,
    );
    restore();
  }

  // ---- E. Neither provider ever produces something valid — the stage genuinely fails ----
  {
    const runId = "compete-e";
    await seedRun(runId);
    PROVIDER_FACTORIES.openai = fakeProvider("openai", () => ({ assets: [{ assetId: "A-01", value: "openai:1" }] }));
    PROVIDER_FACTORIES.claude = fakeProvider("claude", () => ({ assets: [{ assetId: "A-01", value: "claude:1" }] }));

    let threw = null;
    try {
      await executeCompetitiveStage(runId, { runId, brandId: "test", runtime: "openai" }, baseDef({ validate: () => ["Always wrong, on purpose."] }));
    } catch (e) { threw = e; }
    check("the stage throws once every attempt is exhausted", threw instanceof StageValidationError, threw && threw.name);
    const run = await fbGet(`strategy_runs/${runId}`);
    check("the run is marked failed", run.status === "failed", run.status);
    check("all attempts (1 + MAX_REPAIRS) were spent", run.metrics.strategy.attempts === 3, run.metrics.strategy.attempts);
    const eventsAfterE = await learningEvents("test");
    check(
      "a genuinely failed stage is recorded too — an attempt that produces nothing shouldn't vanish without a trace",
      eventsAfterE.some((e) => e.decision === "stage_failed" && e.actor === "system" && e.notes.includes("Always wrong, on purpose.")),
      eventsAfterE,
    );
    restore();
  }

  // ---- F. A legitimate merge that fails whole-portfolio validation falls back safely ----
  {
    const runId = "compete-f";
    await seedRun(runId);
    PROVIDER_FACTORIES.openai = fakeProvider("openai", () => ({ assets: [
      { assetId: "A-01", value: "openai:9" }, { assetId: "A-02", value: "openai:2" },
    ] }));
    PROVIDER_FACTORIES.claude = fakeProvider("claude", () => ({ assets: [
      { assetId: "A-01", value: "claude:3" }, { assetId: "A-02", value: "claude:8" },
    ] }));
    // A whole-portfolio rule a same-shape swap can't see on its own (e.g. "no two assets
    // may share a value" would be a strange real rule, but stands in for something like a
    // cross-asset research-id or pillar-balance check): reject only the MERGED combination.
    const validate = (output) => {
      const values = output.assets.map((a) => a.value);
      const isPureOpenai = values.every((v) => v.startsWith("openai:"));
      const isPureClaude = values.every((v) => v.startsWith("claude:"));
      return (isPureOpenai || isPureClaude) ? [] : ["Mixed-provider portfolio violates a whole-set rule this test is standing in for."];
    };

    const result = await executeCompetitiveStage(runId, { runId, brandId: "test", runtime: "openai" }, baseDef({ validate }));
    const values = result.assets.map((a) => a.value);
    check("the merge was rejected and a single provider's own valid output shipped instead", values.every((v) => v.startsWith("openai:")) || values.every((v) => v.startsWith("claude:")), values);
    const run = await fbGet(`strategy_runs/${runId}`);
    check("metrics record that the merge was rejected", run.metrics.strategy.competition.mergeRejected === true, run.metrics.strategy.competition);
    const eventsAfterF = await learningEvents("test");
    check(
      "a rejected merge still records what actually shipped and why, as a learning signal",
      eventsAfterF.some((e) => e.decision === "competition_outcome" && e.notes.includes("failed whole-portfolio validation")),
      eventsAfterF,
    );
    restore();
  }

  // ---- G. Both providers error out at the runtime level every round — the failure message
  // must name what actually went wrong with EACH one, not a generic "neither worked". This
  // is the exact gap a real production run hit: soloRuntime never fails over, so if both
  // providers stumble in the same round (e.g. one out of credits, the other overloaded) the
  // person looking at "Something went wrong" needs to see that, not a blank summary. ----
  {
    const runId = "compete-g";
    await seedRun(runId);
    PROVIDER_FACTORIES.openai = () => ({ async runStage() { throw new Error("openai: no credits remaining"); } });
    PROVIDER_FACTORIES.claude = () => ({ async runStage() { throw new Error("claude: overloaded_error"); } });

    let threw = null;
    try {
      await executeCompetitiveStage(runId, { runId, brandId: "test", runtime: "openai" }, baseDef());
    } catch (e) { threw = e; }
    check("the stage still throws once every attempt is exhausted", threw instanceof StageValidationError, threw && threw.name);
    check("the failure names openai's actual error", threw && threw.message.includes("no credits remaining"), threw && threw.message);
    check("the failure names claude's actual error", threw && threw.message.includes("overloaded_error"), threw && threw.message);
    check("it does NOT fall back to the old opaque generic message", threw && !threw.message.includes("Neither model produced a usable result"), threw && threw.message);
    const run = await fbGet(`strategy_runs/${runId}`);
    check("the run is marked failed with the same per-provider detail visible on the stage", run.stages.strategy.detail.includes("no credits remaining") && run.stages.strategy.detail.includes("overloaded_error"), run.stages.strategy.detail);
    restore();
  }

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
