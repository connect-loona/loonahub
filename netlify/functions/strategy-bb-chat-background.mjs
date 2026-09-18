import firebase from "./lib/strategy/firebase.js";
import hubBrands from "./lib/strategy/hub-brands.js";
import store from "./lib/strategy/store.js";
import bbChat from "./lib/strategy/bb-chat.js";
import visualAssets from "./lib/strategy/visual-assets.js";
import maniEvents from "./lib/strategy/mani-events.js";
import apiUsage from "./lib/strategy/api-usage.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";
import Anthropic from "@anthropic-ai/sdk";
import * as OpenAIAgents from "@openai/agents";

globalThis.__anthropicSdkBundled = Anthropic;
globalThis.__openaiAgentsBundled = OpenAIAgents;
const { fbGet, fbPush, fbUpdate } = firebase;
const { findHubBrand } = hubBrands;
const { loadBrandBrain } = store;
const { askBB, MAX_HISTORY_MESSAGES } = bbChat;
const { loadAsset } = visualAssets;
const { recordManiEventSafe } = maniEvents;
const { recordApiUsage } = apiUsage;

// Best-effort, same as every other usage record in this codebase — a failure to log who
// asked BB something must never surface as a failure to answer it.
async function recordBBUsage(turn, brandId, status, provider, model) {
  try {
    await recordApiUsage({
      id: `bb-${brandId}-${turn.clientMessageId || Date.now()}`,
      userId: turn.actorId || null, userEmail: turn.actorEmail || null, userName: turn.actor || "Team",
      identityVerified: Boolean(turn.actorVerified), provider: provider || null, model: model || null,
      feature: "bb_chat", operation: "ask", brandId: brandId === "global" ? null : brandId, status,
    });
  } catch (error) { console.error("Could not record BB usage:", error.message); }
}

export default async function (request) {
  const body = await readSignedBackgroundBody(request, "strategy-bb-chat-background"); if (!body) return;
  const brandId = String(body.brandId || "").trim(); const threadId = String(body.threadId || "main").trim(); const messageId = String(body.clientMessageId || "").trim();
  if (!brandId || !threadId || !messageId) return;
  const path = `strategy_bb_chats/${brandId}/${threadId}/messages`; const messagePath = `${path}/${messageId}`;
  const turn = await fbGet(messagePath); if (!turn || turn.status !== "pending") return;
  try {
    const all = (await fbGet(path)) || {};
    const history = Object.entries(all).filter(([id]) => id !== messageId).map(([, value]) => value).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))).slice(-MAX_HISTORY_MESSAGES);
    const attachments = Array.isArray(turn.attachments) ? turn.attachments : [];
    const visionAttachments = await Promise.all(attachments.map(async (item) => { const stored = await loadAsset(item.assetKey); return stored && stored.metadata.kind === "bb-attachment" && stored.metadata.brandId === brandId ? { data: stored.data, contentType: stored.metadata.contentType, filename: stored.metadata.filename || item.filename } : null; }));
    const global = body.scope === "global"; const brand = global ? null : await findHubBrand(brandId);
    const memory = global ? "This is the Loona Hub-wide conversation. No single brand is selected. Ask which brand a recommendation applies to when that matters, and do not invent cross-brand facts." : await loadBrandBrain(brandId, brand && brand.name);
    const result = await askBB({ brandName: global ? "Loona Hub" : ((brand && brand.name) || brandId), message: turn.text, memory, history, attachments: visionAttachments.filter(Boolean) });
    await fbPush(path, { role: "assistant", text: result.answer, actor: "BB Loona", createdAt: new Date().toISOString(), replyTo: messageId });
    await fbUpdate(messagePath, { status: "answered", error: null });
    await recordBBUsage(turn, brandId, "succeeded", result.provider || "Anthropic", result.model);
    if (!global) { await recordManiEventSafe({ type: "bb_conversation", source: "strategy_os", brandId, actor: turn.actor || "Team", entityType: "bb_chat", entityId: brandId, action: "asked", summary: `Asked BB: ${turn.text}` }); await recordManiEventSafe({ type: "bb_conversation", source: "strategy_os", brandId, actor: "BB Loona", entityType: "bb_chat", entityId: brandId, action: "answered", summary: `BB answered: ${result.answer}` }); }
  } catch (error) {
    await fbUpdate(messagePath, { status: "failed", error: error.message || String(error) });
    await recordBBUsage(turn, brandId, "failed", null, null);
  }
}
export const config = backgroundConfig;
