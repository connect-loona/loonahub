import firebase from "./lib/strategy/firebase.js";
import bbChat from "./lib/strategy/bb-chat.js";
import whatsapp from "./lib/strategy/whatsapp.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";
import Anthropic from "@anthropic-ai/sdk";
import * as OpenAIAgents from "@openai/agents";

globalThis.__anthropicSdkBundled = Anthropic;
globalThis.__openaiAgentsBundled = OpenAIAgents;
const { fbGet, fbSet, fbUpdate, fbSafeKey } = firebase;
const { askBB, MAX_HISTORY_MESSAGES } = bbChat;
const { sendWhatsAppText } = whatsapp;

// Matches the disclaimer strategy-bb-chat-background.mjs gives BB for the browser's own
// "Global BB conversation" — WhatsApp reaches the exact same global thread space, just
// keyed by phone number instead of a browser-generated thread id, so BB should behave
// identically either way.
const GLOBAL_MEMORY_NOTE = "This is the Loona Hub-wide conversation. No single brand is selected. Ask which brand a recommendation applies to when that matters, and do not invent cross-brand facts.";

export default async function (request) {
  const body = await readSignedBackgroundBody(request, "whatsapp-bb-reply-background");
  if (!body) return;
  const from = String(body.from || "").trim();
  const text = String(body.text || "").trim();
  const messageId = String(body.messageId || "").trim();
  if (!from || !text || !messageId) return;

  // Reusing strategy_bb_chats/global/ (rather than a separate WhatsApp-only tree) means
  // these conversations show up in Strategy OS's own "Global BB" thread list for free —
  // one phone number is one thread, sorted alongside every browser-started global thread.
  const threadId = `whatsapp-${from}`;
  const path = `strategy_bb_chats/global/${threadId}/messages`;
  const messageKey = fbSafeKey(messageId);
  const messagePath = `${path}/${messageKey}`;

  // Meta redelivers a webhook it didn't get a fast enough 200 for. Skip anything already
  // recorded instead of asking BB the same question twice and double-texting the reply.
  if (await fbGet(messagePath)) return;

  const now = new Date().toISOString();
  const actor = body.contactName || `WhatsApp +${from}`;
  await fbSet(messagePath, { role: "user", text, actor, createdAt: now, status: "pending" });
  await fbUpdate(`strategy_bb_chats/global/threads/${threadId}`, { title: `WhatsApp — ${body.contactName || from}`, updatedAt: now, createdAt: now });

  try {
    const all = (await fbGet(path)) || {};
    const history = Object.entries(all)
      .filter(([id]) => id !== messageKey)
      .map(([, value]) => value)
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
      .slice(-MAX_HISTORY_MESSAGES);
    const result = await askBB({ brandName: "Loona Hub", message: text, memory: GLOBAL_MEMORY_NOTE, history, attachments: [] });
    await sendWhatsAppText({ to: from, text: result.answer, accessToken: process.env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID });
    await fbUpdate(messagePath, { status: "answered", error: null });
    await fbSet(`${path}/${messageKey}-reply`, { role: "assistant", text: result.answer, actor: "BB Loona", createdAt: new Date().toISOString(), replyTo: messageKey });
  } catch (error) {
    await fbUpdate(messagePath, { status: "failed", error: error.message || String(error) });
  }
}
export const config = backgroundConfig;
