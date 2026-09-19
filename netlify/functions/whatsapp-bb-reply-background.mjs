import firebase from "./lib/strategy/firebase.js";
import store from "./lib/strategy/store.js";
import bbChat from "./lib/strategy/bb-chat.js";
import bbHouseRules from "./lib/strategy/bb-house-rules.js";
import whatsappThreadMemory from "./lib/strategy/whatsapp-thread-memory.js";
import bbIntroductions from "./lib/strategy/bb-introductions.js";
import whatsapp from "./lib/strategy/whatsapp.js";
import apiUsage from "./lib/strategy/api-usage.js";
import hubMembers from "./lib/strategy/hub-members.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";
// Via the shim, never lib/strategy/visual-assets.js directly — see
// strategy-bb-chat-background.mjs's own note on this for why: only the shim statically
// imports @netlify/blobs and configures the store, and this file now needs saveBBAttachment
// to persist a WhatsApp image/PDF the same durable way Ask BB's own uploads are stored.
import visualAssets from "./_shared/visual-blob-store.mjs";
import Anthropic from "@anthropic-ai/sdk";
import * as OpenAIAgents from "@openai/agents";

globalThis.__anthropicSdkBundled = Anthropic;
globalThis.__openaiAgentsBundled = OpenAIAgents;
const { fbGet, fbSet, fbUpdate, fbPush, fbSafeKey } = firebase;
const { loadGlobalBrain } = store;
const { askBB, extractMemoryNoteSafe, MAX_HISTORY_MESSAGES } = bbChat;
const { loadHouseRulesText, saveHouseRuleSafe } = bbHouseRules;
const { loadThreadSummary, threadSummaryPromptText, updateThreadSummarySafe } = whatsappThreadMemory;
const { hasMetSafe, markMetSafe, introductionPromptText } = bbIntroductions;
const { sendWhatsAppText, fetchWhatsAppMedia } = whatsapp;
const { recordApiUsage } = apiUsage;
const { findHubMemberByPhone } = hubMembers;
const { SAFE_BB_ATTACHMENT_TYPES, MAX_BB_ATTACHMENT_BYTES, saveBBAttachment } = visualAssets;

// WhatsApp's own contactName is whatever the sender set as their profile display name — not
// a verified identity, and not necessarily even the right person (a repurposed phone can keep
// its previous owner's profile name for years). Hub's own /members roster, matched by mobile
// number, is the only signal BB should actually trust when someone asks "do you know who I
// am" — this is what caused the exact mixup that prompted adding it: BB confidently named a
// teammate based on nothing more than that name appearing elsewhere in Hub-wide memory.
async function resolveSpeaker(from, contactName) {
  const hubMatch = await findHubMemberByPhone(from).catch(() => null);
  // rosterName carries through even though nothing here reads it directly — it's how
  // askBB() knows who to actually book a meeting or attribute a task write as, since a
  // nickname like "G" (see PREFERRED_NAMES in hub-members.js) is what BB calls someone in
  // conversation, not their real /members roster entry.
  if (hubMatch) return { name: hubMatch.name, rosterName: hubMatch.rosterName, verified: true };
  return { name: contactName || null, verified: false };
}

// Same shape strategy-mani-memory.js writes for a team-pasted note, so loadGlobalBrain picks
// this up the same way — just tagged by source, since there's no separate read path for it.
async function saveMemoryNoteSafe(content, actor) {
  try { await fbPush("mani_brand_notes/global", { content, source: "bb_conversation", actor, createdAt: new Date().toISOString() }); }
  catch (error) { console.error("Could not save an extracted memory note:", error.message); }
}

// Best-effort, same as every other usage record in this codebase. WhatsApp senders have no
// Hub sign-in to verify, so identity here is never "verified" — but the phone number itself
// is a stable id, so the same person's messages still group together in the usage table
// instead of all landing in one shapeless "unverified" bucket.
async function recordWhatsAppBBUsage(from, speaker, messageId, status, provider, model) {
  try {
    await recordApiUsage({
      id: `whatsapp-bb-${messageId}`,
      userId: `whatsapp:${from}`, userEmail: null, userName: (speaker && speaker.name) || `WhatsApp +${from}`,
      identityVerified: Boolean(speaker && speaker.verified), provider: provider || null, model: model || null,
      feature: "bb_chat", operation: "ask", brandId: null, status,
    });
  } catch (error) { console.error("Could not record WhatsApp BB usage:", error.message); }
}

