// POST { brandId, message, actor } -> { answer }
//
// BB is the visible conversational strategist. Mani stays behind the scenes: this endpoint
// composes the same brand memory Mani reads, gives it to BB as grounded context, and keeps a
// persistent per-brand conversation in Firebase.
"use strict";

const { checkAuthorization } = require("../lib/strategy/auth");
const { hubBrandExists } = require("../lib/strategy/hub-brands");
const { fbGet, fbSet, fbUpdate } = require("../lib/strategy/firebase");
const { MAX_MESSAGE_CHARS } = require("../lib/strategy/bb-chat");
const { verifyVisualSession, resolveVisualActor } = require("../lib/strategy/visual-actor");
const { signedBackgroundHeaders } = require("../lib/strategy/background-auth");

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
}
function fail(statusCode, error) { return { statusCode, headers: cors(), body: JSON.stringify({ error }) }; }
function siteBaseUrl(event) {
  const host = (event.headers && (event.headers.host || event.headers.Host || event.headers["x-forwarded-host"])) || "";
  return host ? `${(event.headers && event.headers["x-forwarded-proto"]) || "https"}://${host}` : (process.env.URL || process.env.DEPLOY_URL || "");
}

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
  const action = body.action === "clear" ? "clear" : "ask";
  const threadId = String(body.threadId || "main").trim();
  const clientMessageId = String(body.clientMessageId || "").trim();
  if (scope === "brand" && !/^[a-z0-9-]+$/.test(brandId)) return fail(400, "brandId must be lowercase letters, numbers or hyphens.");
  if (!message) return fail(400, "Ask BB something.");
  if (message.length > MAX_MESSAGE_CHARS) return fail(400, `Keep the message under ${MAX_MESSAGE_CHARS} characters.`);
  if (scope === "brand" && !(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");

  try {
    if (!/^[a-z0-9_-]+$/i.test(threadId)) return fail(400, "Invalid chat thread.");
    const path = `strategy_bb_chats/${brandId}/${threadId}/messages`;
    if (action === "clear") {
      await fbSet(path, null);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
    }
    const now = new Date().toISOString();
    const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 4).map((item) => ({ assetKey: String(item.assetKey || ""), url: String(item.url || ""), filename: String(item.filename || "attachment") })).filter((item) => item.assetKey) : [];
    if (!/^[a-z0-9_-]{8,120}$/i.test(clientMessageId)) return fail(400, "Invalid BB message id.");
    const messagePath = `${path}/${clientMessageId}`;
    const existingMessage = await fbGet(messagePath);
    // A network timeout can happen after the browser has sent the request. Reusing the
    // same client id therefore returns the existing job rather than writing the question
    // a second time and asking BB twice.
    if (existingMessage && existingMessage.role === "user" && existingMessage.status !== "failed") {
      return { statusCode: 202, headers: cors(), body: JSON.stringify({ ok: true, pending: true, messageId: clientMessageId }) };
    }
    // Resolved here, not in the background worker: the Firebase ID token that proves who is
    // really asking only ever arrives on THIS request's Authorization header — the signed
    // background call that follows carries no browser session, so identity has to be
    // captured now and carried on the message record for the worker to attribute usage to
    // later, once it knows whether the call to BB actually succeeded.
    const identity = await resolveVisualActor(event, actor);
    await fbSet(messagePath, { role: "user", text: message, attachments, actor, actorId: identity.id, actorEmail: identity.email, actorVerified: identity.verified, createdAt: now, clientMessageId, status: "pending", error: null });
    await fbUpdate(`strategy_bb_chats/${brandId}/threads/${threadId}`, { title: message.slice(0, 60), updatedAt: now, createdAt: now });
    const backgroundBody = JSON.stringify({ brandId, scope, threadId, clientMessageId });
    try {
      const response = await fetch(`${siteBaseUrl(event)}/.netlify/functions/strategy-bb-chat-background`, { method: "POST", headers: signedBackgroundHeaders("strategy-bb-chat-background", backgroundBody), body: backgroundBody });
      if (!response.ok) throw new Error(`Background BB request was rejected (HTTP ${response.status}).`);
    } catch (error) {
      await fbUpdate(messagePath, { status: "failed", error: `Could not start BB: ${error.message || error}` });
      return fail(502, `Could not start BB: ${error.message || error}`);
    }
    return { statusCode: 202, headers: cors(), body: JSON.stringify({ ok: true, pending: true, messageId: clientMessageId }) };
  } catch (error) {
    return fail(502, error.message || "BB could not start.");
  }
};
