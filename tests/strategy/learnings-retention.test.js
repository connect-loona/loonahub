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

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