// Matches the disclaimer strategy-bb-chat-background.mjs gives BB for the browser's own
// "Global BB conversation" — WhatsApp reaches the exact same global thread space, just
// keyed by phone number instead of a browser-generated thread id, so BB should behave
// identically either way.
const GLOBAL_MEMORY_NOTE = "This is the Loona Hub-wide conversation. No single brand is selected. Ask which brand a recommendation applies to when that matters, and do not invent cross-brand facts.";

// Downloads, validates and durably stores an image or PDF someone sent BB on WhatsApp —
// captioning a creative, reading a screenshot of a client chat, checking a PDF brief. Two
// outcomes on top of success: a known, explainable limit (wrong file type, too large) gets
// its own short reply rather than being asked of the model at all, since there is nothing
// for BB to usefully say about a file she was never going to be able to open; anything else
// (Meta's API itself failing) is left to throw, for the caller's existing catch-and-log path.
async function resolveWhatsAppMedia(body, deps = {}) {
  const fetchMedia = deps.fetchWhatsAppMedia || fetchWhatsAppMedia;
  const saveAttachment = deps.saveBBAttachment || saveBBAttachment;
  const { buffer, contentType } = await fetchMedia({ mediaId: body.mediaId, accessToken: process.env.WHATSAPP_ACCESS_TOKEN });
  const effectiveType = contentType || String(body.mimeType || "").toLowerCase();
  if (!SAFE_BB_ATTACHMENT_TYPES.has(effectiveType)) {
    return { reply: "I can only read images (PNG/JPEG/WebP/GIF) and PDFs here — that file type isn't one I can open. 🦦" };
  }
  if (buffer.length > MAX_BB_ATTACHMENT_BYTES) {
    return { reply: "That file's bigger than the 10MB I can read — could you send a smaller version? 🦦" };
  }
  const filename = body.filename || (effectiveType.startsWith("image/") ? "photo.jpg" : "document.pdf");
  const asset = await saveAttachment({ buffer, contentType: effectiveType, brandId: "global", filename });
  return {
    attachment: { data: buffer, contentType: effectiveType, filename },
    record: { assetKey: asset.assetKey, filename },
  };
}

// What to actually ask BB when an image/PDF arrived with nothing typed alongside it — a bare
// screenshot or PDF is a normal thing to send, and she needs some instruction to respond to
// rather than an empty message askBB would otherwise reject outright.
function captionOrDefault(text, contentType) {
  if (text) return text;
  return contentType === "application/pdf"
    ? "(Sent a PDF with no message — take a look and tell me what it's about.)"
    : "(Sent an image with no caption — take a look and tell me what you make of it, or write a caption for it if that's what this looks like.)";
}

