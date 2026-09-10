// Tests the deliverables generalization: BrandConfigSchema.deliverables is now an open map
// (contracts.js) rather than a fixed {reel, carousel, static} shape, "story" is a fourth
// format the pipeline can actually generate (AssetFormatSchema), and any other named
// deliverable (e.g. "blog") is recorded but never enforced against generated asset counts
// (validation.js's SUPPORTED_ASSET_FORMATS) since the strategy stage has no way to produce
// one yet. See DeliverablesFields.tsx for the UI this backs.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, wipeFirebase, req, check, finish } = require("../harness/shared");
const { fbSet, fbGet, fbUpdate } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { runResearchStage, runStrategyStage } = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));
const { BrandConfigSchema } = require(path.join(HUB, "netlify/functions/lib/strategy/contracts"));
const runStart = require(path.join(HUB, "netlify/functions/strategy-run-start.js"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;
function call(body) {
  return runStart.handler({ httpMethod: "POST", headers: { cookie: authCookie, host: "127.0.0.1:9020", "x-forwarded-proto": "http" }, body: JSON.stringify(body) });
}

const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
const rroConfigRaw = require(path.join(HUB, "netlify/functions/lib/strategy/seed/rro.config.json"));

(async () => {
  await wipeFirebase();

  // ---- BrandConfigSchema: deliverables accepts "story" and an arbitrary extra key ----
  const withStoryAndBlog = { ...rroConfigRaw, deliverables: { ...rroConfigRaw.deliverables, story: 2, blog: 3 } };
  const parsed = BrandConfigSchema.parse(withStoryAndBlog);
  check("schema accepts a \"story\" deliverable count", parsed.deliverables.story === 2, parsed.deliverables);
  check("schema accepts an arbitrary extra deliverable (\"blog\") it doesn't know how to generate", parsed.deliverables.blog === 3, parsed.deliverables);

  const noStory = { ...rroConfigRaw };
  const parsedDefault = BrandConfigSchema.parse(noStory);
  check("a config saved before \"story\" existed still parses, defaulting story to 0", parsedDefault.deliverables.story === 0, parsedDefault.deliverables);

  // ---- strategy-run-start.js: deliverablesOverride accepts any named key ----
  const okOverride = await call({
    brandId: "rro", month: "2026-10", actor: "Gokul", runtime: "fixture", fixtureDir,
    deliverablesOverride: { reel: 6, carousel: 4, static: 3, story: 2, blog: 5 },
  });
  check("run-start accepts a deliverablesOverride naming story/blog, not just reel/carousel/static", okOverride.statusCode === 200, okOverride.body);
  const okRunId = JSON.parse(okOverride.body).runId;
  const okRun = await fbGet(`strategy_runs/${okRunId}`);
  check("the full override map is stored as given", okRun.deliverablesOverride.story === 2 && okRun.deliverablesOverride.blog === 5, okRun.deliverablesOverride);

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  const badOverride = await call({
    brandId: "rro", month: "2026-10", actor: "Gokul",
    deliverablesOverride: { reel: 6, blog: -1 },
  });
  check("a negative count on a custom deliverable name is still rejected", badOverride.statusCode === 400, badOverride.body);
  check("the rejection names the offending field", JSON.parse(badOverride.body).error.includes("blog"), badOverride.body);

  // ---- pipeline.js / validation.js: "story" is enforced, "blog" is not ----
  // The fixture runtime always returns the same fixed strategy output: 6 reel/4 carousel/3
  // static/0 story (13 total, matching RRO's real config) — a deliberately mismatched
  // "story" count proves it's actually checked, and a large "blog" count proves it's NOT,
  // since the pipeline has no way to generate a "blog" format asset.
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);

  const storyRunId = "rro_2026-10_story-enforced-test";
  await fbSet(`strategy_runs/${storyRunId}`, {
    runId: storyRunId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    sourceContext: [], runType: "monthly", deliverablesOverride: { reel: 6, carousel: 4, static: 3, story: 2 },
    owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "draft",
    stages: { research: { status: "queued" }, strategy: { status: "locked" }, copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" } },
    approvals: {},
  });
  await runResearchStage(storyRunId);
  await fbUpdate(`strategy_runs/${storyRunId}/stages/research`, { status: "approved" });
  let storyFailed = false;
  let storyError = "";
  try {
    await runStrategyStage(storyRunId);
  } catch (e) {
    storyFailed = true;
    storyError = e.message || String(e);
  }
  check("a mismatched \"story\" override makes strategy validation fail", storyFailed, storyError);
  check("the failure cites the missing story assets specifically", storyError.includes("Expected 2 story assets, received 0"), storyError);

  const blogRunId = "rro_2026-10_blog-not-enforced-test";
  await fbSet(`strategy_runs/${blogRunId}`, {
    runId: blogRunId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    sourceContext: [], runType: "monthly", deliverablesOverride: { reel: 6, carousel: 4, static: 3, blog: 5 },
    owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "draft",
    stages: { research: { status: "queued" }, strategy: { status: "locked" }, copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" } },
    approvals: {},
  });
  await runResearchStage(blogRunId);
  await fbUpdate(`strategy_runs/${blogRunId}/stages/research`, { status: "approved" });
  const blogStrategy = await runStrategyStage(blogRunId);
  check("an unmet \"blog\" count does NOT block strategy generation (blog isn't a real generated format)", blogStrategy.assets.length === 13, blogStrategy.assets.length);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
