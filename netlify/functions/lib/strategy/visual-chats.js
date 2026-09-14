// Visual Studio's conversations.
//
// A brand is a project; a project holds many chats; a chat holds the rounds of generation that
// happened inside it. That shape is the whole point of Visual Studio rather than a one-shot
// image form: the way this team actually works is a running conversation against a reference
// ("now make the table warmer", "same model, new angle"), and the thread is what carries the
// references and the intent from one round to the next.
//
// THE IMPORTANT RULE HERE IS THE BRAND JOIN, AND IT IS A SECURITY RULE, NOT A CONVENIENCE.
// A chat records which brand it belongs to when it is created, once. Every later call names
// only the chat, and the brand is read back out of the stored chat record — never taken from
// the caller. If the browser could say "generate into chat X, and by the way that's brand Y",
// then one client's references, prompts and brand memory could be written into another
// client's project by nothing more than a wrong id in a request body. Resolving server-side
// makes that unrepresentable rather than merely discouraged.
"use strict";
const { fbGet, fbSet, fbPush, fbSafeKey } = require("./firebase");

const MAX_TITLE_CHARS = 120;
const MAX_CHATS_LISTED = 60;

function chatPath(chatId) {
  return `visual_chats/${fbSafeKey(chatId)}`;
}

// A chat's title is the first thing someone typed in it, trimmed to something that fits a
// sidebar — the same trick ChatGPT uses, and it beats making people name a thread up front
// before they know what it's going to be.
function titleFromPrompt(prompt) {
  const clean = String(prompt || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled visual chat";
  if (clean.length <= 48) return clean;
  // Cut at a word boundary rather than mid-word when there is one close to the limit.
  const cut = clean.slice(0, 48);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

async function createChat({ brandId, title, actor }) {
  if (!brandId) throw new Error("createChat needs a brandId.");
  const record = {
    brandId,
    title: String(title || "Untitled visual chat").slice(0, MAX_TITLE_CHARS),
    createdAt: new Date().toISOString(),
    createdBy: actor || "unknown",
    lastActivityAt: new Date().toISOString(),
    generationCount: 0,
  };
  const id = await fbPush("visual_chats", record);
  return { id, record };
}

// The one function that answers "which brand is this chat for?". Everything that writes into a
// chat goes through it, so there is exactly one place where that question is decided and it is
// never the request body.
async function resolveChat(chatId) {
  if (!chatId) throw new Error("A chatId is required.");
  const chat = await fbGet(chatPath(chatId));
  if (!chat || !chat.brandId) {
    const error = new Error(`No visual chat ${chatId}.`);
    error.notFound = true;
    throw error;
  }
  return chat;
}

// Bumped whenever a round lands in the chat, so the sidebar can order by what's actually
// alive rather than by when someone happened to open a thread.
async function touchChat(chatId, { titleIfUnset } = {}) {
  const chat = await fbGet(chatPath(chatId));
  if (!chat) return null;
  const updated = Object.assign({}, chat, {
    lastActivityAt: new Date().toISOString(),
    generationCount: Number(chat.generationCount || 0) + 1,
  });
  // A chat created before anybody typed anything gets named by its first real prompt.
  if (titleIfUnset && (!chat.title || chat.title === "Untitled visual chat")) {
    updated.title = String(titleIfUnset).slice(0, MAX_TITLE_CHARS);
  }
  await fbSet(chatPath(chatId), updated);
  return updated;
}

// Renaming a chat. Only the title moves: the brand a chat belongs to is decided once, at
// creation, and nothing here may touch it — a rename that could also reassign the brand would
// be the same cross-client hole this file exists to close.
async function renameChat(chatId, title) {
  const clean = String(title || "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("A chat needs a name.");
  const chat = await fbGet(chatPath(chatId));
  if (!chat) {
    const error = new Error(`No visual chat ${chatId}.`);
    error.notFound = true;
    throw error;
  }
  const updated = Object.assign({}, chat, { title: clean.slice(0, MAX_TITLE_CHARS) });
  await fbSet(chatPath(chatId), updated);
  return updated;
}

// A brand's chats, newest activity first. Filtered server-side by the brandId stored on each
// chat — same rule as everywhere else in this file.
async function listChatsForBrand(brandId) {
  const raw = (await fbGet("visual_chats")) || {};
  return Object.entries(raw)
    .filter(([, chat]) => chat && chat.brandId === brandId)
    .map(([id, chat]) => Object.assign({ id }, chat))
    .sort((a, b) => String(b.lastActivityAt || b.createdAt || "").localeCompare(String(a.lastActivityAt || a.createdAt || "")))
    .slice(0, MAX_CHATS_LISTED);
}

module.exports = {
  createChat, resolveChat, touchChat, renameChat, listChatsForBrand, titleFromPrompt, chatPath,
  MAX_TITLE_CHARS,
};
