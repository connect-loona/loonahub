// proposeAssetVariations/acceptAssetCandidate's "variations" path: up to four fresh takes on
// one asset, two from each configured model provider, rather than the single alternative
// "similar" has always produced — the actual bug in the "Get 3 variations" button, which has
// mapped to "similar" (exactly one candidate) since it shipped.
//
// Fixture-mode coverage calls pipeline.js directly with a real fixture run (deterministic,
// no keys). Real-provider coverage substitutes PROVIDER_FACTORIES with fakes, same technique
// as executeCompetitiveStage.test.js — each test file is its own process (see
// tests/run-all.js), so mutating that shared object here is safely isolated.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, wipeFirebase, req, check, finish } = require("../harness/shared");
const { fbGet, fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { proposeAssetVariations, acceptAssetCandidate, PROVIDER_FACTORIES } = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));

const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
const strategyFixture = require(path.join(fixtureDir, "strategy.json"));
const copyFixture = require(path.join(fixtureDir, "copy.json"));

async function seedStrategyRun(runId) {
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "strategy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stages: {
      research: { status: "approved", checkpoint: require(path.join(fixtureDir, "research.json")) },
      strategy: { status: "needs_review", checkpoint: strategyFixture },
      copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });
}

async function seedCopyRun(runId) {
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "copy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stages: {
      research: { status: "approved", checkpoint: require(path.join(fixtureDir, "research.json")) },
      strategy: { status: "approved", checkpoint: strategyFixture },
      copy: { status: "needs_review", checkpoint: copyFixture },
      "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });
}

