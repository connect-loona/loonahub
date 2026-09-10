// Tests the per-asset refine/replace flow for the COPY stage (the same generalized
// pipeline.js machinery the Strategy stage already used, now stage-aware), plus the
// per-asset lock feature on both stages: locking is a plain human checkpoint with no effect
// on the stage's own Approve flow, and using Refine/Replace/Suggest-similar on a locked
// asset silently clears its lock server-side.
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
  const strategy = require(path.join(fixtureDir, "strategy.json"));
  const copy = require(path.join(fixtureDir, "copy.json"));
  const runId = "copy-refine-test-run";

  // Seed a run already at copy needs_review — scoped to the asset-refinement layer, not
  // the full pipeline (covered elsewhere).
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "copy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stages: {
      research: { status: "approved" },
      strategy: { status: "approved", checkpoint: strategy },
      copy: { status: "needs_review", checkpoint: copy },
      "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });

  const originalAsset = copy.assets.find((a) => a.assetId === "RRO-01");

  // ---- 1. Lock an asset, then refine it — the lock should silently clear ----
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-01.json`, { lockedAt: new Date().toISOString(), lockedBy: "Gokul" });
  const lockedBefore = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-01.json`)).body;
  check("asset is locked before refining", !!lockedBefore, lockedBefore);

  const propose1 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "copy", assetId: "RRO-01", action: "refine", notes: "Lean harder into the recipe-card angle." });
  check("copy propose (refine) accepted", propose1.status === 200, propose1.body);

  const candidateDoc = await waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01.json`)).body;
    return c && c.status !== "running" ? c : null;
  }, { label: "copy refine candidate ready" });
  check('copy refine candidate reached "ready"', candidateDoc.status === "ready", candidateDoc);
  check("candidate keeps assetId/format/portfolio/sku/hook exactly as the original", candidateDoc.candidate
    && candidateDoc.candidate.assetId === "RRO-01"
    && candidateDoc.candidate.format === originalAsset.format
    && candidateDoc.candidate.portfolioId === originalAsset.portfolioId
    && candidateDoc.candidate.hook === originalAsset.hook, candidateDoc.candidate);
  check("candidate has genuinely different captions", candidateDoc.candidate && candidateDoc.candidate.captions[0].copy !== originalAsset.captions[0].copy, candidateDoc.candidate && candidateDoc.candidate.captions[0].copy);

  const lockAfterPropose = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-01.json`)).body;
  check("lock was silently cleared the moment the refine was sent", lockAfterPropose === null, lockAfterPropose);

  // ---- 2. Accept the candidate — commits into the copy checkpoint ----
  const accept1 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-accept`, { runId, stage: "copy", assetId: "RRO-01", actor: "Gokul" });
  check("copy accept succeeds", accept1.status === 200, accept1.body);

  const runAfterAccept = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  const newAsset = runAfterAccept.stages.copy.checkpoint.assets.find((a) => a.assetId === "RRO-01");
  check("copy checkpoint asset was actually replaced", newAsset.captions[0].copy !== originalAsset.captions[0].copy, newAsset.captions[0].copy);
  check("hook stayed exactly the same after a copy refine (never reworded)", newAsset.hook === originalAsset.hook, newAsset.hook);
  check("copy checkpoint still has the same number of assets (a swap, not add/remove)", runAfterAccept.stages.copy.checkpoint.assets.length === copy.assets.length);
  check("candidate node was cleared after accepting", !runAfterAccept.stages.copy.candidates || runAfterAccept.stages.copy.candidates["RRO-01"] === undefined);

  // ---- 3. Lock it again, then Replace — auto-accepts, and clears the lock ----
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-01.json`, { lockedAt: new Date().toISOString(), lockedBy: "Gokul" });
  const replace1 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-discard`, { runId, stage: "copy", assetId: "RRO-01", notes: "Still not landing.", actor: "Gokul" });
  check("copy replace accepted", replace1.status === 200, replace1.body);
  const runAfterReplace = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    const a = r.stages.copy.checkpoint.assets.find((x) => x.assetId === "RRO-01");
    return a && a.captions[0].copy !== newAsset.captions[0].copy ? r : null;
  }, { label: "replaced asset committed to copy checkpoint" });
  check("replace commits without a separate accept step", true);
  const lockAfterReplace = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-01.json`)).body;
  check("lock was cleared by the replace too", lockAfterReplace === null, lockAfterReplace);
  const candidateAfterReplace = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01.json`)).body;
  check("replace leaves no lingering candidate (auto-accepted, cleared)", candidateAfterReplace === null, candidateAfterReplace);

  // ---- 4. Copy also supports "similar" ("Suggest another" in the UI) ----
  const beforeSimilar = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  const rro01BeforeSimilar = beforeSimilar.stages.copy.checkpoint.assets.find((a) => a.assetId === "RRO-01");
  const similarOnCopy = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "copy", assetId: "RRO-01", action: "similar", focus: "Caption A" });
  check('"similar" is a valid action for copy ("Suggest another")', similarOnCopy.status === 200, similarOnCopy.body);
  const similarCandidate = await waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01.json`)).body;
    return c && c.status !== "running" ? c : null;
  }, { label: "copy similar candidate ready" });
  check('copy "similar" candidate reached "ready"', similarCandidate.status === "ready", similarCandidate);
  check("similar candidate's focus is recorded on the candidate doc", similarCandidate.focus === "Caption A", similarCandidate.focus);
  check("similar candidate keeps the current asset's identity fields (hook unchanged)", similarCandidate.candidate
    && similarCandidate.candidate.assetId === "RRO-01"
    && similarCandidate.candidate.hook === rro01BeforeSimilar.hook, similarCandidate.candidate);
  check("similar candidate offers genuinely different captions from the current checkpoint", similarCandidate.candidate.captions[0].copy !== rro01BeforeSimilar.captions[0].copy, similarCandidate.candidate.captions[0].copy);

  // ---- 5. Gating: can't refine once copy is approved ----
  await req("PATCH", `${RTDB_URL}/strategy_runs/${runId}/stages/copy.json`, { status: "approved" });
  const proposeAfterApprove = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "copy", assetId: "RRO-02", action: "refine", notes: "x" });
  check("copy propose is rejected once copy is approved", proposeAfterApprove.status === 409, proposeAfterApprove.body);

  // ---- 6. Locking itself is independent of stage approval (still lockable/toggleable
  // regardless of stage status — it's just a plain flag, no endpoint gates it) ----
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-03.json`, { lockedAt: new Date().toISOString(), lockedBy: "Gokul" });
  const lockOnApprovedStage = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-03.json`)).body;
  check("locking is a plain flag, unaffected by stage approval status", !!lockOnApprovedStage, lockOnApprovedStage);
  const stageStillApproved = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/status.json`)).body;
  check("locking an asset does NOT change the stage-level approval status (kept fully separate)", stageStillApproved === "approved", stageStillApproved);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
