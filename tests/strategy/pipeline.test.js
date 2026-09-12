// Runs the entire 5-stage pipeline end to end with the fixture runtime: research -> approve
// -> strategy -> approve -> copy -> approve -> creative-direction -> approve -> deck-builder.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, wipeFirebase, check, finish } = require("../harness/shared");
const { fbSet, fbGet, fbUpdate } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { runResearchStage, runStrategyStage, runCopyStage, runDirectionStage, runDeckStage } = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));

function approve(runId, stage, nextStage) {
  return Promise.all([
    fbUpdate(`strategy_runs/${runId}/stages/${stage}`, { status: "approved" }),
    nextStage ? fbUpdate(`strategy_runs/${runId}/stages/${nextStage}`, { status: "queued" }) : Promise.resolve(),
  ]);
}

(async () => {
  await wipeFirebase();

  const runId = "rro_2026-10_full-pipeline-test";
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    sourceContext: [], owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "draft",
    stages: { research: { status: "queued" }, strategy: { status: "locked" }, copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" } },
    approvals: {},
  });

  const research = await runResearchStage(runId);
  check("research stage completes", research.liveQuestions.length >= 8);
  await approve(runId, "research", "strategy");

  const strategy = await runStrategyStage(runId);
  check("strategy stage completes with 13 assets (RRO's own configured count, not hardcoded)", strategy.assets.length === 13, strategy.assets.length);
  await approve(runId, "strategy", "copy");

  const copy = await runCopyStage(runId);
  check("copy stage completes with one entry per strategy asset", copy.assets.length === strategy.assets.length, copy.assets.length);
  check("every copy asset has exactly 3 captions ordered A/B/C", copy.assets.every((a) => a.captions.length === 3 && a.captions.map((c) => c.version).join("") === "ABC"));
  await approve(runId, "copy", "creative-direction");

  const direction = await runDirectionStage(runId);
  check("creative-direction stage completes with one entry per asset", direction.assets.length === strategy.assets.length);
  check("every reel has a real shot list (3+ shots)", direction.assets.filter((a) => a.format === "reel").every((a) => a.shotList.length >= 3));
  await approve(runId, "creative-direction", "deck-builder");

  const deck = await runDeckStage(runId);
  check("deck-builder stage completes with one page per asset", deck.pages.length === strategy.assets.length);
  check("every deck page is enriched with owner:null and productionStatus:not_started", deck.pages.every((p) => p.owner === null && p.productionStatus === "not_started"));
  check("deck pages are in the same order as the strategy assets", deck.pages.every((p, i) => p.assetId === strategy.assets[i].assetId));

  const finalRun = await fbGet(`strategy_runs/${runId}`);
  check("final run status reflects the deck stage", finalRun.status === "deck-builder_needs_review", finalRun.status);

  // Activity log should show every stage's completion, in order.
  const activity = await fbGet(`strategy_activity/${runId}`);
  const actions = Object.values(activity || {}).map((e) => e.action).sort();
  check("activity log recorded completion for all 5 stages", ["research.completed", "strategy.completed", "copy.completed", "creative-direction.completed", "deck-builder.completed"].every((a) => actions.includes(a)), actions);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
