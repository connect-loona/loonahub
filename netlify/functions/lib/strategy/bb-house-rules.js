// Standing behavioural rules the team has taught BB through ordinary conversation — how she
// should introduce herself, adjust her tone for a specific person, or otherwise carry herself.
// Kept completely separate from Mani's brand memory (mani_brand_notes/*), which is deliberately
// framed to BB as evidence she must never treat as an instruction — a house rule is the
// opposite, it IS an instruction. There is one Hub-wide list, not one per brand: BB's voice and
// self-introduction are the same person regardless of which brand's conversation she's in.
"use strict";
const { fbGet, fbPush } = require("./firebase");

const MAX_RULES = 30;

async function loadHouseRulesText(deps = {}) {
  const get = deps.fbGet || fbGet;
  const raw = (await get("bb_house_rules")) || {};
  const rules = Object.values(raw)
    .filter((entry) => entry && String(entry.content || "").trim())
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-MAX_RULES)
    .map((entry) => `- ${String(entry.content).trim()}`);
  return rules.length ? rules.join("\n") : null;
}

// Best-effort, same reasoning as every other memory write in this codebase — a hiccup saving a
// rule must never surface as a failure to answer the team.
async function saveHouseRuleSafe(content, actor) {
  const text = String(content || "").trim();
  if (!text) return;
  try { await fbPush("bb_house_rules", { content: text, actor: actor || "Team", source: "bb_conversation", createdAt: new Date().toISOString() }); }
  catch (error) { console.error("Could not save a BB house rule:", error.message); }
}

module.exports = { loadHouseRulesText, saveHouseRuleSafe };
