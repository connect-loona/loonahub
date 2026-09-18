// Global BB (browser and WhatsApp) has no single brand's Drive folder, Brand Directory or
// Visual Studio history to draw on — loadGlobalBrain is its equivalent of loadBrandBrain,
// built from whatever the team has told BB directly (pasted or auto-extracted, same store)
// plus Hub-wide activity. This also checks that extracting a memory note only ever happens
// after BB has actually answered — a failed call must never produce a note from nothing.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const path = require("path");
const { HUB, DEV_LITE_URL, RTDB_URL, req, waitFor, check, finish } = require("../harness/shared");
const { fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { recordManiEvent } = require(path.join(HUB, "netlify/functions/lib/strategy/mani-events"));
const { loadGlobalBrain } = require(path.join(HUB, "netlify/functions/lib/strategy/store"));

(async () => {
  await fbSet("mani_brand_notes/global", null);
  await fbSet("mani_events", null);

  await fbSet("mani_brand_notes/global", { n1: { content: "Ravi now owns the 2100co. account.", source: "bb_conversation", actor: "Gokul", createdAt: new Date().toISOString() } });
  await recordManiEvent({ type: "task_updated", source: "hub", actor: "Anjali", entityType: "task", entityId: "t1", action: "updated", summary: "Marked the launch brief as done." });
  // A raw bb_conversation event (if one were ever recorded for Global BB) must stay excluded
  // for the same reason loadBrandBrain excludes it — BB already has its own thread history.
  await recordManiEvent({ type: "bb_conversation", source: "strategy_os", brandId: null, actor: "Team", entityType: "bb_chat", entityId: "global", action: "asked", summary: "Asked BB: what's overdue" });

  const memory = await loadGlobalBrain();
  check("Global BB memory includes a Hub-wide extracted/pasted note", /Ravi now owns the 2100co/.test(memory || ""), memory);
  check("Global BB memory includes Hub-wide activity", /launch brief as done/.test(memory || ""), memory);
  check("Global BB memory excludes raw bb_conversation events, same as per-brand memory", !/what's overdue/.test(memory || ""), memory);

  await fbSet("mani_brand_notes/global", null);
  await fbSet("mani_events", null);
  const emptyMemory = await loadGlobalBrain();
  check("an unused Hub has no Global BB memory rather than an empty-but-truthy block", emptyMemory === null, emptyMemory);

  // ---- a failed BB call must never write a memory note ----
  const clientMessageId = `test-${Date.now()}`;
  const post = await req("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-bb-chat`, {
    scope: "global", message: "The POC for Casa Waters is Priya.", actor: "Gokul", threadId: "main", clientMessageId,
  }, { auth: true });
  check("global BB accepts the message", post.status === 202, post);
  await waitFor(async () => {
    const doc = await req("GET", `${RTDB_URL}/strategy_bb_chats/global/main/messages/${clientMessageId}.json`);
    return doc.body && doc.body.status !== "pending" ? doc.body : null;
  }, { label: "global BB message leaves pending" });
  // No ANTHROPIC_API_KEY is configured in this harness, so the call to BB genuinely fails —
  // extraction only ever runs after result.answer exists, so nothing should be written here.
  const notesAfterFailure = await req("GET", `${RTDB_URL}/mani_brand_notes/global.json`);
  check("a failed BB call extracts no memory note from nothing", !notesAfterFailure.body, notesAfterFailure.body);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
