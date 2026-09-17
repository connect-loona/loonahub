// BB is the visible strategist; Mani's composed memory remains her evidence layer.
"use strict";

const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { askBB, instructions, cleanHistory, MAX_HISTORY_MESSAGES } = require(path.join(HUB, "netlify/functions/lib/strategy/bb-chat"));

function fakeClient(log, reply = "That is a new recommendation, not something recorded about the brand.") {
  return { messages: { create: async (params) => {
    log.push(params);
    return { content: [{ type: "text", text: reply }] };
  } } };
}

(async () => {
  const system = instructions({ brandName: "RRO Foods", memory: "- Never show the cap removed." });
  check("BB receives Mani's brand memory", /Never show the cap removed/.test(system), system.slice(-120));
  check("BB is told not to invent brand facts", /Never claim a brand fact that is absent/.test(system), system);
  check("BB can still brainstorm when memory is silent", /recommendation or new idea/.test(system), system);
  check("BB is distinct from Mani", /Do not pretend to be Mani/.test(system), system);

  const history = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user", text: `turn ${index}`,
  }));
  const cleaned = cleanHistory(history);
  check("conversation history is bounded", cleaned.length <= MAX_HISTORY_MESSAGES, cleaned.length);
  check("the newest turns are retained", cleaned[cleaned.length - 1].content.endsWith(`turn ${history.length - 1}`), cleaned[cleaned.length - 1]);

  const log = [];
  const result = await askBB({
    brandName: "RRO Foods", message: "Should we try a founder-led film?",
    memory: "- Never show the cap removed.", history: [{ role: "user", text: "We need a launch idea." }],
  }, { client: fakeClient(log) });
  check("BB returns a conversational answer", /new recommendation/.test(result.answer), result.answer);
  check("the current message follows the earlier conversation", /launch idea/.test(log[0].messages[0].content) && /founder-led/.test(log[0].messages[0].content), log[0].messages);
  check("BB uses a reasoning model", !/haiku/.test(log[0].model), log[0].model);

  let blank = null;
  try { await askBB({ brandName: "RRO Foods", message: " ", memory: null }, { client: fakeClient([]) }); }
  catch (error) { blank = error.message; }
  check("an empty message is refused", /needs a message/.test(blank || ""), blank);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
