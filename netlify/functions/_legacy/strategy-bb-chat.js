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
const { loadAsset } = require("../lib/strategy/visual-assets");
const { verifyVisualSession } = require("../lib/strategy/visual-actor");

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
}
function fail(statusCode, error) { return { statusCode, headers: cors(), body: JSON.stringify({ error }) }; }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  const auth = checkAuthorization(event);
  if (!auth.ok && !(await verifyVisualSession(event))) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }
  const scope = body.scope === "global" ? "global" : "brand";
  const brandId = scope === "global" ? "global" : String(body.brandId || "").trim();
  const message = String(body.message || "").trim();
  const actor = String(body.actor || "Team").trim().slice(0, 120) || "Team";
  if (scope === "brand" && !/^[a-z0-9-]+$/.test(brandId)) return fail(400, "brandId must be lowercase letters, numbers or hyphens.");
  if (!message) return fail(400, "Ask BB something.");
  if (message.length > MAX_MESSAGE_CHARS) return fail(400, `Keep the message under ${MAX_MESSAGE_CHARS} characters.`);
  if (scope === "brand" && !(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");

  try {
    const brand = scope === "brand" ? await findHubBrand(brandId) : null;
    const path = `strategy_bb_chats/${brandId}/messages`;
    const existing = (await fbGet(path)) || {};
    const history = Object.values(existing)
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
      .slice(-MAX_HISTORY_MESSAGES);
    const now = new Date().toISOString();
    const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 4).map((item) => ({ assetKey: String(item.assetKey || ""), url: String(item.url || ""), filename: String(item.filename || "attachment") })).filter((item) => item.assetKey) : [];
    const visionAttachments = await Promise.all(attachments.map(async (item) => {
      const stored = await loadAsset(item.assetKey);
      if (!stored || stored.metadata.kind !== "bb-attachment" || stored.metadata.brandId !== brandId) return null;
      return { data: stored.data, contentType: stored.metadata.contentType, filename: stored.metadata.filename || item.filename };
    }));
    await fbPush(path, { role: "user", text: message, attachments, actor, createdAt: now });
    // Load Mani's memory before recording this turn so the current question is not fed
    // back to BB twice (once as the user message and once as a timeline event).
    const memory = scope === "brand" ? await loadBrandBrain(brandId, brand && brand.name) : "This is the Loona Hub-wide conversation. No single brand is selected. Ask which brand a recommendation applies to when that matters, and do not invent cross-brand facts.";
    const result = await askBB({ brandName: scope === "global" ? "Loona Hub" : ((brand && brand.name) || brandId), message, memory, history, attachments: visionAttachments.filter(Boolean) });
    await fbPush(path, { role: "assistant", text: result.answer, actor: "BB Loona", createdAt: new Date().toISOString() });
    if (scope === "brand") {
      await recordManiEventSafe({ type: "bb_conversation", source: "strategy_os", brandId, actor, entityType: "bb_chat", entityId: brandId, action: "asked", summary: `Asked BB: ${message}` });
      await recordManiEventSafe({ type: "bb_conversation", source: "strategy_os", brandId, actor: "BB Loona", entityType: "bb_chat", entityId: brandId, action: "answered", summary: `BB answered: ${result.answer}` });
    }
    return { statusCode: 200, headers: cors(), body: JSON.stringify(result) };
  } catch (error) {
    const missingKey = /ANTHROPIC_API_KEY/.test(error.message || "");
    return fail(missingKey ? 503 : 502, error.message || "BB could not answer.");
  }
};
