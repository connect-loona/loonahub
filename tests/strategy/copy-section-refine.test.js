// Tests that captions and script on a COPY asset are now fully independent refinable
// sections (pipeline.js's ASSET_STAGE_CONFIG.copy.sections) — each gets its own candidate
// thread, its own lock, and touching one can never leak into or revert the other, even when
// the two are accepted out of order.
const path = require("path");
const { HUB, RTDB_URL, DEV_LITE_URL, req, waitFor } = require("../harness/shared");
const apiReq = (method, url, body) => req(method, url, body, { auth: true });

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}

async function waitReady(runId, assetKey) {
  return waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/${assetKey}.json`)).body;
    return c && c.status !== "running" ? c : null;
  }, { label: `${assetKey} candidate ready` });
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_learning_events.json`, null);

  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const strategy = require(path.join(fixtureDir, "strategy.json"));
  const copy = require(path.join(fixtureDir, "copy.json"));
  const runId = "copy-section-test-run";
  const originalAsset = copy.assets.find((a) => a.assetId === "RRO-01");

  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "copy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stages: {
      research: { status: "approved" },
      strategy: { status: "approved", checkpoint: strategy },
      copy: { status: "needs_review", checkpoint: copy, locks: {} },
      "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });

  // ---- 1. Refine captions only ----
  const proposeCaptions = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "copy", assetId: "RRO-01", action: "refine", notes: "Make caption A punchier.", focus: "Captions", section: "captions" });
  check("captions-scoped refine accepted", proposeCaptions.status === 200, proposeCaptions.body);
  const captionsCandidate = await waitReady(runId, "RRO-01::captions");
  check("captions candidate reached ready", captionsCandidate.status === "ready", captionsCandidate);
  check("captions candidate has genuinely different captions", captionsCandidate.candidate.captions[0].copy !== originalAsset.captions[0].copy, captionsCandidate.candidate.captions[0].copy);
  check("captions-scoped refine did NOT touch the script (hard field lock)", captionsCandidate.candidate.script.durationSeconds === originalAsset.script.durationSeconds, captionsCandidate.candidate.script);
  check("captions candidate keeps identity fields (hook unchanged)", captionsCandidate.candidate.hook === originalAsset.hook);
  check("candidate doc records its own section", captionsCandidate.section === "captions", captionsCandidate.section);

  // ---- 2. Refine script only — a totally separate thread; captions candidate is untouched ----
  const proposeScript = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "copy", assetId: "RRO-01", action: "refine", notes: "Make the close land harder.", focus: "Script", section: "script" });
  check("script-scoped refine accepted", proposeScript.status === 200, proposeScript.body);
  const scriptCandidate = await waitReady(runId, "RRO-01::script");
  check("script candidate reached ready", scriptCandidate.status === "ready", scriptCandidate);
  check("script-scoped refine did NOT touch captions (hard field lock)", scriptCandidate.candidate.captions[0].copy === originalAsset.captions[0].copy, scriptCandidate.candidate.captions[0].copy);
  check("script candidate has a genuinely different script", scriptCandidate.candidate.script.durationSeconds !== originalAsset.script.durationSeconds, scriptCandidate.candidate.script.durationSeconds);

  const captionsCandidateStillThere = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01::captions.json`)).body;
  check("both section candidates coexist independently — captions candidate untouched by the script propose", captionsCandidateStillThere.status === "ready" && captionsCandidateStillThere.candidate.captions[0].copy === captionsCandidate.candidate.captions[0].copy, captionsCandidateStillThere);

  // ---- 3. Independent locks ----
  const lockCaptions = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-asset-lock`, { runId, stage: "copy", assetId: "RRO-01", actor: "Gokul", locked: true, section: "captions" });
  check("locking captions section succeeds", lockCaptions.status === 200, lockCaptions.body);
  const locksAfterCaptionsLock = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks.json`)).body;
  check("only the captions section is locked, not script", !!locksAfterCaptionsLock["RRO-01::captions"] && !locksAfterCaptionsLock["RRO-01::script"], locksAfterCaptionsLock);

  // ---- 4. Accept script FIRST (out of order) — commits only script fields onto the
  // CURRENT checkpoint asset, must not revert the still-pending captions candidate's work
  // (which hasn't been accepted yet, so the checkpoint's captions are still the ORIGINAL
  // ones at this point) ----
  const acceptScript = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-accept`, { runId, stage: "copy", assetId: "RRO-01", actor: "Gokul", section: "script" });
  check("accepting the script candidate succeeds", acceptScript.status === 200, acceptScript.body);
  const runAfterScriptAccept = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  const assetAfterScriptAccept = runAfterScriptAccept.stages.copy.checkpoint.assets.find((a) => a.assetId === "RRO-01");
  check("checkpoint's script was updated", assetAfterScriptAccept.script.durationSeconds === scriptCandidate.candidate.script.durationSeconds, assetAfterScriptAccept.script.durationSeconds);
  check("checkpoint's captions are STILL the original (captions candidate not yet accepted)", assetAfterScriptAccept.captions[0].copy === originalAsset.captions[0].copy, assetAfterScriptAccept.captions[0].copy);
  check("accepting script cleared only the script candidate", (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01::script.json`)).body === null);
  const captionsCandidateAfterScriptAccept = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01::captions.json`)).body;
  check("captions candidate survives the script accept untouched", captionsCandidateAfterScriptAccept && captionsCandidateAfterScriptAccept.status === "ready", captionsCandidateAfterScriptAccept);
  check("script's lock is untouched by accepting (was never locked)", (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-01::script.json`)).body === null);

  // ---- 5. NOW accept the captions candidate — must merge onto the CURRENT checkpoint
  // asset (which already has the new script from step 4), not revert it back to the
  // captions candidate's own stale baseAsset snapshot of the script ----
  const acceptCaptions = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-accept`, { runId, stage: "copy", assetId: "RRO-01", actor: "Gokul", section: "captions" });
  check("accepting the captions candidate succeeds", acceptCaptions.status === 200, acceptCaptions.body);
  const runAfterBoth = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  const finalAsset = runAfterBoth.stages.copy.checkpoint.assets.find((a) => a.assetId === "RRO-01");
  check("final asset has the NEW captions", finalAsset.captions[0].copy === captionsCandidate.candidate.captions[0].copy, finalAsset.captions[0].copy);
  check("final asset STILL has the NEW script — accepting captions did not revert it", finalAsset.script.durationSeconds === scriptCandidate.candidate.script.durationSeconds, finalAsset.script.durationSeconds);
  // Accepting never touches locks (only proposing a new request does — see
  // proposeAssetCandidate's own comment) — the captions lock set in step 3, AFTER that
  // candidate was already generated, survives this accept untouched.
  check("captions lock (set in step 3) survives accepting the already-generated candidate", !!(await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-01::captions.json`)).body);

  // ---- 6. Rejecting one section's candidate doesn't touch the other ----
  const proposeCaptions2 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "copy", assetId: "RRO-01", action: "refine", notes: "One more caption pass.", section: "captions" });
  check("second captions refine accepted", proposeCaptions2.status === 200, proposeCaptions2.body);
  await waitReady(runId, "RRO-01::captions");
  await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-asset-lock`, { runId, stage: "copy", assetId: "RRO-01", actor: "Gokul", locked: true, section: "script" });
  const rejectCaptions = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-candidate-reject`, { runId, stage: "copy", assetId: "RRO-01", section: "captions" });
  check("rejecting the captions candidate succeeds", rejectCaptions.status === 200, rejectCaptions.body);
  check("captions candidate is cleared", (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01::captions.json`)).body === null);
  check("script's lock (set moments ago) is untouched by rejecting the captions candidate", !!(await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks/RRO-01::script.json`)).body);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
