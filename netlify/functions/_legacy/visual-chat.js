// Visual Studio's chats.
//
//   POST { action: "create", brandId, title?, actor? } -> { id, chat }
//   POST { action: "list", brandId }                   -> { chats: [...] }
//   POST { action: "history", chatId }                 -> { chat, generations: [...] }
//
// One function rather than three because they're all small and share the same auth and the
// same brand-resolution rule, and every Netlify function is a separately bundled deploy
// artifact — three files here would be three cold starts for what is one screen's worth of
// reads.
//
// "create" is the only place a brandId is ever accepted from the caller: it's the moment the
// chat's brand is decided, and it's validated against Hub before anything is written. From
// then on the chat carries its own brand and nothing else may override it. See
// visual-chats.js's header for why that matters.
"use strict";
const { checkAuthorization } = require("../lib/strategy/auth");
const { createChat, resolveChat, renameChat, listChatsForBrand } = require("../lib/strategy/visual-chats");
const { loadVisualHistory } = require("../lib/strategy/visual-memory");
const { hubBrandExists } = require("../lib/strategy/hub-brands");
const { verifyVisualSession } = require("../lib/strategy/visual-actor");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function fail(statusCode, error) {
  return { statusCode, headers: cors(), body: JSON.stringify({ error }) };
}

function ok(payload) {
  return { statusCode: 200, headers: cors(), body: JSON.stringify(payload) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  const auth = checkAuthorization(event);
  if (!auth.ok && !(await verifyVisualSession(event))) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }
  const action = String(body.action || "").trim();

  if (action === "create" || action === "list") {
    const brandId = String(body.brandId || "").trim();
    if (!/^[a-z0-9-]+$/.test(brandId)) return fail(400, "brandId must be lowercase letters, numbers or hyphens.");
    if (!(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");

    if (action === "list") return ok({ chats: await listChatsForBrand(brandId) });
    const { id, record } = await createChat({ brandId, title: body.title, actor: body.actor || "Hub" });
    return ok({ id, chat: Object.assign({ id }, record) });
  }

  if (action === "rename") {
    const chatId = String(body.chatId || "").trim();
    if (!chatId) return fail(400, "A chatId is required.");
    // Only the title changes. The chat's brand was decided at creation and stays there —
    // a rename must never be a way to move a chat between clients.
    try {
      return ok({ ok: true, chat: Object.assign({ id: chatId }, await renameChat(chatId, body.title)) });
    } catch (error) {
      if (error.notFound) return fail(404, error.message);
      return fail(400, error.message);
    }
  }

  if (action === "history") {
    const chatId = String(body.chatId || "").trim();
    if (!chatId) return fail(400, "A chatId is required.");
    let chat;
    try { chat = await resolveChat(chatId); }
    catch (error) { return fail(error.notFound ? 404 : 502, error.message); }
    // The brand comes from the chat, never from the caller — so a history request can only
    // ever return the rounds belonging to the chat's own brand.
    const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
    const generations = await loadVisualHistory(chat.brandId, { chatId, limit: limit + 1, before: body.before });
    const hasMore = generations.length > limit;
    return ok({ chat: Object.assign({ id: chatId }, chat), generations: generations.slice(0, limit), hasMore });
  }

  return fail(400, 'action must be one of "create", "list", "rename" or "history".');
};