(async () => {
  await wipeFirebase();

  // ---- Fixture mode: one deterministic variation, never a real provider ----
  {
    const runId = "variations-fixture";
    await seedStrategyRun(runId);
    const variations = await proposeAssetVariations(runId, "strategy", "RRO-01");
    check("fixture mode produces exactly one variation", variations.length === 1, variations.length);
    check("it's tagged as coming from the fixture, not a real provider name", variations[0].provider === "fixture", variations[0].provider);

    const doc = await fbGet(`strategy_runs/${runId}/stages/strategy/candidates/RRO-01`);
    check("the candidate doc is ready with a variations array, no singular candidate field", doc.status === "ready" && Array.isArray(doc.variations) && doc.candidate === undefined, doc);
    check("a history turn records the request", doc.history.some((h) => h.requestType === "variations"));

    const checkpoint = await acceptAssetCandidate(runId, "strategy", "RRO-01", "Gokul", null, 0);
    check("accepting index 0 commits that variation into the checkpoint", checkpoint.assets.find((a) => a.assetId === "RRO-01").conceptName === variations[0].candidate.conceptName);
    const clearedDoc = await fbGet(`strategy_runs/${runId}/stages/strategy/candidates/RRO-01`);
    check("the candidate is cleared after accepting", clearedDoc === null, clearedDoc);
  }

  // ---- Real providers: two per provider, tagged correctly ----
  const savedOpenai = PROVIDER_FACTORIES.openai;
  const savedClaude = PROVIDER_FACTORIES.claude;
  function restore() { PROVIDER_FACTORIES.openai = savedOpenai; PROVIDER_FACTORIES.claude = savedClaude; }
  let callCount = 0;

  function fakeProvider(providerName) {
    return () => ({
      async runStage(request) {
        callCount += 1;
        // Distinct enough not to collide with validateStrategy's kill-history check, which
        // (correctly) rejects a "new" concept that repeats an already-superseded one's
        // actual hook/tension text verbatim.
        const base = JSON.parse(JSON.stringify(strategyFixture.assets.find((a) => a.assetId === request.input.targetAsset.assetId)));
        base.conceptName = `${providerName} take ${callCount}`;
        base.hook = `A fresh ${providerName} hook, variation ${callCount}, never seen before.`;
        base.concept = `A fresh ${providerName} concept, variation ${callCount}, entirely new territory.`;
        base.tension = `A fresh ${providerName} tension, variation ${callCount}.`;
        return base;
      },
    });
  }

  {
    const runId = "variations-both-healthy";
    await seedStrategyRun(runId);
    await fbSet(`strategy_runs/${runId}/runtime`, "openai"); // not fixture — reaches the real fan-out
    PROVIDER_FACTORIES.openai = fakeProvider("openai");
    PROVIDER_FACTORIES.claude = fakeProvider("claude");
    callCount = 0;

    const variations = await proposeAssetVariations(runId, "strategy", "RRO-01");
    check("both providers healthy yields all four variations", variations.length === 4, variations.length);
    check("exactly two came from openai", variations.filter((v) => v.provider === "openai").length === 2, variations);
    check("exactly two came from claude", variations.filter((v) => v.provider === "claude").length === 2, variations);
    check("every variation still carries the asset's real locked identity fields", variations.every((v) => v.candidate.assetId === "RRO-01" && v.candidate.format === "reel"), variations.map((v) => v.candidate));
    restore();
  }

  // ---- One provider down: degrades to just the other's two, doesn't fail the request ----
  {
    const runId = "variations-one-down";
    await seedStrategyRun(runId);
    await fbSet(`strategy_runs/${runId}/runtime`, "openai");
    const { ConfigurationError } = require(path.join(HUB, "netlify/functions/lib/strategy/errors"));
    PROVIDER_FACTORIES.openai = () => { throw new ConfigurationError("OPENAI_API_KEY is required for the OpenAI runtime."); };
    PROVIDER_FACTORIES.claude = fakeProvider("claude");
    callCount = 0;

    const variations = await proposeAssetVariations(runId, "strategy", "RRO-01");
    check("degrades to the healthy provider's two variations", variations.length === 2, variations.length);
    check("both came from the surviving provider", variations.every((v) => v.provider === "claude"), variations);
    restore();
  }

  // ---- Both down: the request genuinely fails, candidate doc says why ----
  {
    const runId = "variations-both-down";
    await seedStrategyRun(runId);
    await fbSet(`strategy_runs/${runId}/runtime`, "openai");
    const { ConfigurationError } = require(path.join(HUB, "netlify/functions/lib/strategy/errors"));
    PROVIDER_FACTORIES.openai = () => { throw new ConfigurationError("down"); };
    PROVIDER_FACTORIES.claude = () => { throw new ConfigurationError("down"); };

    let threw = null;
    try { await proposeAssetVariations(runId, "strategy", "RRO-01"); } catch (e) { threw = e; }
    check("throws when nothing could be produced", Boolean(threw), threw);
    const doc = await fbGet(`strategy_runs/${runId}/stages/strategy/candidates/RRO-01`);
    check("the candidate doc records the failure", doc.status === "failed", doc);
    restore();
  }

  // ---- acceptAssetCandidate guards ----
  {
    const runId = "variations-accept-guards";
    await seedStrategyRun(runId);
    await fbSet(`strategy_runs/${runId}/runtime`, "openai");
    PROVIDER_FACTORIES.openai = fakeProvider("openai");
    PROVIDER_FACTORIES.claude = fakeProvider("claude");
    callCount = 0;
    await proposeAssetVariations(runId, "strategy", "RRO-01");

    let threw = null;
    try { await acceptAssetCandidate(runId, "strategy", "RRO-01", "Gokul", null, 99); } catch (e) { threw = e; }
    check("an out-of-range variationIndex is rejected", Boolean(threw) && /variationIndex/.test(threw.message), threw && threw.message);

    threw = null;
    try { await acceptAssetCandidate(runId, "strategy", "RRO-01", "Gokul", null, undefined); } catch (e) { threw = e; }
    check("a missing variationIndex on a variations candidate is rejected, not silently defaulted", Boolean(threw), threw && threw.message);
    restore();
  }

  // ---- Existing single-candidate accept flow (refine/similar) is completely untouched ----
  {
    const runId = "variations-regression-similar";
    await seedStrategyRun(runId);
    const { proposeAssetCandidate } = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));
    await proposeAssetCandidate(runId, "strategy", "RRO-01", "similar", "", null, null);
    const checkpoint = await acceptAssetCandidate(runId, "strategy", "RRO-01", "Gokul"); // no variationIndex at all
    check("a plain 'similar' candidate still accepts exactly as before, with no variationIndex", checkpoint.assets.find((a) => a.assetId === "RRO-01").assetId === "RRO-01");
  }

  // ---- Section-scoped variations (copy): the section's hard field-lock still applies ----
  {
    const runId = "variations-copy-section";
    await seedCopyRun(runId);
    await fbSet(`strategy_runs/${runId}/runtime`, "openai");
    const originalScript = copyFixture.assets.find((a) => a.assetId === "RRO-01").script;
    PROVIDER_FACTORIES.openai = () => ({
      async runStage(request) {
        const base = JSON.parse(JSON.stringify(copyFixture.assets.find((a) => a.assetId === request.input.targetAsset.assetId)));
        base.captions = base.captions.map((c, i) => Object.assign({}, c, { copy: `Variation caption ${i}` }));
        base.script = { durationSeconds: 999, scenes: [{ timing: "0-1s", visual: "should never survive", voiceover: "should never survive", onScreenText: "should never survive" }] };
        return base;
      },
    });
    PROVIDER_FACTORIES.claude = PROVIDER_FACTORIES.openai;

    const variations = await proposeAssetVariations(runId, "copy", "RRO-01", null, "captions");
    check("captions-section variations only touch captions", variations.length > 0 && variations.every((v) => JSON.stringify(v.candidate.script) === JSON.stringify(originalScript)), variations.map((v) => v.candidate.script));
    restore();
  }

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
