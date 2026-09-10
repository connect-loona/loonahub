// Tests checkNoteObedience (validation.js) — turning the "note-obedience" quality check
// (agent-registry.js) from a prompt-only wish into an actual, deterministic check — both
// as a pure function and wired end to end into proposeAssetCandidate's repair loop
// (pipeline.js).
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, wipeFirebase, check, finish } = require("../harness/shared");
const { checkNoteObedience } = require(path.join(HUB, "netlify/functions/lib/strategy/validation"));
const { fbSet, fbUpdate } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { proposeAssetCandidate } = require(path.join(HUB, "netlify/functions/lib/strategy/pipeline"));

const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");

(async () => {
  // ---- Pure function: quoted phrases ----
  check("no issues when the quoted phrase is present", checkNoteObedience("refine", 'End with "Shop the range today."', "Some copy. Shop the range today.").length === 0);
  check("an issue when the quoted phrase is missing", checkNoteObedience("refine", 'End with "Shop the range today."', "Some unrelated copy.").length === 1);
  check("the issue names the missing phrase", checkNoteObedience("refine", 'End with "Shop the range today."', "Some unrelated copy.")[0].includes("Shop the range today."));

  // ---- Pure function: CTA requests ----
  check("no issues when a CTA request is satisfied", checkNoteObedience("refine", "Add a CTA at the end.", "Great copy. Shop now.").length === 0);
  check("an issue when a CTA request is not satisfied", checkNoteObedience("refine", "Add a CTA at the end.", "Great copy with no ask at all.").length === 1);
  check("the issue mentions call-to-action", checkNoteObedience("refine", "Add a CTA at the end.", "Great copy with no ask at all.")[0].toLowerCase().includes("call-to-action"));
  check('also fires on the spelled-out phrase "call to action"', checkNoteObedience("refine", "Please add a call to action.", "No ask here.").length === 1);

  // ---- Pure function: only applies to "refine" with real notes ----
  check("no notes -> no issues", checkNoteObedience("refine", "", "Anything.").length === 0);
  check("non-refine request types are never checked (nothing to be obedient to)", checkNoteObedience("similar", "Add a CTA.", "No ask here.").length === 0);
  check("discard is never checked", checkNoteObedience("discard", "Add a CTA.", "No ask here.").length === 0);

  // ---- Wired end to end: a real refine request against the fixture runtime ----
  // copy-asset-refine.json's canned output (used for every "refine" request regardless of
  // notes, since the fixture runtime just maps stage -> file) has no CTA-shaped language in
  // its endFrame/captions/script — asking for one here should make proposeAssetCandidate
  // fail via this exact check, proving it's actually wired into the repair loop, not just a
  // standalone function.
  await wipeFirebase();
  const strategyFixture = require(path.join(fixtureDir, "strategy.json"));
  const copyFixture = require(path.join(fixtureDir, "copy.json"));
  const runId = "note-obedience-test-run";
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    sourceContext: [], owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "copy_needs_review",
    stages: {
      research: { status: "approved", checkpoint: { arguments: [] } },
      strategy: { status: "approved", checkpoint: strategyFixture },
      copy: { status: "needs_review", checkpoint: copyFixture, locks: {} },
      "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });

  let ctaError = null;
  try {
    await proposeAssetCandidate(runId, "copy", "RRO-01", "refine", "Add a clear CTA at the end.");
  } catch (e) {
    ctaError = e;
  }
  check("a CTA-requesting refine fails when the fixture output has no CTA", ctaError !== null, ctaError && ctaError.message);
  check("the failure cites the call-to-action check", ctaError && ctaError.message.toLowerCase().includes("call-to-action"), ctaError && ctaError.message);

  // A refine with no such concrete ask still succeeds against the same fixture — this
  // check should never block an ordinary refine that isn't asking for something checkable.
  await fbUpdate(`strategy_runs/${runId}/stages/copy/candidates`, null);
  const plainCandidate = await proposeAssetCandidate(runId, "copy", "RRO-01", "refine", "Make the tone a bit warmer.");
  check("an ordinary refine with nothing concrete to check still succeeds", !!plainCandidate, plainCandidate && plainCandidate.assetId);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
