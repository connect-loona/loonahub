// Per-stage model assignment: strategy-run-start.js accepting (and sanitising) the optional
// `runtimes` map the New run wizard's Advanced block sends, and pipeline.js's
// createRuntime() turning a run doc into a provider ORDER — the picked model first, the
// other one behind it as the failover.
//
// Provider order is checked by inspecting the FailoverRuntime rather than running a stage:
// its providers are constructed lazily (see runtime-failover.js), so this needs no API key
// and makes no network call, same as runtime-failover.test.js.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, wipeFirebase, req, check, finish } = require("../harness/shared");
const { fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { createRuntime, providerForStage, tierForStage, modelFor, shouldEscalateTier } = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));
const { StageValidationError } = require(path.join(HUB, "netlify/functions/lib/strategy/errors"));
const { FixtureRuntime } = require(path.join(HUB, "netlify/functions/lib/strategy/runtime-fixture"));
const runStart = require(path.join(HUB, "netlify/functions/strategy-run-start.js"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;
const FIXTURE_DIR = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");

function call(body) {
  return runStart.handler({ httpMethod: "POST", headers: { cookie: authCookie, host: "127.0.0.1:9020", "x-forwarded-proto": "http" }, body: JSON.stringify(body) });
}
function order(run, stage) {
  return createRuntime(run, stage).providers.map((p) => p.name);
}

(async () => {
  await wipeFirebase();

  // ---- createRuntime: order is [picked, the other one] ----
  check("an openai run tries openai first, claude second", JSON.stringify(order({ runtime: "openai" }, "strategy")) === JSON.stringify(["openai", "claude"]), order({ runtime: "openai" }, "strategy"));
  check("a claude run tries claude first, openai second", JSON.stringify(order({ runtime: "claude" }, "strategy")) === JSON.stringify(["claude", "openai"]), order({ runtime: "claude" }, "strategy"));

  // A run doc written before per-stage assignment existed has no `runtimes` key at all, and
  // must behave exactly as it did before.
  check("a run with no runtimes map still follows its single runtime", providerForStage({ runtime: "claude" }, "copy") === "claude");
  check("an unknown runtime name falls back to openai rather than throwing", providerForStage({ runtime: "gemini" }, "copy") === "openai");

  // ---- Per-stage overrides beat the run default, stage by stage ----
  const mixed = { runtime: "openai", runtimes: { copy: "claude", "creative-direction": "claude" } };
  check("an overridden stage uses its own model", providerForStage(mixed, "copy") === "claude", providerForStage(mixed, "copy"));
  check("a stage left out of the map uses the run default", providerForStage(mixed, "research") === "openai", providerForStage(mixed, "research"));
  check("the overridden stage's failover is the run default", JSON.stringify(order(mixed, "copy")) === JSON.stringify(["claude", "openai"]), order(mixed, "copy"));

  // ---- Model tiers: Deck Builder is the cheap stage, everything else is not ----
  check("deck-builder runs on the economy tier", tierForStage("deck-builder") === "economy", tierForStage("deck-builder"));
  for (const stage of ["research", "strategy", "copy", "creative-direction"]) {
    check(`${stage} stays on the standard tier`, tierForStage(stage) === "standard", tierForStage(stage));
  }
  check("an unknown stage name defaults to standard, never to the cheap model", tierForStage("nonsense") === "standard");

  // The two tiers must actually resolve to DIFFERENT models, or the whole thing is a no-op.
  check("openai's economy model differs from its standard one", modelFor("openai", "economy") !== modelFor("openai", "standard"), [modelFor("openai", "economy"), modelFor("openai", "standard")]);
  check("claude's economy model differs from its standard one", modelFor("claude", "economy") !== modelFor("claude", "standard"), [modelFor("claude", "economy"), modelFor("claude", "standard")]);

  // Model ids come from env, never hard-coded at the call site (build brief's rule).
  const savedModel = process.env.STRATEGY_OPENAI_MODEL_ECONOMY;
  process.env.STRATEGY_OPENAI_MODEL_ECONOMY = "some-cheaper-model";
  check("the economy model id is env-overridable", modelFor("openai", "economy") === "some-cheaper-model", modelFor("openai", "economy"));
  if (savedModel === undefined) delete process.env.STRATEGY_OPENAI_MODEL_ECONOMY; else process.env.STRATEGY_OPENAI_MODEL_ECONOMY = savedModel;

  // The tier reaches the runtime that will actually be built, and an explicit tier (what
  // executeStage passes when it escalates) overrides the stage's configured one.
  check("a deck-builder runtime carries the economy tier", createRuntime({ runtime: "openai" }, "deck-builder").tier === "economy");
  check("a strategy runtime carries the standard tier", createRuntime({ runtime: "openai" }, "strategy").tier === "standard");
  check("an explicit tier overrides the stage default (this is the escalation path)", createRuntime({ runtime: "openai" }, "deck-builder", "standard").tier === "standard");

  // Escalating must not silently change WHICH provider runs — only which model of it.
  check("escalation keeps the stage's provider order", JSON.stringify(order({ runtime: "claude" }, "deck-builder")) === JSON.stringify(["claude", "openai"]), order({ runtime: "claude" }, "deck-builder"));

  // ---- When a cheap stage escalates itself to the standard model ----
  const badAnswer = new StageValidationError("deck-builder", ["Deck is missing a page for RRO-04."]);
  const providerDown = Object.assign(new Error("You have no credits remaining."), { status: 429 });

  check("escalates after the economy model returns a result that doesn't validate", shouldEscalateTier({ tier: "economy", attempt: 1, alreadyEscalated: false, lastError: badAnswer }));
  check("escalates on a schema failure too", shouldEscalateTier({ tier: "economy", attempt: 1, alreadyEscalated: false, lastError: Object.assign(new Error("Invalid input"), { name: "ZodError" }) }));
  // A pricier model of a provider that's out of credits fails identically, and the other
  // provider has already been tried by then — escalating would just spend more to fail.
  check("does NOT escalate when the provider simply couldn't answer", !shouldEscalateTier({ tier: "economy", attempt: 1, alreadyEscalated: false, lastError: providerDown }));
  check("escalates at most once, not on every repair", !shouldEscalateTier({ tier: "economy", attempt: 2, alreadyEscalated: true, lastError: badAnswer }));
  check("never escalates on the first attempt — the cheap model gets a real go", !shouldEscalateTier({ tier: "economy", attempt: 0, alreadyEscalated: false, lastError: null }));
  // Standard-tier stages have nowhere to escalate TO; this must stay a no-op for them, or
  // every ordinary repair would quietly change model mid-stage.
  check("a standard-tier stage never escalates", !shouldEscalateTier({ tier: "standard", attempt: 1, alreadyEscalated: false, lastError: badAnswer }));
  // Fixture runtimes carry no tier at all — offline/test runs must be untouched by any of this.
  check("a fixture run (no tier) never escalates", !shouldEscalateTier({ tier: undefined, attempt: 1, alreadyEscalated: false, lastError: badAnswer }));

  // ---- Fixture runs are never failed over: one deterministic source of output ----
  check("a fixture run gets the FixtureRuntime, not a failover chain", createRuntime({ runtime: "fixture", fixtureDir: FIXTURE_DIR }, "research") instanceof FixtureRuntime);

  // ---- strategy-run-start.js stores a sanitised runtimes map ----
  const res = await call({
    brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "claude",
    runtimes: { research: "openai", copy: "claude", "deck-builder": "gemini", notAStage: "openai" },
  });
  check("run-start accepts a runtimes map", res.statusCode === 200, res.body);
  const run = await fbGet(`strategy_runs/${JSON.parse(res.body).runId}`);
  check("the run default is stored", run.runtime === "claude", run.runtime);
  check("valid per-stage choices are stored", run.runtimes && run.runtimes.research === "openai" && run.runtimes.copy === "claude", run.runtimes);
  check("an unknown provider name is dropped, not stored", !run.runtimes["deck-builder"], run.runtimes);
  check("a key that isn't a pipeline stage is dropped", !run.runtimes.notAStage, run.runtimes);

  // ---- Omitting the map stores null, so nothing changes for runs started the old way ----
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  const plain = await call({ brandId: "rro", month: "2026-11", actor: "Gokul" });
  const plainRun = await fbGet(`strategy_runs/${JSON.parse(plain.body).runId}`);
  check("no runtimes map sent means none stored", plainRun.runtimes === null || plainRun.runtimes === undefined, plainRun.runtimes);
  check("runtime still defaults to openai", plainRun.runtime === "openai", plainRun.runtime);

  // ---- Fixture runs ignore the map entirely: there's only one source of output ----
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  const fixtureRes = await call({
    brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "fixture", fixtureDir: FIXTURE_DIR,
    runtimes: { copy: "claude" },
  });
  const fixtureRun = await fbGet(`strategy_runs/${JSON.parse(fixtureRes.body).runId}`);
  check("a fixture run ignores per-stage model choices", fixtureRun.runtimes === null || fixtureRun.runtimes === undefined, fixtureRun.runtimes);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
