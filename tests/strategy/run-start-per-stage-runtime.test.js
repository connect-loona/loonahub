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
const { createRuntime, providerForStage } = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));
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
