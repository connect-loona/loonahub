// Tests the per-asset refine/suggest-similar/discard flow for the STRATEGY stage end to
// end against the real HTTP endpoints, using the fixture runtime so it costs nothing and
// needs no live model. (Copy's equivalent flow is covered separately in
// copy-asset-refine-and-locks.test.js.)
const path = require("path");
const { HUB, RTDB_URL, DEV_LITE_URL, req, waitFor } = require("../harness/shared");
const apiReq = (method, url, body) => req(method, url, body, { auth: true });

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_learning_events.json`, null);

  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const research = require(path.join(fixtureDir, "research.json"));
  const strategy = require(path.join(fixtureDir, "strategy.json"));
  const runId = "concept-test-run";

  // Seed a run already at strategy needs_review (skip research/strategy generation — this
  // test is scoped to the concept-refinement layer, not the full pipeline, which is
  // already covered by pipeline.test.js).
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "strategy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stages: {
      research: { status: "approved", checkpoint: research },
      strategy: { status: "needs_review", checkpoint: strategy },
      copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });

  const originalAsset = strategy.assets.find((a) => a.assetId === "RRO-01");

  // ---- 1. Propose a "refine" candidate ----
  const propose1 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-01", action: "refine", notes: "Make it about pan loyalty vs oil indifference." });
  check("propose (refine) accepted", propose1.status === 200, propose1.body);

  const candidateDoc = await waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy/candidates/RRO-01.json`)).body;
    return c && c.status !== "running" ? c : null;
  }, { label: "refine candidate ready" });
  check('refine candidate reached "ready"', candidateDoc.status === "ready", candidateDoc);
  check("candidate keeps the original assetId/format/portfolio/skuIds", candidateDoc.candidate && candidateDoc.candidate.assetId === "RRO-01" && candidateDoc.candidate.format === "reel" && candidateDoc.candidate.portfolioId === "rro-oil", candidateDoc.candidate);
  check("candidate has a genuinely different hook", candidateDoc.candidate && candidateDoc.candidate.hook !== originalAsset.hook, candidateDoc.candidate && candidateDoc.candidate.hook);

  // ---- 2. Re-propose without accepting works: overwrites the pending candidate ----
  const propose2 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-01", action: "similar" });
  check("re-propose (similar, no notes) accepted", propose2.status === 200, propose2.body);
  await waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy/candidates/RRO-01.json`)).body;
    return c && c.status === "ready" && c.requestType === "similar" ? c : null;
  }, { label: "similar candidate ready" });
  check("candidate was overwritten with the new (similar) request type", true);

  // ---- 3. Accept the candidate — commits into the checkpoint ----
  const accept1 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-accept`, { runId, stage: "strategy", assetId: "RRO-01", actor: "Gokul" });
  check("accept succeeds", accept1.status === 200, accept1.body);

  const runAfterAccept = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  const newAsset = runAfterAccept.stages.strategy.checkpoint.assets.find((a) => a.assetId === "RRO-01");
  check("checkpoint asset was actually replaced", newAsset.hook !== originalAsset.hook, newAsset.hook);
  check("checkpoint still has 13 assets (a swap, not add/remove)", runAfterAccept.stages.strategy.checkpoint.assets.length === strategy.assets.length);
  check("candidate node was cleared after accepting", !runAfterAccept.stages.strategy.candidates || runAfterAccept.stages.strategy.candidates["RRO-01"] === undefined, runAfterAccept.stages.strategy.candidates);

  const learningEvents = (await req("GET", `${RTDB_URL}/strategy_learning_events/rro.json`)).body;
  check("a learning event was recorded for the swap", learningEvents && Object.keys(learningEvents).length >= 1, learningEvents);

  // ---- 4. Discard (same slot again, since the fixture runtime always returns the same
  // canned candidate regardless of target — its brandAnchors only validate against
  // RRO-01's own SKU) — auto-generates AND commits in one action, no separate accept ----
  const discard1 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-discard`, { runId, stage: "strategy", assetId: "RRO-01", notes: "Too close to a past campaign.", actor: "Gokul" });
  check("discard accepted", discard1.status === 200, discard1.body);
  const runAfterDiscard = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    const a = r.stages.strategy.checkpoint.assets.find((x) => x.assetId === "RRO-01");
    return a && a.hook !== strategy.assets.find((x) => x.assetId === "RRO-01").hook ? r : null;
  }, { label: "discarded asset replaced in checkpoint" });
  check("RRO-01 was replaced without a separate accept step", true);
  check("deliverable count still intact after discard", runAfterDiscard.stages.strategy.checkpoint.assets.length === strategy.assets.length);
  const candidateAfterDiscard = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy/candidates/RRO-01.json`)).body;
  check("discard leaves no lingering candidate (auto-accepted, cleared)", candidateAfterDiscard === null, candidateAfterDiscard);

  // ---- 5. Gating: can't refine once strategy is approved ----
  await req("PATCH", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy.json`, { status: "approved" });
  const proposeAfterApprove = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-03", action: "similar" });
  check("propose is rejected once strategy is approved", proposeAfterApprove.status === 409, proposeAfterApprove.body);

  // ---- 6. Gating: unknown asset id ----
  await req("PATCH", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy.json`, { status: "needs_review" });
  const proposeUnknown = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-99", action: "similar" });
  check("propose rejects an unknown assetId", proposeUnknown.status === 404, proposeUnknown.body);

  // ---- 7. Gating: refine without notes ----
  const proposeNoNotes = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-03", action: "refine" });
  check("refine without notes is rejected", proposeNoNotes.status === 400, proposeNoNotes.body);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
