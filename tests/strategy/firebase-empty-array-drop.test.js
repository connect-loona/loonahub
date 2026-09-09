// Reproduces the exact live production crash: "copyAsset.onCreative.frames is not iterable".
//
// Real Firebase RTDB drops object keys whose value is an empty array ([]) on write — it does
// not round-trip them. `onCreative.frames: []` is a normal, valid value for a non-carousel
// copy asset (reels/statics), so after Copy is approved and Deck reloads that checkpoint via
// fbGet(), `frames` is simply MISSING from the object rather than being `[]`.
//
// tests/harness/fake-rtdb-server.js is a plain in-memory JSON store that does NOT replicate
// this real-Firebase quirk (it preserves [] correctly), so this test manually strips the keys
// after writing the checkpoint — simulating exactly what a real Firebase round-trip would
// produce — before running the Deck stage against it.
const path = require("path");
const { HUB, wipeFirebase, check, finish } = require("../harness/shared");
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
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

  const runId = "rro_2026-10_empty-array-drop-test";
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    sourceContext: [], owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "draft",
    stages: { research: { status: "queued" }, strategy: { status: "locked" }, copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" } },
    approvals: {},
  });

  await runResearchStage(runId);
  await approve(runId, "research", "strategy");

  const strategy = await runStrategyStage(runId);
  await approve(runId, "strategy", "copy");

  const copy = await runCopyStage(runId);
  await approve(runId, "copy", "creative-direction");

  // --- Simulate real Firebase's empty-array-drop behaviour on the Copy checkpoint ---
  // Every non-carousel asset legitimately has onCreative.frames: [] and an empty
  // script.scenes / caption hashtags in this fixture. Strip those keys entirely, exactly
  // like a real Firebase round-trip would, then write the mutilated checkpoint back.
  const copyCheckpoint = await fbGet(`strategy_runs/${runId}/stages/copy/checkpoint`);
  let strippedCount = 0;
  for (const asset of copyCheckpoint.assets) {
    if (Array.isArray(asset.onCreative.frames) && asset.onCreative.frames.length === 0) {
      delete asset.onCreative.frames;
      strippedCount += 1;
    }
    if (Array.isArray(asset.script.scenes) && asset.script.scenes.length === 0) {
      delete asset.script.scenes;
    }
    if (Array.isArray(asset.claimAudit.verificationFlags) && asset.claimAudit.verificationFlags.length === 0) {
      delete asset.claimAudit.verificationFlags;
    }
    for (const caption of asset.captions) {
      if (Array.isArray(caption.hashtags) && caption.hashtags.length === 0) {
        delete caption.hashtags;
      }
    }
  }
  check("fixture actually exercises the bug (at least one asset had empty onCreative.frames to strip)", strippedCount > 0, strippedCount);
  await fbSet(`strategy_runs/${runId}/stages/copy/checkpoint`, copyCheckpoint);

  const direction = await runDirectionStage(runId);
  await approve(runId, "creative-direction", "deck-builder");

  // Before the fix, this line threw "copyAsset.onCreative.frames is not iterable" —
  // validateDeck() iterated `copyAsset.onCreative.frames` straight from the Firebase-reloaded
  // (and now key-stripped) copy checkpoint.
  let deckError = null;
  let deck = null;
  try {
    deck = await runDeckStage(runId);
  } catch (e) {
    deckError = e;
  }
  check('deck stage does NOT crash with "frames is not iterable" after Firebase drops empty arrays', deckError === null, deckError && deckError.message);
  if (deck) {
    check("deck-builder stage still completes with one page per asset", deck.pages.length === strategy.assets.length, deck.pages.length);
  }

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
