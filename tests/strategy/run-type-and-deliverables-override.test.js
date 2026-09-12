// Tests the two new fields strategy-run-start.js accepts for the new-run intake wizard
// (apps/strategy's NewRunWizard): runType ("monthly" | "campaign", tagging a run without
// changing its pipeline — see that file's own header comment) and deliverablesOverride (a
// per-run-only override of the brand's stored deliverable counts, applied by
// runStrategyStage — see pipeline.js).
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, wipeFirebase, req, check, finish } = require("../harness/shared");
const { fbSet, fbGet, fbUpdate } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { runResearchStage, runStrategyStage } = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));
const runStart = require(path.join(HUB, "netlify/functions/strategy-run-start.js"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;
function call(body) {
  return runStart.handler({ httpMethod: "POST", headers: { cookie: authCookie, host: "127.0.0.1:9020", "x-forwarded-proto": "http" }, body: JSON.stringify(body) });
}

(async () => {
  await wipeFirebase();

  // ---- strategy-run-start.js: runType defaults to "monthly", accepts "campaign" ----
  const defaultRes = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "fixture", fixtureDir: path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10") });
  check("run-start succeeds without runType", defaultRes.statusCode === 200, defaultRes.body);
  const defaultRunId = JSON.parse(defaultRes.body).runId;
  const defaultRun = await fbGet(`strategy_runs/${defaultRunId}`);
  check("runType defaults to \"monthly\"", defaultRun.runType === "monthly", defaultRun.runType);
  check("deliverablesOverride defaults to null when not sent", defaultRun.deliverablesOverride === null || defaultRun.deliverablesOverride === undefined, defaultRun.deliverablesOverride);

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  const campaignRes = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runType: "campaign", runtime: "fixture", fixtureDir: path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10") });
  check("run-start accepts runType: campaign", campaignRes.statusCode === 200, campaignRes.body);
  const campaignRun = await fbGet(`strategy_runs/${JSON.parse(campaignRes.body).runId}`);
  check("runType is stored as campaign", campaignRun.runType === "campaign", campaignRun.runType);

  // ---- A monthly plan and a campaign are different things — the duplicate-run guard must
  // not conflate them. Only "one active MONTHLY run per brand+month" is a real constraint;
  // a campaign is scoped to its own objective (a festival, a launch), not to "the plan for
  // this month," so a brand can run several at once, and a campaign alongside that month's
  // ordinary plan is the normal case, not a collision. ----
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const firstMonthly = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "fixture", fixtureDir });
  check("the first monthly run for this brand+month succeeds", firstMonthly.statusCode === 200, firstMonthly.body);

  const secondMonthly = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "fixture", fixtureDir });
  check("a second monthly run for the SAME brand+month is still rejected as a duplicate", secondMonthly.statusCode === 409, secondMonthly.body);

  const diwaliCampaign = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runType: "campaign", runtime: "fixture", fixtureDir });
  check("a campaign for the same brand+month as an active monthly run is NOT blocked", diwaliCampaign.statusCode === 200, diwaliCampaign.body);

  const flashSaleCampaign = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runType: "campaign", runtime: "fixture", fixtureDir });
  check("a SECOND campaign for the same brand+month is also not blocked — campaigns aren't one-per-month", flashSaleCampaign.statusCode === 200, flashSaleCampaign.body);

  const monthlyAfterCampaigns = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "fixture", fixtureDir });
  check("a new monthly run is still blocked by the earlier ACTIVE monthly run, unaffected by the campaigns", monthlyAfterCampaigns.statusCode === 409, monthlyAfterCampaigns.body);

  // A run doc from before runType existed has no field at all — must still count as
  // "monthly" for the purposes of this guard, not silently stop blocking duplicates.
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  const legacyRunId = "rro_2026-11_legacy-no-runtype";
  await fbSet(`strategy_runs/${legacyRunId}`, {
    runId: legacyRunId, brandId: "rro", month: "2026-11", runtime: "fixture", fixtureDir,
    owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "research_running", // active; deliberately no runType field at all
    stages: { research: { status: "queued" }, strategy: { status: "locked" }, copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" } },
    approvals: {},
  });
  const blockedByLegacy = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "fixture", fixtureDir });
  check("a run doc with no runType at all still defaults to monthly for this guard", blockedByLegacy.statusCode === 409, blockedByLegacy.body);
  const legacyCampaign = await call({ brandId: "rro", month: "2026-11", actor: "Gokul", runType: "campaign", runtime: "fixture", fixtureDir });
  check("a campaign is still unaffected by that legacy (implicitly monthly) run", legacyCampaign.statusCode === 200, legacyCampaign.body);

  // ---- strategy-run-start.js: deliverablesOverride validation ----
  const badOverride = await call({ brandId: "rro", month: "2026-12", actor: "Gokul", deliverablesOverride: { reel: -1, carousel: 4, static: 3 } });
  check("rejects a negative deliverablesOverride value", badOverride.statusCode === 400, badOverride.body);

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  const overrideRes = await call({
    brandId: "rro", month: "2026-12", actor: "Gokul", runtime: "fixture",
    fixtureDir: path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10"),
    deliverablesOverride: { reel: 5, carousel: 4, static: 3 },
  });
  const overrideRunId = JSON.parse(overrideRes.body).runId;
  const overrideRun = await fbGet(`strategy_runs/${overrideRunId}`);
  check("deliverablesOverride is stored on the run", overrideRun.deliverablesOverride && overrideRun.deliverablesOverride.reel === 5, overrideRun.deliverablesOverride);

  // ---- pipeline.js: runStrategyStage actually applies the override, not the brand's own
  // stored deliverables (RRO's real config is reel:6/carousel:4/static:3 = 13 total,
  // matching the fixture's fixed 13-asset output; overriding to reel:5 = 12 total means
  // validation against the override should fail against that same fixed fixture output —
  // proving the override, not the brand config, is what got checked).
  //
  // This is seeded directly via fbSet (same pattern as pipeline.test.js) instead of going
  // through call()/runStart.handler again: run-start.js's background trigger to
  // strategy-research-background would otherwise race this test's own direct
  // runResearchStage() call against the same run. Also note the fixture's canned research
  // output has "2026-10" baked into it, so the seeded run's month has to be "2026-10" for
  // research's own month-match validation to pass — unrelated to the deliverables override
  // being tested here.
  const pipelineRunId = "rro_2026-10_deliverables-override-test";
  await fbSet(`strategy_runs/${pipelineRunId}`, {
    runId: pipelineRunId, brandId: "rro", month: "2026-10", runtime: "fixture",
    fixtureDir: path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10"),
    sourceContext: [], runType: "monthly", deliverablesOverride: { reel: 5, carousel: 4, static: 3 },
    owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "draft",
    stages: { research: { status: "queued" }, strategy: { status: "locked" }, copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" } },
    approvals: {},
  });
  await runResearchStage(pipelineRunId); // fixture runtime completes synchronously
  await fbUpdate(`strategy_runs/${pipelineRunId}/stages/research`, { status: "approved" });
  let overrideValidationFailed = false;
  let overrideErrorMessage = "";
  try {
    await runStrategyStage(pipelineRunId);
  } catch (e) {
    overrideValidationFailed = true;
    overrideErrorMessage = e.message || String(e);
  }
  check("strategy stage validation fails against the OVERRIDDEN expected count (12), not RRO's real 13", overrideValidationFailed, overrideErrorMessage);
  check("the failure message cites the overridden total", overrideErrorMessage.includes("Expected 12 assets"), overrideErrorMessage);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
