// GET  -> Meta's one-time webhook verification handshake.
// POST -> an inbound WhatsApp message. Signed, gated to an internal allowlist, then handed
// to a background function so this request can return to Meta immediately — Meta redelivers
// a webhook it doesn't get a fast 200 for, and BB's own answer can take several seconds.
"use strict";
const { verifySignature, isAllowedNumber, extractIncomingText } = require("../lib/strategy/whatsapp");
const { signedBackgroundHeaders } = require("../lib/strategy/background-auth");

function siteBaseUrl(event) {
  const host = (event.headers && (event.headers.host || event.headers["x-forwarded-host"])) || "";
  return host ? `${(event.headers && event.headers["x-forwarded-proto"]) || "https"}://${host}` : (process.env.URL || process.env.DEPLOY_URL || "");
}

const ACK = { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] && q["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: q["hub.challenge"] || "" };
    }
    return { statusCode: 403, headers: { "Content-Type": "text/plain" }, body: "Verification failed." };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Method not allowed" }) };

  const signature = (event.headers && (event.headers["x-hub-signature-256"] || event.headers["X-Hub-Signature-256"])) || "";
  if (!verifySignature(event.body || "", signature, process.env.WHATSAPP_APP_SECRET)) {
    console.error("whatsapp-webhook: rejected an inbound POST with an invalid or missing signature.");
    return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid signature" }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { return ACK; } // Meta still expects 200 for a payload it can't use.

  const incoming = extractIncomingText(payload);
  if (!incoming) {
    console.log("whatsapp-webhook: no actionable text message in this payload (status callback or unsupported message type).");
    return ACK;
  }
  // Not on the internal allowlist — acknowledge and do nothing more.
  if (!isAllowedNumber(incoming.from, process.env.WHATSAPP_ALLOWED_NUMBERS)) {
    console.log(`whatsapp-webhook: message from ${incoming.from} ignored — not on WHATSAPP_ALLOWED_NUMBERS.`);
    return ACK;
  }
  console.log(`whatsapp-webhook: message from ${incoming.from} accepted, handing off to BB.`);

  const backgroundBody = JSON.stringify(incoming);
  try {
    const response = await fetch(`${siteBaseUrl(event)}/.netlify/functions/whatsapp-bb-reply-background`, {
      method: "POST",
      headers: signedBackgroundHeaders("whatsapp-bb-reply-background", backgroundBody),
      body: backgroundBody,
    });
    if (!response.ok) console.error(`whatsapp-bb-reply-background rejected (HTTP ${response.status}).`);
  } catch (error) {
    console.error(`Could not start whatsapp-bb-reply-background: ${error.message || error}`);
  }
  return ACK;
};
