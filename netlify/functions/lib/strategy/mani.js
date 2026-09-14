// 🧠 Mani — the brand memory agent.
//
// Loona Brain was a filing cabinet: it stored everything well, and the only way in was one
// fixed block pushed into every stage prompt. Nothing could ASK it anything. A person wanting
// to know whether an angle had been tried had nowhere to type the question, and Columbus
// received the same undifferentiated dump whether he was researching Diwali gifting or a
// price-led campaign.
//
// Mani is the librarian on top of that cabinet. He is asked, rather than run.
//
// THE ONE RULE THAT MATTERS: he must never invent. Everything he says gets treated as
// established fact about a client, so a memory agent that confabulates is strictly worse than
// no memory agent — it launders a guess into "what we know about RRO". His soul, his
// guardrails and the checks in this file all point at that single failure mode. An honest
// "we have never recorded that" is the valuable answer, not the disappointing one.
"use strict";
const { supportAgent } = require("./agents/agent-registry");
const { BRAIN_SOUL } = require("./souls-data");

const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 4000;

// The exact words Mani uses when the memory has nothing. Fixed rather than freely worded so
// the caller can detect it — the UI says something different for "nothing recorded" than for
// a real answer, and a run shouldn't paste an empty finding into a brief.
const NOTHING_RECORDED = "NOTHING RECORDED";

function anthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
}

function instructions() {
  const agent = supportAgent("brain");
  return [
    BRAIN_SOUL,
    "",
    `## Objective\n${agent.objective}`,
    `## Guardrails\n${agent.guardrails.map((g) => `- ${g}`).join("\n")}`,
    "",
    "## How to answer",
    "- Answer in a few sentences. You are answering a question, not writing a report.",
    "- Quote the memory where the exact wording matters.",
    "- Attribute: say which kind of material it came from and roughly when.",
    `- If the memory genuinely does not answer the question, reply with exactly: ${NOTHING_RECORDED}`,
    `  Then, on the next line only, name what would need to be recorded for the answer to exist.`,
  ].join("\n");
}

// `memory` is either one brand's composed memory (store.js's loadBrandBrain) or the Hub-wide
// roll-up (hub-memory.js). `scope` says which, because the honest answer differs: with no
// brand named, "I don't have that" often means "ask me about one brand specifically" rather
// than "nobody ever recorded it".
async function askMani({ brandId, brandName, question, memory, scope }, deps = {}) {
  const asked = String(question || "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!asked) throw new Error("Mani needs a question.");

  // No memory is a real answer, and a cheap one — there is nothing to ask a model about.
  if (!memory || !String(memory).trim()) {
    return {
      answer: null,
      grounded: false,
      nothingRecorded: true,
      detail: scope === "hub"
        ? "Nothing is recorded across Hub yet — no active brands with tasks, scanned folders or Visual Studio work."
        : `Nothing has been recorded for ${brandName || brandId} yet. Scan its Drive folder to give Mani something to remember.`,
    };
  }

  let client = deps.client || null;
  if (!client) {
    const apiKey = anthropicApiKey();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required to ask Mani.");
    const Anthropic = require("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey });
  }

  const response = await client.messages.create({
    // Mid tier rather than economy: this one is judgement — deciding what in a long memory
    // actually answers the question, and being honest when none of it does.
    model: process.env.STRATEGY_BRAIN_AGENT_MODEL || process.env.STRATEGY_CLAUDE_MODEL || "claude-opus-5",
    max_tokens: 1200,
    system: instructions(),
    messages: [{
      role: "user",
      content: (scope === "hub"
        ? [
          "You are being asked about Loona as a whole, not one brand.",
          "",
          "Everything Loona has recorded across every active brand:",
          memory,
          "",
          "If answering properly needs depth on one brand, say which brand to ask about rather than guessing.",
          "",
          `Question: ${asked}`,
        ]
        : [
          `Brand: ${brandName || brandId}`,
          "",
          "Everything Loona has recorded about this brand:",
          memory,
          "",
          `Question: ${asked}`,
        ]).join("\n"),
    }],
  });

  const text = (response.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    return { answer: null, grounded: false, nothingRecorded: false, detail: "Mani had nothing to say." };
  }

  // The fixed phrase is how "we never recorded that" stays distinguishable from an answer.
  // Treating it as prose would let an empty result get pasted into a brief as a finding.
  if (text.startsWith(NOTHING_RECORDED)) {
    const missing = text.slice(NOTHING_RECORDED.length).trim();
    return {
      answer: null,
      grounded: true,
      nothingRecorded: true,
      detail: missing || "Nothing in this brand's memory answers that.",
    };
  }

  return { answer: text.slice(0, MAX_ANSWER_CHARS), grounded: true, nothingRecorded: false, scope: scope || "brand" };
}

module.exports = { askMani, instructions, NOTHING_RECORDED, MAX_QUESTION_CHARS };
