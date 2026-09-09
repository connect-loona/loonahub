// Exercises the real HTTP endpoints (not pipeline functions directly, unlike
// pipeline.test.js) against tests/harness's two local servers: dedup on
// strategy-run-start, all 5 stage approvals chaining correctly end to end, and
// strategy-stage-retry.js's path on a manually-forced "failed" stage.
const path = require("path");
const { HUB, RTDB_URL, DEV_LITE_URL, req, waitFor } = require("../harness/shared");

const FIXTURE_DIR = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
const apiReq = (method, url, body) => req(method, url, body, { auth: true });

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);

  // 1. Start a run with the fixture runtime.
  const start1 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-run-start`, {
    brandId: "rro", month: "2026-10", actor: "Test", runtime: "fixture", fixtureDir: FIXTURE_DIR,
  });
  check("first run-start succeeds", start1.status === 200, start1);
  const runId = start1.body.runId;

  // 2. A second run-start for the same brand+month should be rejected as a duplicate.
  const start2 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-run-start`, {
    brandId: "rro", month: "2026-10", actor: "Test", runtime: "fixture", fixtureDir: FIXTURE_DIR,
  });
  check("duplicate run-start is rejected with 409", start2.status === 409, start2.body);
  check("duplicate rejection names the existing run", start2.body && start2.body.existingRunId === runId, start2.body);

  // 3. Research should complete on its own (background function fires from run-start).
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages.research.status === "needs_review" ? r : null;
  }, { label: "research needs_review" });
  check("research reached needs_review via HTTP flow", true);

  // 4. Approve research -> strategy should run and reach needs_review.
  const approveResearch = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "research", decision: "approved", actor: "Test" });
  check("approve research succeeds", approveResearch.status === 200, approveResearch.body);
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages.strategy.status === "needs_review" ? r : null;
  }, { label: "strategy needs_review" });
  check("strategy reached needs_review after approving research", true);

  // 5. Approve strategy -> copy.
  await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "strategy", decision: "approved", actor: "Test" });
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages.copy.status === "needs_review" ? r : null;
  }, { label: "copy needs_review" });
  check("copy reached needs_review after approving strategy", true);

  // 6. Approve copy -> creative-direction.
  await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "copy", decision: "approved", actor: "Test" });
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages["creative-direction"].status === "needs_review" ? r : null;
  }, { label: "creative-direction needs_review" });
  check("creative-direction reached needs_review after approving copy", true);

  // 7. Approve creative-direction -> deck-builder, including Canva "not_configured" fallback.
  await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "creative-direction", decision: "approved", actor: "Test" });
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages["deck-builder"].status === "needs_review" ? r : null;
  }, { label: "deck-builder needs_review" });
  check("deck-builder reached needs_review after approving creative-direction", true);
  const canvaStatus = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/deck-builder/canva.json`)).body;
  check("Canva reports not_configured (expected — no credentials in this environment)", canvaStatus && canvaStatus.status === "not_configured", canvaStatus);

  // 8. Approve deck-builder -> final state, and confirm it's no longer "active" (a new
  // run-start for the same brand+month should now be allowed).
  const approveDeck = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "deck-builder", decision: "approved", actor: "Test" });
  check("approve deck-builder succeeds and reports the final status", approveDeck.status === 200 && approveDeck.body.status === "deck-builder_approved", approveDeck.body);
  const start3 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-run-start`, {
    brandId: "rro", month: "2026-10", actor: "Test", runtime: "fixture", fixtureDir: FIXTURE_DIR,
  });
  check("a new run-start is allowed once the previous run is fully approved", start3.status === 200, start3.body);
  const runId2 = start3.body.runId;

  // 9. Retry mechanism: force the fresh run's research stage into "failed", retry it, and
  // confirm it re-runs to completion.
  await req("PATCH", `${RTDB_URL}/strategy_runs/${runId2}/stages/research.json`, { status: "failed", detail: "Simulated failure for retry test." });
  const retryOnRunning = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-retry`, { runId: runId2, stage: "strategy", actor: "Test" });
  check("retry on a non-failed stage (strategy, still locked) is rejected with 409", retryOnRunning.status === 409, retryOnRunning.body);
  const retry = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-retry`, { runId: runId2, stage: "research", actor: "Test" });
  check("retry on the failed research stage succeeds", retry.status === 200, retry.body);
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId2}.json`)).body;
    return r && r.stages.research.status === "needs_review" ? r : null;
  }, { label: "retried research needs_review" });
  check("retried research stage reached needs_review", true);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
