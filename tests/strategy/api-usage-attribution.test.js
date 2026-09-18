// Ask BB and Ask Mani are real Claude spend, and until now neither one showed up in the
// same api_usage_events ledger Visual Studio's generations/picks/reviews and Strategy OS's
// pipeline stages already write to — so the "API Control Room" panel under-counted exactly
// the two features that use it most. This file checks the wiring that closes that gap:
// both endpoints now attribute a real event to whoever asked, on success AND on failure
// (a failed call still cost a request and is exactly the kind of thing usage tracking
// should surface, not hide), and neither one logs anything for a question that was
// answered for free without ever reaching a model (Mani's own "nothing recorded yet"
// short-circuit).
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const path = require("path");
const crypto = require("crypto");
const { HUB, DEV_LITE_URL, req, sleep, waitFor, check, finish } = require("../harness/shared");
const { fbGet, fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { summarizeApiUsage, monthKey } = require(path.join(HUB, "netlify/functions/lib/strategy/api-usage"));

async function usageEventsThisMonth() {
  const month = monthKey(new Date().toISOString());
  const raw = await fbGet(`api_usage_events/${month}`);
  return Object.values(raw || {});
}

(async () => {
  // ---- pure counting logic: bbQuestions/maniQuestions land in their own column, not just
  // folded anonymously into the generic "Operations" total ----
  const summary = summarizeApiUsage([
    { userId: "u1", userName: "Anjali", provider: "Anthropic", feature: "bb_chat", operation: "ask", requests: 1, status: "succeeded" },
    { userId: "u1", userName: "Anjali", provider: "Anthropic", feature: "bb_chat", operation: "ask", requests: 1, status: "failed" },
    { userId: "u1", userName: "Anjali", provider: "Anthropic", feature: "mani", operation: "ask", requests: 1, status: "succeeded" },
    { userId: "u2", userName: "Gokul", provider: "OpenAI", feature: "visual_studio", operation: "generate", requests: 1, outputCount: 2 },
  ]);
  const anjali = summary.users.find((u) => u.key === "u1");
  check("BB questions are counted separately from everything else", anjali.bbQuestions === 2, anjali);
  check("Mani questions get their own count too", anjali.maniQuestions === 1, anjali);
  check("a failed BB call still counts as a failure", anjali.failures === 1, anjali);
  const gokul = summary.users.find((u) => u.key === "u2");
  check("an unrelated Visual Studio event doesn't leak into either new column", gokul.bbQuestions === 0 && gokul.maniQuestions === 0, gokul);

  // ---- BB chat: brand scope ----
  await fbSet("brands", { b1: { brand: "RRO Foods" } });
  await fbSet("api_usage_events", null);
  await fbSet("strategy_bb_chats", null);

  const clientMessageId = `test-${Date.now()}`;
  const bbPost = await req("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-bb-chat`, {
    brandId: "rro-foods", message: "What should we post this week?", actor: "Priya", threadId: "main", clientMessageId,
  }, { auth: true });
  check("BB accepts the question and starts answering it in the background", bbPost.status === 202, bbPost);

  const bbTurn = await waitFor(async () => {
    const doc = await fbGet(`strategy_bb_chats/rro-foods/main/messages/${clientMessageId}`);
    return doc && doc.status !== "pending" ? doc : null;
  }, { label: "BB message leaves pending" });
  // No ANTHROPIC_API_KEY is set in this harness, so the call to BB genuinely fails here —
  // exactly the case that matters most to not have silently missing from the usage ledger.
  check("BB's call failed as expected in this harness (no API key configured)", bbTurn.status === "failed", bbTurn);

  const bbEvent = await waitFor(async () => (await usageEventsThisMonth()).find((e) => e.feature === "bb_chat" && e.brandId === "rro-foods") || null, { label: "BB usage event for rro-foods" });
  check("a failed BB call is still recorded as usage, not silently dropped", bbEvent.status === "failed" && bbEvent.operation === "ask", bbEvent);
  check("the free-text actor name is attributed since no Firebase session was presented", bbEvent.userName === "Priya" && bbEvent.identityVerified === false, bbEvent);
  check("no real provider/model is claimed for a call that never completed", bbEvent.provider === "unknown" && bbEvent.model === null, bbEvent);

  // ---- BB chat: global scope records with no brandId ----
  await fbSet("api_usage_events", null);
  const globalMessageId = `test-global-${Date.now()}`;
  const globalPost = await req("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-bb-chat`, {
    scope: "global", message: "What's overdue across Loona?", actor: "Priya", threadId: "main", clientMessageId: globalMessageId,
  }, { auth: true });
  check("global BB also accepts the question", globalPost.status === 202, globalPost);
  await waitFor(async () => (await usageEventsThisMonth()).length > 0 || null, { label: "global BB usage event appears" });
  const globalEvent = (await usageEventsThisMonth()).find((e) => e.feature === "bb_chat");
  check("the global conversation isn't attributed to any one brand", globalEvent && globalEvent.brandId === null, globalEvent);

  // ---- Ask Mani ----
  await fbSet("api_usage_events", null);
  // Gives loadBrandBrain something to compose so Mani actually calls a model instead of
  // taking the free "nothing recorded yet" shortcut that costs no request at all.
  await fbSet("mani_brand_notes/rro-foods", { n1: { content: "Never show the cap removed from the bottle.", createdAt: new Date().toISOString() } });

  const maniPost = await req("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-mani-ask`, { brandId: "rro-foods", question: "What must we never show?" }, { auth: true });
  check("Mani's endpoint responds even though the model call itself fails here", maniPost.status === 502 || maniPost.status === 503, maniPost);

  const maniEvent = await waitFor(async () => (await usageEventsThisMonth()).find((e) => e.feature === "mani") || null, { label: "Mani usage event" });
  check("a failed Ask Mani call is recorded as usage", maniEvent.status === "failed" && maniEvent.operation === "ask" && maniEvent.brandId === "rro-foods", maniEvent);
  check("Mani's caller is attributed the same way BB's is (cookie auth only, no Firebase session)", maniEvent.identityVerified === false, maniEvent);

  // ---- Mani's free "nothing recorded" answer must NOT be logged as usage ----
  await fbSet("api_usage_events", null);
  // Wipe the notes seeded above so this brand genuinely has nothing recorded.
  await fbSet("mani_brand_notes/rro-foods", null);
  const emptyMemoryCall = await req("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-mani-ask`, { brandId: "rro-foods", question: "anything at all?" }, { auth: true });
  check("an unscanned/empty brand still gets an honest answer", emptyMemoryCall.status === 200 && emptyMemoryCall.body.nothingRecorded === true, emptyMemoryCall);
  await sleep(300);
  const eventsAfterEmptyCall = await usageEventsThisMonth();
  check("answering for free (no model call) records no usage event at all", eventsAfterEmptyCall.length === 0, eventsAfterEmptyCall);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
