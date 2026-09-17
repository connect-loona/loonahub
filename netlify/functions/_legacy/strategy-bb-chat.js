// POST { brandId, message, actor } -> { answer }
//
// BB is the visible conversational strategist. Mani stays behind the scenes: this endpoint
// composes the same brand memory Mani reads, gives it to BB as grounded context, and keeps a
// persistent per-brand conversation in Firebase.
"use strict";

const { checkAuthorization } = require("../lib/strategy/auth");
const { hubBrandExists, findHubBrand } = require("../lib/strategy/hub-brands");
const { loadBrandBrain } = require("../lib/strategy/store");
const { fbGet, fbPush } = require("../lib/strategy/firebase");
const { askBB, MAX_MESSAGE_CHARS, MAX_HISTORY_MESSAGES } = require("../lib/strategy/bb-chat");
const { recordManiEventSafe } = require("../lib/strategy/mani-events");

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
}
function fail(statusCode, error) { return { statusCode, headers: cors(), body: JSON.stringify({ error }) }; }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }
  const brandId = String(body.brandId || "").trim();
  const message = String(body.message || "").trim();
  const actor = String(body.actor || "Team").trim().slice(0, 120) || "Team";
  if (!/^[a-z0-9-]+$/.test(brandId)) return fail(400, "brandId must be lowercase letters, numbers or hyphens.");
  if (!message) return fail(400, "Ask BB something.");
  if (message.length > MAX_MESSAGE_CHARS) return fail(400, `Keep the message under ${MAX_MESSAGE_CHARS} characters.`);
  if (!(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");

  try {
    const brand = await findHubBrand(brandId);
    const path = `strategy_bb_chats/${brandId}/messages`;
    const existing = (await fbGet(path)) || {};
    const history = Object.values(existing)
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
      .slice(-MAX_HISTORY_MESSAGES);
    const now = new Date().toISOString();
    await fbPush(path, { role: "user", text: message, actor, createdAt: now });
    // Load Mani's memory before recording this turn so the current question is not fed
    // back to BB twice (once as the user message and once as a timeline event).
    const memory = await loadBrandBrain(brandId, brand && brand.name);
    const result = await askBB({ brandName: (brand && brand.name) || brandId, message, memory, history });
    await fbPush(path, { role: "assistant", text: result.answer, actor: "BB Loona", createdAt: new Date().toISOString() });
    await recordManiEventSafe({ type: "bb_conversation", source: "strategy_os", brandId, actor, entityType: "bb_chat", entityId: brandId, action: "asked", summary: `Asked BB: ${message}` });
    await recordManiEventSafe({ type: "bb_conversation", source: "strategy_os", brandId, actor: "BB Loona", entityType: "bb_chat", entityId: brandId, action: "answered", summary: `BB answered: ${result.answer}` });
    return { statusCode: 200, headers: cors(), body: JSON.stringify(result) };
  } catch (error) {
    const missingKey = /ANTHROPIC_API_KEY/.test(error.message || "");
    return fail(missingKey ? 503 : 502, error.message || "BB could not answer.");
  }
};
