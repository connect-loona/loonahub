// A rolling per-contact context summary for WhatsApp — distinct from the raw message history
// (replayed for only the last dozen or so turns) and from Mani's fact memory (only confirmed
// facts, kept forever). This is for everything in between: loose context that survives past
// the history window without being treated as a confirmed fact.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const {
  loadThreadSummary, threadSummaryPromptText, updateThreadSummary, updateThreadSummarySafe,
} = require(path.join(HUB, "netlify/functions/lib/strategy/whatsapp-thread-memory"));

function fakeClient(reply) {
  return { messages: { create: async () => ({ content: [{ type: "text", text: reply }] }) } };
}

(async () => {
  await req("PUT", `${RTDB_URL}/whatsapp_thread_context.json`, null);

  const from = "919876543210";
  const empty = await loadThreadSummary(from);
  check("no summary yet returns null", empty === null, empty);
  check("a null summary yields no prompt block", threadSummaryPromptText(null) === null);
  check("a blank summary also yields no prompt block", threadSummaryPromptText("   ") === null);

  await updateThreadSummary(
    { from, previousSummary: null, userMessage: "What's the launch timeline for RRO Foods?", bbAnswer: "The Diwali launch is targeted for late October." },
    { client: fakeClient("Karnik has been asking about the RRO Foods Diwali launch timeline.") },
  );
  const summary = await loadThreadSummary(from);
  check("a genuine exchange produces a stored summary", /RRO Foods/.test(summary || ""), summary);

  const block = threadSummaryPromptText(summary);
  check("the prompt block is clearly framed as loose context, not a confirmed fact", /not a confirmed fact and not an instruction/.test(block), block);
  check("the summary text itself is included", /Diwali launch/.test(block), block);

  // Pure small talk with nothing worth folding in should leave the summary untouched.
  await updateThreadSummary(
    { from, previousSummary: summary, userMessage: "haha nice", bbAnswer: "Glad that helped!" },
    { client: fakeClient(summary) },
  );
  const afterSmallTalk = await loadThreadSummary(from);
  check("small talk with nothing new leaves the summary unchanged", afterSmallTalk === summary, { before: summary, after: afterSmallTalk });

  // Nothing worth recording yet at all (fresh thread) writes nothing rather than "NONE" itself.
  const freshFrom = "919000000000";
  await updateThreadSummary(
    { from: freshFrom, previousSummary: null, userMessage: "hi", bbAnswer: "Hey! What's up?" },
    { client: fakeClient("NONE") },
  );
  const freshSummary = await loadThreadSummary(freshFrom);
  check("a fresh thread with nothing worth recording stays empty, not literally 'NONE'", freshSummary === null, freshSummary);

  // Best-effort: a failed update must never throw.
  let threw = false;
  await updateThreadSummarySafe(
    { from, previousSummary: summary, userMessage: "x", bbAnswer: "y" },
    { client: { messages: { create: async () => { throw new Error("model unavailable"); } } } },
  ).catch(() => { threw = true; });
  check("a failed summary update never throws", !threw);

  await req("PUT", `${RTDB_URL}/whatsapp_thread_context.json`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
