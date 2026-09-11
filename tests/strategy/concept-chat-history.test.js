// Tests the "chat continuously" refine mechanic added to proposeAssetCandidate: a second
// (or later) "refine" request while a "ready" candidate is already sitting there builds on
// THAT candidate (chaining) instead of restarting from the last-approved checkpoint every
// time, and every turn accumulates onto a `history` transcript the frontend renders as a
// chat thread. "similar"/"discard"/"replace" are a deliberately clean alternative — they
// always restart fresh from the checkpoint, with a fresh (empty) history.
//
// The fixture runtime returns the exact same canned JSON regardless of input (see
// runtime-fixture.js), so this can't observe the chained CONTENT changing — that's already
// exercised for real by strategy-asset-refine.test.js (fixture-vs-checkpoint hook diff) and
// by note-obedience.test.js against a live-shaped request. What this test proves instead is
// the contract the frontend actually depends on: history accumulates across chained turns
// and resets on a fresh (non-refine) request.
const path = require("path");
const { HUB, RTDB_URL, DEV_LITE_URL, req, waitFor } = require("../harness/shared");
const apiReq = (method, url, body) => req(method, url, body, { auth: true });

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}

async function waitReady(runId, stage, assetId) {
  return waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/${stage}/candidates/${assetId}.json`)).body;
    return c && c.status !== "running" ? c : null;
  }, { label: `${stage} candidate ready` });
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_learning_events.json`, null);

  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const research = require(path.join(fixtureDir, "research.json"));
  const strategy = require(path.join(fixtureDir, "strategy.json"));
  const runId = "concept-chat-test-run";

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

  // ---- 1. First refine turn: fresh history with one user + one assistant turn ----
  const propose1 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-01", action: "refine", notes: "Make it warmer." });
  check("first refine accepted", propose1.status === 200, propose1.body);
  const doc1 = await waitReady(runId, "strategy", "RRO-01");
  check("first refine reached ready", doc1.status === "ready", doc1.status);
  check("history has exactly 2 turns after the first refine", Array.isArray(doc1.history) && doc1.history.length === 2, doc1.history);
  check("turn 1 is a user turn carrying the notes", doc1.history[0].role === "user" && doc1.history[0].notes === "Make it warmer.", doc1.history[0]);
  check("turn 2 is an assistant turn with a summary", doc1.history[1].role === "assistant" && typeof doc1.history[1].summary === "string" && doc1.history[1].summary.length > 0, doc1.history[1]);

  // ---- 2. Second refine turn (still not accepted): chains onto the first candidate,
  // history grows to 4 turns rather than resetting to 2 ----
  const propose2 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-01", action: "refine", notes: "Now lean harder into the loyalty angle." });
  check("second refine accepted", propose2.status === 200, propose2.body);
  const doc2 = await waitReady(runId, "strategy", "RRO-01");
  check("second refine reached ready", doc2.status === "ready", doc2.status);
  check("history has 4 turns after the second (chained) refine — the first round's turns survive", Array.isArray(doc2.history) && doc2.history.length === 4, doc2.history);
  check("turn 1 of the chained history is still the FIRST round's user turn (not overwritten)", doc2.history[0].notes === "Make it warmer.", doc2.history[0]);
  check("turn 3 is the SECOND round's user turn", doc2.history[2].role === "user" && doc2.history[2].notes === "Now lean harder into the loyalty angle.", doc2.history[2]);
  check("turn 4 is the SECOND round's assistant turn", doc2.history[3].role === "assistant", doc2.history[3]);

  // ---- 3. A "similar" request instead of "refine" is a clean alternative, not a
  // continuation: history resets to a single fresh user+assistant pair ----
  const propose3 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-01", action: "similar" });
  check("similar accepted", propose3.status === 200, propose3.body);
  const doc3 = await waitReady(runId, "strategy", "RRO-01");
  check("similar reached ready", doc3.status === "ready", doc3.status);
  check("similar starts a FRESH history (2 turns, not 6)", Array.isArray(doc3.history) && doc3.history.length === 2, doc3.history);
  check("similar's user turn has requestType similar and no notes", doc3.history[0].requestType === "similar" && doc3.history[0].notes === null, doc3.history[0]);

  // ---- 4. Refining again after a "similar" chains onto the similar candidate, not the
  // two earlier refine turns that were already superseded ----
  const propose4 = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-concept-propose`, { runId, stage: "strategy", assetId: "RRO-01", action: "refine", notes: "One more pass." });
  check("refine after similar accepted", propose4.status === 200, propose4.body);
  const doc4 = await waitReady(runId, "strategy", "RRO-01");
  check("history chains onto the similar candidate (4 turns: similar's pair + this refine's pair)", Array.isArray(doc4.history) && doc4.history.length === 4, doc4.history);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
