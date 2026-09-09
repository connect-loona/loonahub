// Tests "going back" to an already-approved stage (pipeline.js's reopenStage(), exposed as
// strategy-stage-reopen.js): the reopened stage returns to needs_review with its checkpoint
// intact, everything downstream gets wiped back to locked (snapshotted first), and it's
// correctly gated to only already-approved stages.
const path = require("path");
const { HUB, RTDB_URL, DEV_LITE_URL, req } = require("../harness/shared");
const apiReq = (method, url, body) => req(method, url, body, { auth: true });

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_stage_versions.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_learning_events.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_activity.json`, null);

  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const research = require(path.join(fixtureDir, "research.json"));
  const strategy = require(path.join(fixtureDir, "strategy.json"));
  const copy = require(path.join(fixtureDir, "copy.json"));
  const direction = require(path.join(fixtureDir, "creative-direction.json"));
  const runId = "reopen-test-run";

  // Seed a run that's gotten all the way to deck-builder needs_review — every earlier
  // stage approved, each with its own checkpoint, locks and a stray candidate to prove
  // those get cleared on the cascade too.
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "deck-builder_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stages: {
      research: { status: "approved", checkpoint: research },
      strategy: { status: "approved", checkpoint: strategy, locks: { "RRO-01": { lockedAt: new Date().toISOString(), lockedBy: "Gokul" } } },
      copy: { status: "approved", checkpoint: copy, locks: { "RRO-01": { lockedAt: new Date().toISOString(), lockedBy: "Gokul" } }, candidates: { "RRO-02": { status: "ready", requestType: "refine", candidate: copy.assets[1] } } },
      "creative-direction": { status: "approved", checkpoint: direction },
      "deck-builder": { status: "needs_review", checkpoint: { pages: [{ pageNumber: 1 }] } },
    },
    approvals: {
      research: { decision: "approved", decidedBy: "Gokul", decidedAt: new Date().toISOString() },
      strategy: { decision: "approved", decidedBy: "Gokul", decidedAt: new Date().toISOString() },
      copy: { decision: "approved", decidedBy: "Gokul", decidedAt: new Date().toISOString() },
      "creative-direction": { decision: "approved", decidedBy: "Gokul", decidedAt: new Date().toISOString() },
    },
  });

  // ---- 1. Gating: can't reopen a stage that isn't approved ----
  const reopenNotApproved = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-reopen`, { runId, stage: "deck-builder", actor: "Gokul" });
  check("reopening a needs_review (not approved) stage is rejected", reopenNotApproved.status === 400, reopenNotApproved.body);

  // ---- 2. Gating: unknown stage name ----
  const reopenUnknown = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-reopen`, { runId, stage: "not-a-real-stage", actor: "Gokul" });
  check("reopening an unknown stage name is rejected", reopenUnknown.status === 400, reopenUnknown.body);

  // ---- 3. Reopen Strategy — the real case ----
  const reopen = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-reopen`, { runId, stage: "strategy", notes: "Portfolio balance is off, want a re-look.", actor: "Gokul" });
  check("reopening an approved stage succeeds", reopen.status === 200, reopen.body);
  check("response names everything reset downstream", reopen.body.resetDownstream && reopen.body.resetDownstream.join(",") === "copy,creative-direction,deck-builder", reopen.body.resetDownstream);

  const runAfter = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("reopened stage (strategy) is back to needs_review", runAfter.stages.strategy.status === "needs_review", runAfter.stages.strategy.status);
  check("reopened stage KEEPS its checkpoint — nothing regenerated", runAfter.stages.strategy.checkpoint && runAfter.stages.strategy.checkpoint.assets.length === strategy.assets.length);
  check("run-level status reflects the reopened stage", runAfter.status === "strategy_needs_review", runAfter.status);

  check("research (before the reopened stage) is untouched", runAfter.stages.research.status === "approved" && !!runAfter.stages.research.checkpoint);

  check("copy (downstream) is reset to locked", runAfter.stages.copy.status === "locked", runAfter.stages.copy.status);
  check("copy checkpoint was wiped", !runAfter.stages.copy.checkpoint, runAfter.stages.copy.checkpoint);
  check("copy locks were wiped", !runAfter.stages.copy.locks, runAfter.stages.copy.locks);
  check("copy candidates were wiped", !runAfter.stages.copy.candidates, runAfter.stages.copy.candidates);

  check("creative-direction (downstream) is reset to locked", runAfter.stages["creative-direction"].status === "locked");
  check("creative-direction checkpoint was wiped", !runAfter.stages["creative-direction"].checkpoint);

  check("deck-builder (downstream) is reset to locked", runAfter.stages["deck-builder"].status === "locked");
  check("deck-builder checkpoint was wiped", !runAfter.stages["deck-builder"].checkpoint);

  // ---- 4. Nothing lost — every wiped stage was snapshotted first ----
  const versions = (await req("GET", `${RTDB_URL}/strategy_stage_versions/${runId}.json`)).body;
  const copyVersions = Object.values(versions.copy || {});
  const directionVersions = Object.values(versions["creative-direction"] || {});
  const deckVersions = Object.values(versions["deck-builder"] || {});
  const strategyVersions = Object.values(versions.strategy || {});
  check("copy checkpoint was snapshotted before being wiped", copyVersions.some((v) => v.reason === "reopened_strategy_cascade"), copyVersions.map((v) => v.reason));
  check("creative-direction checkpoint was snapshotted before being wiped", directionVersions.some((v) => v.reason === "reopened_strategy_cascade"));
  check("deck-builder checkpoint was snapshotted before being wiped", deckVersions.some((v) => v.reason === "reopened_strategy_cascade"));
  check("the reopened stage itself was also snapshotted before going back to needs_review", strategyVersions.some((v) => v.reason === "reopened_before"));

  // ---- 5. The reopen notes became a learning-feedback event ----
  const learningEvents = (await req("GET", `${RTDB_URL}/strategy_learning_events/rro.json`)).body;
  check("a learning event was recorded with the reopen notes", Object.values(learningEvents || {}).some((e) => e.decision === "reopened" && e.notes === "Portfolio balance is off, want a re-look."), learningEvents);

  // ---- 6. Activity log recorded it ----
  const activity = (await req("GET", `${RTDB_URL}/strategy_activity/${runId}.json`)).body;
  check("activity log recorded the reopen", Object.values(activity || {}).some((e) => e.action === "strategy.reopened"), activity);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
