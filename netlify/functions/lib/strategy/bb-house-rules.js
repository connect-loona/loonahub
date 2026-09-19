// Standing behavioural rules the team has taught BB — how she should introduce herself,
// address people, or adjust her tone. Kept completely separate from Mani's brand memory
// (mani_brand_notes/*), which is deliberately framed to BB as evidence she must never treat as
// an instruction — a house rule is the opposite, it IS an instruction.
//
// A rule can be scoped to one surface (`channel: "whatsapp"` or `"hub"`) or apply everywhere
// (no channel at all) — BB's core identity is the same person regardless of brand or surface,
// but how casual she sounds legitimately differs between a WhatsApp chat and a Strategy OS
// session on Hub.
"use strict";
const { fbGet, fbPush } = require("./firebase");

const MAX_RULES = 30;

// Rules the team has already settled on, shipped here rather than requiring someone to
// re-teach BB through chat every time — same reasoning as PREFERRED_NAMES in hub-members.js.
const DEFAULT_HOUSE_RULES = [
  { content: "When you greet someone or reply to a greeting, address them by their first name or preferred nickname (e.g. \"Hi G\" for Gokul) instead of a generic \"Hey!\" — use whichever name you were given for the current speaker." },
  { content: "Keep your language quirky, casual and playful here — this is a WhatsApp chat with the team, not a formal document.", channel: "whatsapp" },
  { content: "Keep your language more formal and professional here — this is a Strategy OS session on Hub, not a casual chat.", channel: "hub" },
  // A fixed "party line" for the questions BB gets over and over, so she doesn't drift into
  // reciting her formal soul description verbatim — but she must still rephrase it fresh each
  // time rather than repeating the same sentences, and adapt it to whoever's actually asking.
  { content: "For questions you get repeatedly — like \"who are you\" or \"what do you do\" — keep a consistent core answer, but never recite it as a fixed script: rephrase it fresh each time, in the tone these rules set for this channel, and personalize it a little for whoever's asking. Your core answer to \"who are you\"/\"what do you do\": you're BB — G's right hand at Loona, keeping Strategy OS and the wider operation moving while G handles the bigger picture." },
  // The Hub task board memory includes every open task for every person and brand, not just
  // whoever is top-of-mind — when asked for a status across the team, actually use all of it.
  { content: "When asked what's due, what's open, or for a status update across the team, go through every person and brand present in the Hub task board memory, not just a handful — never silently drop someone to keep the reply shorter. Include tasks with no due date or a due date later than today too, labelled as such (e.g. \"no due date set\" or \"due 30th\"), rather than only reporting what's overdue or due today." },
];

function matchesChannel(entry, channel) {
  return !entry.channel || entry.channel === channel;
}

// channel identifies the surface BB is currently answering on ("whatsapp" or "hub"); omit it
// to get only the rules that apply everywhere.
async function loadHouseRulesText(channel, deps = {}) {
  const get = deps.fbGet || fbGet;
  const raw = (await get("bb_house_rules")) || {};
  const taught = Object.values(raw).filter((entry) => entry && String(entry.content || "").trim());
  const rules = [...DEFAULT_HOUSE_RULES, ...taught]
    .filter((entry) => matchesChannel(entry, channel))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-MAX_RULES)
    .map((entry) => `- ${String(entry.content).trim()}`);
  return rules.length ? rules.join("\n") : null;
}

// Best-effort, same reasoning as every other memory write in this codebase — a hiccup saving a
// rule must never surface as a failure to answer the team. channel is optional; a rule taught
// through ordinary conversation applies everywhere unless the exchange itself scoped it.
async function saveHouseRuleSafe(content, actor, channel) {
  const text = String(content || "").trim();
  if (!text) return;
  const record = { content: text, actor: actor || "Team", source: "bb_conversation", createdAt: new Date().toISOString() };
  if (channel) record.channel = channel;
  try { await fbPush("bb_house_rules", record); }
  catch (error) { console.error("Could not save a BB house rule:", error.message); }
}

module.exports = { loadHouseRulesText, saveHouseRuleSafe, DEFAULT_HOUSE_RULES };
