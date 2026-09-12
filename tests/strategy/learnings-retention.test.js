// Tests loadLearnings' tiered retention (store.js): "changes_requested"/"reopened"/
// "asset_discard"/"asset_replace" are durable "don't repeat this" signals and get a much
// larger retention window (200) than routine feedback ("asset_refine"/"asset_similar"/
// "approved" with notes, capped at 30) — a flat "last 30 events total" cutoff would let 30
// recent routine tweaks push a load-bearing old rejection out of the brand's memory
// entirely.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, wipeFirebase, check, finish } = require("../harness/shared");
const { fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { loadLearnings } = require(path.join(HUB, "netlify/functions/lib/strategy/store"));

(async () => {
  await wipeFirebase();
  const brandId = "learnings-retention-test-brand";

  const events = {};
  // One old, durable rejection — well before any of the 35 routine events below, so a flat
  // "last 30 events" cutoff would drop it.
  events["evt-old-reject"] = {
    runId: "r0", month: "2026-01", stage: "strategy", decision: "changes_requested",
    notes: "OLD-REJECTION-MARKER: never use the phrase 'game-changing' again.",
    actor: "Gokul", createdAt: "2026-01-01T00:00:00.000Z",
  };
  // 35 routine refine events, each newer than the rejection above and than each other.
  for (let i = 0; i < 35; i += 1) {
    events[`evt-routine-${i}`] = {
      runId: `r${i + 1}`, month: "2026-02", stage: "strategy", decision: "asset_refine",
      notes: `ROUTINE-MARKER-${i}: minor wording tweak.`,
      actor: "Gokul", createdAt: `2026-02-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    };
  }
  await fbSet(`strategy_learning_events/${brandId}`, events);

  const text = await loadLearnings(brandId);
  check("the old durable rejection survives past 30 newer routine events", text.includes("OLD-REJECTION-MARKER"));
  check("the most recent routine events are still included", text.includes("ROUTINE-MARKER-34") && text.includes("ROUTINE-MARKER-5"));
  check("the oldest routine events beyond the 30-cap are dropped", !text.includes("ROUTINE-MARKER-0") && !text.includes("ROUTINE-MARKER-4"));
  check("exactly 30 routine events plus the 1 durable one are included", (text.match(/ROUTINE-MARKER-/g) || []).length === 30);

  // "critic_objection" and "stage_failed" (see saveSystemLearningEvent in pipeline.js) are
  // system-generated, not human-typed — critic_objection is a second, separately-tested
  // durable decision type; stage_failed is operational and belongs in its own section, not
  // mixed into content feedback a writing model might mistake for a style note.
  const brandId2 = "learnings-retention-test-brand-2";
  await fbSet(`strategy_learning_events/${brandId2}`, {
    "evt-critic": {
      runId: "r0", month: "2026-01", stage: "copy", decision: "critic_objection",
      notes: "CRITIC-MARKER: repeats exhausted territory.", actor: "system", createdAt: "2026-01-01T00:00:00.000Z",
    },
    "evt-failure": {
      runId: "r1", month: "2026-02", stage: "research", decision: "stage_failed",
      notes: "FAILURE-MARKER: every model provider failed.", actor: "system", createdAt: "2026-02-01T00:00:00.000Z",
    },
    ...Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`evt-routine2-${i}`, {
      runId: `r${i + 2}`, month: "2026-03", stage: "strategy", decision: "asset_refine",
      notes: `ROUTINE2-MARKER-${i}: minor wording tweak.`,
      actor: "Gokul", createdAt: `2026-03-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    }])),
  });
  const text2 = await loadLearnings(brandId2);
  check("a critic objection is a durable signal too, surviving past 30 newer routine events", text2.includes("CRITIC-MARKER"));
  check("a stage failure is recorded, but in its own operational section", text2.includes("FAILURE-MARKER") && text2.includes("Recent stage failures"));
  check("the operational section is clearly marked as not a content note", /Recent stage failures.*not a content note/.test(text2));
  const criticSection = text2.slice(0, text2.indexOf("Recent stage failures"));
  check("the stage failure does NOT appear in the main feedback section above it", !criticSection.includes("FAILURE-MARKER"), criticSection);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
