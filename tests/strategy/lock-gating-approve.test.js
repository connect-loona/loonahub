// Tests pipeline.js's applyLockFilterOnApprove, exercised through the real
// strategy-stage-approve.js endpoint: approving a stage with anything locked now carries
// forward ONLY the locked subset — cutting the rest from the WHOLE run, not just the stage
// being approved, since every downstream validator checks its count against the strategy
// checkpoint specifically. Approving with nothing locked advances everything, unchanged
// from before this feature existed.
const path = require("path");
const { HUB, RTDB_URL, DEV_LITE_URL, req } = require("../harness/shared");
const apiReq = (method, url, body) => req(method, url, body, { auth: true });

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}

const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
const research = require(path.join(fixtureDir, "research.json"));
const strategy = require(path.join(fixtureDir, "strategy.json"));
const copy = require(path.join(fixtureDir, "copy.json"));
const direction = require(path.join(fixtureDir, "creative-direction.json"));
const TOTAL = strategy.assets.length; // 13, same count across every stage's fixture

function lockOf(actor) { return { lockedAt: new Date().toISOString(), lockedBy: actor || "Gokul" }; }

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_stage_versions.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_activity.json`, null);

  // ---- 1. Strategy→Copy: NOTHING locked — advances unchanged (backward compatible) ----
  {
    const runId = "lock-gate-strategy-nolock";
    await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
      runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
      status: "strategy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      stages: {
        research: { status: "approved", checkpoint: research },
        strategy: { status: "needs_review", checkpoint: strategy, locks: {} },
        copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
      },
      approvals: {},
    });
    const approve = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "strategy", decision: "approved", actor: "Gokul" });
    check("approve with nothing locked succeeds", approve.status === 200, approve.body);
    const run = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    check(`nothing locked -> all ${TOTAL} assets still there`, run.stages.strategy.checkpoint.assets.length === TOTAL, run.stages.strategy.checkpoint.assets.length);
    // Nothing was trimmed, so the trimmed count (13) still matches copy.json's own fixture
    // size — the background trigger runs synchronously in this harness, so real generation
    // has already completed by the time we check.
    check("copy stage advanced and generated for real (nothing locked -> nothing trimmed -> fixture size still matches)", run.stages.copy.status === "needs_review", run.stages.copy.status);
  }

  // ---- 2. Strategy→Copy: PARTIAL lock (2 of 13) — only the locked subset survives, in
  // BOTH the approved stage's own checkpoint and (trivially, nothing else exists yet)
  // downstream ----
  {
    const runId = "lock-gate-strategy-partial";
    const keepIds = ["RRO-01", "RRO-03"];
    await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
      runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
      status: "strategy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      stages: {
        research: { status: "approved", checkpoint: research },
        strategy: {
          status: "needs_review", checkpoint: strategy,
          locks: { "RRO-01": lockOf(), "RRO-03": lockOf() },
          candidates: { "RRO-02": { status: "ready", requestType: "refine", candidate: strategy.assets[1] } },
        },
        copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
      },
      approvals: {},
    });
    const approve = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "strategy", decision: "approved", actor: "Gokul" });
    check("approve with a partial lock succeeds", approve.status === 200, approve.body);
    const run = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    const survivingIds = run.stages.strategy.checkpoint.assets.map((a) => a.assetId).sort();
    check("only the 2 locked assets survived", survivingIds.length === 2 && survivingIds.join(",") === keepIds.slice().sort().join(","), survivingIds);
    check("dropped assets' locks were cleaned up too (only survivors' locks remain)", Object.keys(run.stages.strategy.locks || {}).sort().join(",") === keepIds.slice().sort().join(","), run.stages.strategy.locks);
    check("a stray candidate for a DROPPED asset (RRO-02) was cleaned up", !run.stages.strategy.candidates || !run.stages.strategy.candidates["RRO-02"], run.stages.strategy.candidates);
    // Trimmed to 2 assets, so copy.json's own 13-asset canned fixture output no longer
    // matches (validateCopy checks the count against the trimmed strategy) — the point
    // here is just that approving DID trigger copy (moved off "locked"), not that the
    // mismatched fixture happens to validate; a real model call would produce however many
    // assets the trimmed strategy actually has.
    check("copy stage was triggered (no longer sitting at locked)", run.stages.copy.status !== "locked", run.stages.copy.status);
    const activity = Object.values((await req("GET", `${RTDB_URL}/strategy_activity/${runId}.json`)).body || {});
    check("activity log records the drop", activity.some((a) => a.action === "strategy.approved_locked_subset" && a.detail.includes("Kept 2 of 13")), activity);
  }

  // ---- 3. Strategy→Copy: ALL locked (13 of 13) — a true no-op, no drop, no noise ----
  {
    const runId = "lock-gate-strategy-alllocked";
    const allLocks = {};
    for (const a of strategy.assets) allLocks[a.assetId] = lockOf();
    await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
      runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
      status: "strategy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      stages: {
        research: { status: "approved", checkpoint: research },
        strategy: { status: "needs_review", checkpoint: strategy, locks: allLocks },
        copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
      },
      approvals: {},
    });
    const approve = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "strategy", decision: "approved", actor: "Gokul" });
    check("approve with everything locked succeeds", approve.status === 200, approve.body);
    const run = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    check(`all ${TOTAL} locked -> all ${TOTAL} still there`, run.stages.strategy.checkpoint.assets.length === TOTAL, run.stages.strategy.checkpoint.assets.length);
    const activity = Object.values((await req("GET", `${RTDB_URL}/strategy_activity/${runId}.json`)).body || {});
    check("no drop activity logged when nothing was actually dropped", !activity.some((a) => a.action === "strategy.approved_locked_subset"), activity);
  }

  // ---- 4. Copy→Creative-direction: partial lock CASCADES back into strategy's own
  // already-existing checkpoint too, since validateDirection/validateDeck check their
  // count against STRATEGY's asset list specifically, not copy's ----
  {
    const runId = "lock-gate-copy-partial";
    const keepId = "RRO-01";
    await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
      runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
      status: "copy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      stages: {
        research: { status: "approved", checkpoint: research },
        strategy: { status: "approved", checkpoint: strategy },
        copy: {
          status: "needs_review", checkpoint: copy,
          // Only RRO-01 has BOTH sections locked — RRO-03 has just captions, which does
          // NOT count as locked (see lockedAssetIds' copy-specific rule).
          locks: { "RRO-01::captions": lockOf(), "RRO-01::script": lockOf(), "RRO-03::captions": lockOf() },
        },
        "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
      },
      approvals: {},
    });
    const approve = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "copy", decision: "approved", actor: "Gokul" });
    check("approve copy with a partial (section-complete) lock succeeds", approve.status === 200, approve.body);
    const run = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    check("only RRO-01 survived in copy's own checkpoint (RRO-03's captions-only lock didn't count)", run.stages.copy.checkpoint.assets.length === 1 && run.stages.copy.checkpoint.assets[0].assetId === keepId, run.stages.copy.checkpoint.assets);
    check("copy's own locks were cleaned to just the survivor's", Object.keys(run.stages.copy.locks).sort().join(",") === "RRO-01::captions,RRO-01::script", run.stages.copy.locks);
    check("CASCADE: strategy's already-existing checkpoint was ALSO trimmed to just RRO-01", run.stages.strategy.checkpoint.assets.length === 1 && run.stages.strategy.checkpoint.assets[0].assetId === keepId, run.stages.strategy.checkpoint.assets);
    check("creative-direction stage was triggered (no longer sitting at locked)", run.stages["creative-direction"].status !== "locked", run.stages["creative-direction"].status);
    const versions = Object.values((await req("GET", `${RTDB_URL}/strategy_stage_versions/${runId}/strategy.json`)).body || {});
    check("strategy's cascaded trim was snapshotted before being overwritten", versions.some((v) => v.reason === "locked_subset_before"), versions.map((v) => v.reason));
  }

  // ---- 5. Creative-direction→Deck-builder: partial lock cascades into BOTH strategy and
  // copy's already-existing checkpoints ----
  {
    const runId = "lock-gate-direction-partial";
    const keepId = "RRO-02";
    await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
      runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
      status: "creative-direction_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      stages: {
        research: { status: "approved", checkpoint: research },
        strategy: { status: "approved", checkpoint: strategy },
        copy: { status: "approved", checkpoint: copy },
        "creative-direction": { status: "needs_review", checkpoint: direction, locks: { "RRO-02": lockOf() } },
        "deck-builder": { status: "locked" },
      },
      approvals: {},
    });
    const approve = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "creative-direction", decision: "approved", actor: "Gokul" });
    check("approve creative-direction with a partial lock succeeds", approve.status === 200, approve.body);
    const run = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    check("creative-direction's own checkpoint trimmed to just RRO-02", run.stages["creative-direction"].checkpoint.assets.length === 1 && run.stages["creative-direction"].checkpoint.assets[0].assetId === keepId);
    check("CASCADE: strategy trimmed to just RRO-02 too", run.stages.strategy.checkpoint.assets.length === 1 && run.stages.strategy.checkpoint.assets[0].assetId === keepId, run.stages.strategy.checkpoint.assets);
    check("CASCADE: copy trimmed to just RRO-02 too", run.stages.copy.checkpoint.assets.length === 1 && run.stages.copy.checkpoint.assets[0].assetId === keepId, run.stages.copy.checkpoint.assets);
    check("deck-builder stage was triggered (no longer sitting at locked)", run.stages["deck-builder"].status !== "locked", run.stages["deck-builder"].status);
  }

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
