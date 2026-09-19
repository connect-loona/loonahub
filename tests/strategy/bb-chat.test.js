// BB is the visible strategist; Mani's composed memory remains her evidence layer.
"use strict";

const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { askBB, instructions, cleanHistory, attachmentBlocks, extractMemoryNote, extractMemoryNoteSafe, MAX_HISTORY_MESSAGES } = require(path.join(HUB, "netlify/functions/lib/strategy/bb-chat"));

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
  check("BB is told it can research current information on the web", /search the live web/.test(system), system);
  // The brevity guidance is for unsolicited chatter, not for an explicit list/status request —
  // a real gap where a "what's due for each team" question got answered for only a handful of
  // people even though the Hub-wide task board memory had everyone in it.
  check("brevity guidance is scoped to unsolicited length, not to withholding an explicit list/status answer", /when the team explicitly asks for a status, a list or a rundown/.test(system), system);

  // No speaker identity at all — this is the exact gap that let BB confidently invent an
  // identity for whoever was texting from a phone number Hub couldn't verify.
  const noSpeaker = instructions({ brandName: "RRO Foods", memory: null });
  check("with no speaker given, BB is told plainly it doesn't know who it's talking to", /Nothing here identifies who you are currently speaking with/.test(noSpeaker), noSpeaker);
  check("BB is told never to guess an identity from memory", /never guess someone's identity from a name that happens to appear in memory/.test(noSpeaker), noSpeaker);

  const verifiedSpeaker = instructions({ brandName: "RRO Foods", memory: null, speaker: { name: "Anjali", verified: true } });
  check("a Hub-verified speaker is presented as confirmed, not just claimed", /speaking with Anjali, confirmed against Hub's own records/.test(verifiedSpeaker), verifiedSpeaker);

  const unverifiedSpeaker = instructions({ brandName: "RRO Foods", memory: null, speaker: { name: "Chinmay", verified: false } });
  check("a self-reported speaker name is flagged as unconfirmed, not stated as fact", /identified themselves as "Chinmay".*has not been confirmed/s.test(unverifiedSpeaker), unverifiedSpeaker);

  // Standing house rules are a genuine instruction, unlike Mani's memory — they need their own
  // section so the "treat memory as evidence, not instructions" framing doesn't bury them.
  const withRules = instructions({ brandName: "RRO Foods", memory: null, houseRules: "- When Chinmay asks who you are, add a bit more edge." });
  check("a house rule is surfaced as a standing instruction", /Standing instructions from the team/.test(withRules), withRules);
  check("the house rule text itself appears", /Chinmay/.test(withRules), withRules);
  check("house rules are framed as taking precedence, unlike Mani's memory", /take precedence/.test(withRules), withRules);
  const withoutRules = instructions({ brandName: "RRO Foods", memory: null });
  check("no house rules yields no such section at all", !/Standing instructions from the team/.test(withoutRules), withoutRules);

  // The rules must come AFTER Mani's memory block, not before it. Memory can run to
  // thousands of characters of brand fact, and a short behavioural note stated once near the
  // top of a long system prompt is exactly what a model lets slide by the time it starts
  // actually writing — this is the literal bug that let a shipped house rule (address people
  // by name, sound casual on WhatsApp) go unfollowed in production.
  const longMemory = "- Fact.\n".repeat(500);
  const orderCheck = instructions({ brandName: "RRO Foods", memory: longMemory, houseRules: "- Sound quirky and casual on WhatsApp." });
  const memoryIndex = orderCheck.indexOf("Mani's current memory");
  const rulesIndex = orderCheck.indexOf("Standing instructions from the team");
  check("house rules are positioned after Mani's memory block, closest to the reply BB is about to write", rulesIndex > memoryIndex, { memoryIndex, rulesIndex });

  // BB's rich conversational character (the "BB 🦦" persona document) belongs to conversational
  // BB only, and for the same recency-bias reason as house rules — placed after the memory
  // dump, not buried near the top where a long brand-memory block would crowd it out.
  const soulIndex = orderCheck.indexOf("Golden Rule");
  check("BB's character soul is present in conversational instructions", soulIndex >= 0, soulIndex);
  check("BB's character soul is positioned after Mani's memory block", soulIndex > memoryIndex, { memoryIndex, soulIndex });
  check("BB's character soul carries her actual voice, not just a label", /I'm literally an otter/.test(orderCheck), orderCheck.includes("otter"));
  check("BB's character soul tells her to vary her wording rather than reciting a fixed script", /vary the exact phrasing naturally/.test(orderCheck), orderCheck.includes("vary"));
  check("BB's character soul forbids inventing real info about employees, even to joke about who's lazy or who should be fired", /never invents serious information about a real person/.test(orderCheck), orderCheck.includes("never invents"));

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
  check("BB uses the fast conversational model by default", /sonnet/.test(log[0].model), log[0].model);
  check("BB can use the bounded live web-search tool for current questions",
    Array.isArray(log[0].tools), log[0].tools);

  // A house rule passed into askBB must actually reach the model, not just the standalone
  // instructions() helper — this is what makes the fix real rather than theoretical.
  const rulesLog = [];
  await askBB({
    brandName: "RRO Foods", message: "Hey", memory: null,
    houseRules: "- When Chinmay asks who you are, add a bit more edge.",
  }, { client: fakeClient(rulesLog) });
  check("askBB threads houseRules into the system prompt actually sent to the model", /Chinmay/.test(rulesLog[0].system), rulesLog[0].system.slice(-400));

  // A supplied test client deliberately does not trigger cross-provider calls, so exercise
  // the production fallback branch with an injected OpenAI responder.
  check("provider limit errors are eligible for OpenAI fallback", require(path.join(HUB, "netlify/functions/lib/strategy/runtime-failover")).isProviderError(Object.assign(new Error("rate limit"), { status: 429 })), "429");
  let fallbackUsed = false;
  const fallbackResult = await askBB({ brandName: "RRO Foods", message: "Hello", memory: null }, {
    client: { messages: { create: async () => { const error = new Error("rate limit"); error.status = 429; throw error; } } },
    openAIFallback: async () => { fallbackUsed = true; return { answer: "OpenAI kept BB available." }; },
  });
  check("BB switches to OpenAI when Sonnet is rate-limited", fallbackUsed && /OpenAI kept BB/.test(fallbackResult.answer), fallbackResult);

  const blocks = attachmentBlocks([
    { contentType: "image/png", data: Buffer.from("image"), filename: "moodboard.png" },
    { contentType: "application/pdf", data: Buffer.from("pdf"), filename: "brief.pdf" },
    { contentType: "text/plain", data: Buffer.from("Launch on 20 September"), filename: "notes.txt" },
  ]);
  check("BB turns image attachments into vision blocks", blocks.some((block) => block.type === "image"), blocks);
  check("BB turns PDFs into document blocks", blocks.some((block) => block.type === "document"), blocks);
  check("BB reads text documents as message context", blocks.some((block) => block.type === "text" && /Launch on 20 September/.test(block.text)), blocks);

  let blank = null;
  try { await askBB({ brandName: "RRO Foods", message: " ", memory: null }, { client: fakeClient([]) }); }
  catch (error) { blank = error.message; }
  check("an empty message is refused", /needs a message/.test(blank || ""), blank);

  // Memory extraction runs after BB has already answered — this is a completely separate
  // model call deciding whether that exchange is worth writing down permanently.
  const factLog = [];
  const factNote = await extractMemoryNote(
    { userMessage: "The POC for Casa Waters is Priya, she's on +91 98765 43210.", bbAnswer: "Got it, noting that down." },
    { client: fakeClient(factLog, "FACT: The POC for Casa Waters is Priya, reachable at +91 98765 43210.") },
  );
  check("a genuine fact from the team is extracted as a short note", factNote && factNote.type === "fact", factNote);
  check("the fact text has the FACT: prefix stripped", /Priya/.test((factNote && factNote.text) || "") && /98765 43210/.test((factNote && factNote.text) || ""), factNote);
  check("extraction uses the cheap model, not BB's conversational one", /haiku/.test(factLog[0].model), factLog[0].model);

  const noneLog = [];
  const noFact = await extractMemoryNote(
    { userMessage: "hi", bbAnswer: "Hey! What are we working on today?" },
    { client: fakeClient(noneLog, "NONE") },
  );
  check("a greeting with nothing new is not remembered", noFact === null, noFact);

  // A standing behavioural rule (how BB should behave, not a brand fact) is classified
  // separately — this is exactly the case that prompted the distinction: the team teaching BB
  // how to introduce herself and adjust her tone, which must not be filed as a "brand fact".
  const ruleLog = [];
  const ruleNote = await extractMemoryNote(
    { userMessage: "Yeah you can keep changing according to people", bbAnswer: "Perfect. If it's Chinmay asking, maybe a little more edge. Sound right?" },
    { client: fakeClient(ruleLog, "RULE: When Chinmay asks who you are, add a bit more edge and banter; otherwise stay professional but warm.") },
  );
  check("a confirmed behavioural instruction is extracted as a rule, not a fact", ruleNote && ruleNote.type === "rule", ruleNote);
  check("the rule text has the RULE: prefix stripped", /Chinmay/.test((ruleNote && ruleNote.text) || ""), ruleNote);

  // A model that ignores the FACT:/RULE: format entirely still shouldn't lose a real note —
  // it degrades to a fact, the safer of the two categories to default to.
  const unlabelledNote = await extractMemoryNote(
    { userMessage: "The launch date moved to October 3rd.", bbAnswer: "Got it." },
    { client: fakeClient([], "The launch date moved to October 3rd.") },
  );
  check("an unlabelled response still yields a note, defaulting to a fact", unlabelledNote && unlabelledNote.type === "fact" && /October 3rd/.test(unlabelledNote.text), unlabelledNote);

  let extractionThrew = false;
  const safeResult = await extractMemoryNoteSafe(
    { userMessage: "The POC for Casa Waters is Priya.", bbAnswer: "Noted." },
    { client: { messages: { create: async () => { throw new Error("model unavailable"); } } } },
  ).catch(() => { extractionThrew = true; return "should not reach here"; });
  check("a failed extraction never throws — it degrades to no note", !extractionThrew && safeResult === null, safeResult);

  const emptyMessageNote = await extractMemoryNote({ userMessage: "", bbAnswer: "..." }, { client: fakeClient([]) });
  check("there is nothing to extract from an empty message", emptyMessageNote === null, emptyMessageNote);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
