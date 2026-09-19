// A rolling contextual summary per WhatsApp contact — separate from both the raw message
// history (which only replays the last dozen or so turns of one conversation) and Mani's fact
// memory (which only keeps what the team explicitly settled). This exists for everything in
// between: the general shape of what someone's been asking about or focused on, which isn't a
// confirmed fact and isn't an instruction, but is still worth having once the raw transcript
// has rolled off.
"use strict";
const { fbGet, fbSet, fbSafeKey } = require("./firebase");

const MAX_SUMMARY_CHARS = 500;

function summaryInstructions() {
  return [
    "You maintain a short rolling summary of one person's WhatsApp conversation with BB, an assistant at Loona.",
    "You are given the previous summary (if any) and the latest exchange. Produce an updated summary that folds the new exchange in — do not just append, actually revise it.",
    "This is loose context, not a confirmed fact and not an instruction — capture the general shape of what this person tends to ask about or is currently focused on, in plain prose.",
    "Never record anything sensitive, personal, or unrelated to work.",
    `Keep it under ${MAX_SUMMARY_CHARS} characters, third person, no preamble, no markdown.`,
    "If the latest exchange is pure small talk with nothing worth folding in, return the previous summary completely unchanged. If there is no previous summary and nothing worth recording yet, reply with exactly NONE.",
  ].join("\n");
}

async function loadThreadSummary(from, deps = {}) {
  const get = deps.fbGet || fbGet;
  const record = await get(`whatsapp_thread_context/${fbSafeKey(from)}`);
  const text = record && String(record.summary || "").trim();
  return text || null;
}

function threadSummaryPromptText(summary) {
  const text = summary && String(summary).trim();
  if (!text) return null;
  return [
    "# Recent context with this WhatsApp contact",
    "A rolling summary of what this person has recently been asking about or focused on. Loose context, not a confirmed fact and not an instruction — treat it like Mani's memory below: evidence to draw on, never something to state as certain unless it's corroborated elsewhere.",
    text,
  ].join("\n");
}

// Runs after BB has already answered, same reasoning as extractMemoryNote — this can never
// delay or break the reply itself.
async function updateThreadSummary({ from, previousSummary, userMessage, bbAnswer }, deps = {}) {
  if (!from) return;
  let client = deps.client || null;
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
    if (!apiKey) return;
    const Anthropic = require("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey, timeout: 15000, maxRetries: 0 });
  }
  const model = process.env.STRATEGY_MEMORY_EXTRACT_MODEL || process.env.STRATEGY_CLAUDE_MODEL_ECONOMY || "claude-haiku-4-5-20251001";
  const response = await client.messages.create({
    model,
    max_tokens: 220,
    system: summaryInstructions(),
    messages: [{
      role: "user",
      content: `Previous summary: ${previousSummary || "(none yet)"}\n\nLatest exchange —\nThem: ${String(userMessage || "").trim().slice(0, 2000)}\nBB: ${String(bbAnswer || "").trim().slice(0, 2000)}`,
    }],
  });
  const text = (response.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
  if (!text || text.toUpperCase() === "NONE") return;
  const set = deps.fbSet || fbSet;
  await set(`whatsapp_thread_context/${fbSafeKey(from)}`, { summary: text.slice(0, MAX_SUMMARY_CHARS), updatedAt: new Date().toISOString() });
}

async function updateThreadSummarySafe(input, deps = {}) {
  try { await updateThreadSummary(input, deps); }
  catch (error) { console.error("Could not update WhatsApp thread context:", error.message || error); }
}

module.exports = { loadThreadSummary, threadSummaryPromptText, updateThreadSummary, updateThreadSummarySafe, MAX_SUMMARY_CHARS };