export default async function (request) {
  const body = await readSignedBackgroundBody(request, "whatsapp-bb-reply-background");
  if (!body) return;
  const from = String(body.from || "").trim();
  const messageId = String(body.messageId || "").trim();
  const mediaId = String(body.mediaId || "").trim();
  // A media message can arrive with no caption at all — that is still something to answer,
  // so only a message with neither text nor an attachment is nothing for BB to act on.
  const text = String(body.text || "").trim();
  if (!from || !messageId || (!text && !mediaId)) return;

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

  const speaker = await resolveSpeaker(from, body.contactName);
  const now = new Date().toISOString();
  const actor = speaker.name || `WhatsApp +${from}`;
  const replyCreds = { accessToken: process.env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID };

  // A caption-less attachment gets a plain placeholder recorded rather than an empty string,
  // so the Mani thread viewer shows something readable instead of a blank bubble.
  const recordedText = text || (mediaId ? (String(body.mimeType || "").startsWith("image/") ? "[image]" : "[document]") : text);
  await fbSet(messagePath, { role: "user", text: recordedText, actor, actorVerified: speaker.verified, createdAt: now, status: "pending" });
  await fbUpdate(`strategy_bb_chats/global/threads/${threadId}`, { title: `WhatsApp — ${actor}`, updatedAt: now, createdAt: now });

  let visionAttachment = null;
  if (mediaId) {
    let media;
    try {
      media = await resolveWhatsAppMedia({ ...body, mediaId });
    } catch (error) {
      console.error("Could not fetch WhatsApp media:", error.message);
      await fbUpdate(messagePath, { status: "failed", error: error.message || String(error) });
      await sendWhatsAppText({ to: from, text: "I couldn't download that from WhatsApp just now — mind resending it? 🦦", ...replyCreds }).catch(() => {});
      return;
    }
    // A wrong file type or an oversized file is a known, explainable limit — reply directly
    // rather than spending a model call on a file BB was never going to be able to open. This
    // send is wrapped the same as every other one in this file: if it fails, the message must
    // land on "failed" rather than being left stuck on "pending" forever.
    if (media.reply) {
      try {
        await sendWhatsAppText({ to: from, text: media.reply, ...replyCreds });
        await fbUpdate(messagePath, { status: "answered", error: null });
      } catch (error) {
        await fbUpdate(messagePath, { status: "failed", error: error.message || String(error) });
      }
      return;
    }
    await fbUpdate(messagePath, { attachments: [media.record] });
    visionAttachment = media.attachment;
  }

  const askedText = captionOrDefault(text, visionAttachment && visionAttachment.contentType);

  try {
    const all = (await fbGet(path)) || {};
    const history = Object.entries(all)
      .filter(([id]) => id !== messageKey)
      .map(([, value]) => value)
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
      .slice(-MAX_HISTORY_MESSAGES);
    const [globalBrain, houseRules, previousThreadSummary, alreadyMet] = await Promise.all([
      loadGlobalBrain(),
      loadHouseRulesText("whatsapp").catch((error) => { console.error("Could not load BB's house rules:", error.message); return null; }),
      loadThreadSummary(from).catch((error) => { console.error("Could not load WhatsApp thread context:", error.message); return null; }),
      hasMetSafe(from),
    ]);
    const memory = [GLOBAL_MEMORY_NOTE, globalBrain, threadSummaryPromptText(previousThreadSummary)].filter(Boolean).join("\n\n");
    const introduction = alreadyMet ? null : introductionPromptText(speaker);
    // Task-board and calendar actions on WhatsApp too, not just Hub — resolveSpeaker() above
    // only ever verifies against Hub's own /members roster by phone, the same identity signal
    // Hub's own login gives askBB, so a WhatsApp-confirmed write (or a WhatsApp-confirmed
    // meeting booked as that verified person) is exactly as trustworthy as one confirmed on Hub.
    const result = await askBB({ brandName: "Loona Hub", message: askedText, memory, history, attachments: visionAttachment ? [visionAttachment] : [], speaker, houseRules, introduction, taskActions: true, calendarActions: true, emailActions: true });
    await sendWhatsAppText({ to: from, text: result.answer, ...replyCreds });
    // Only once the introduction has actually reached them — recording the meeting any
    // earlier would quietly cost this person the only first greeting they ever get.
    if (introduction) await markMetSafe(from, speaker);
    await fbUpdate(messagePath, { status: "answered", error: null });
    await fbSet(`${path}/${messageKey}-reply`, { role: "assistant", text: result.answer, actor: "BB Loona", createdAt: new Date().toISOString(), replyTo: messageKey });
    await recordWhatsAppBBUsage(from, speaker, messageId, "succeeded", result.provider || "Anthropic", result.model);
    const note = await extractMemoryNoteSafe({ userMessage: askedText, bbAnswer: result.answer });
    if (note && note.type === "rule") await saveHouseRuleSafe(note.text, actor);
    else if (note) await saveMemoryNoteSafe(note.text, actor);
    await updateThreadSummarySafe({ from, previousSummary: previousThreadSummary, userMessage: askedText, bbAnswer: result.answer });
  } catch (error) {
    await fbUpdate(messagePath, { status: "failed", error: error.message || String(error) });
    await recordWhatsAppBBUsage(from, speaker, messageId, "failed", null, null);
  }
}
export const config = backgroundConfig;
// Named exports purely for direct testing — resolveWhatsAppMedia's dependency injection
// (fetchWhatsAppMedia/saveBBAttachment) lets its validation branches (unsupported type,
// oversized file, a genuine download failure) be exercised without touching WhatsApp's or
// Netlify Blobs' real APIs, the same pattern the rest of this codebase uses throughout.
export { resolveWhatsAppMedia, captionOrDefault };
