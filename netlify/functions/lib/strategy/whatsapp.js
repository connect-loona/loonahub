// BB on WhatsApp — Meta's WhatsApp Cloud API talking to the same global BB that already
// answers the "Global BB conversation" in Strategy OS. See netlify.toml for the one-time
// Meta for Developers setup and the env vars this depends on.
"use strict";
const crypto = require("crypto");

const WHATSAPP_API_VERSION = "v20.0";
// Meta's own hard limit on a single text message body.
const WHATSAPP_TEXT_LIMIT = 4096;

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

// Meta signs every webhook POST with the app secret (HMAC-SHA256 over the exact raw request
// body) so a request can be trusted as a real Meta delivery before anything in it is acted
// on — the same shape as this repo's own signedBackgroundHeaders, just Meta's header name
// and "sha256=<hex>" format instead of ours.
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return false;
  const header = String(signatureHeader || "");
  if (!header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody || "", "utf8").digest("hex");
  let expectedBuf, providedBuf;
  try {
    expectedBuf = Buffer.from(expected, "hex");
    providedBuf = Buffer.from(header.slice("sha256=".length), "hex");
  } catch { return false; }
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Internal-team gate: only numbers named in WHATSAPP_ALLOWED_NUMBERS may reach BB. Compared
// on digits only so "+91 98765 43210", "919876543210" and "91-9876543210" in the env var all
// match the plain digit string Meta actually sends as the sender id.
function isAllowedNumber(from, allowlist) {
  const wanted = digitsOnly(from);
  if (!wanted) return false;
  const numbers = String(allowlist || "").split(",").map(digitsOnly).filter(Boolean);
  return numbers.includes(wanted);
}

// Meta posts more than plain text messages through this one webhook path — delivery status
// callbacks (sent/delivered/read) and other message types carry no `messages[].text`, and
// are not a question for BB. Returns null for anything that isn't a real inbound text
// message, so the caller has one place to decide "is there something to answer here".
function extractIncomingText(payload) {
  const value = payload && payload.entry && payload.entry[0] && payload.entry[0].changes && payload.entry[0].changes[0] && payload.entry[0].changes[0].value;
  const message = value && Array.isArray(value.messages) ? value.messages[0] : null;
  if (!message || message.type !== "text") return null;
  const from = digitsOnly(message.from);
  const text = String((message.text && message.text.body) || "").trim();
  if (!from || !text) return null;
  const contactName = (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || "";
  return { from, text, messageId: String(message.id || ""), contactName };
}

// The image/PDF counterpart to extractIncomingText — same webhook payload, but Meta puts an
// image or document message under message.image/message.document instead of message.text,
// with the caption (if any) nested one level in rather than being the whole message body.
// Kept as a separate function rather than folded into extractIncomingText so a plain text
// message's contract (always has non-empty text, never has media fields) doesn't change for
// the callers that already depend on it.
const MEDIA_MESSAGE_TYPES = new Set(["image", "document"]);

function extractIncomingMedia(payload) {
  const value = payload && payload.entry && payload.entry[0] && payload.entry[0].changes && payload.entry[0].changes[0] && payload.entry[0].changes[0].value;
  const message = value && Array.isArray(value.messages) ? value.messages[0] : null;
  if (!message || !MEDIA_MESSAGE_TYPES.has(message.type)) return null;
  const media = message[message.type] || {};
  const from = digitsOnly(message.from);
  const mediaId = String(media.id || "");
  if (!from || !mediaId) return null;
  const contactName = (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || "";
  return {
    from,
    // A caption is optional — an image or PDF sent with nothing typed alongside it is a
    // normal thing to do, so this is allowed to come back empty; the caller decides what a
    // caption-less attachment means rather than this function inventing text that was never
    // actually sent.
    text: String(media.caption || "").trim(),
    messageId: String(message.id || ""),
    contactName,
    mediaId,
    mimeType: String(media.mime_type || "").split(";")[0].trim().toLowerCase(),
    // Meta gives documents a real filename; images never carry one.
    filename: media.filename ? String(media.filename) : null,
  };
}

// Meta's media download is a two-step handshake: the webhook only ever gives you an opaque
// media id, never the bytes or a public URL — first resolve that id to a short-lived signed
// URL, then fetch the URL itself, both authenticated the same way a message send is.
async function fetchWhatsAppMedia({ mediaId, accessToken, fetchImpl = fetch }) {
  if (!accessToken) throw new Error("WHATSAPP_ACCESS_TOKEN is required to download WhatsApp media.");
  const lookup = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!lookup.ok) throw new Error(`WhatsApp media lookup failed (HTTP ${lookup.status}).`);
  const meta = await lookup.json().catch(() => ({}));
  if (!meta.url) throw new Error("WhatsApp media lookup returned no download URL.");
  const download = await fetchImpl(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!download.ok) throw new Error(`WhatsApp media download failed (HTTP ${download.status}).`);
  const buffer = Buffer.from(await download.arrayBuffer());
  return { buffer, contentType: String(meta.mime_type || "").split(";")[0].trim().toLowerCase() };
}

async function sendWhatsAppText({ to, text, accessToken, phoneNumberId, fetchImpl = fetch }) {
  if (!accessToken || !phoneNumberId) throw new Error("WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required to reply on WhatsApp.");
  const response = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: String(text || "").slice(0, WHATSAPP_TEXT_LIMIT) } }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`WhatsApp send failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }
}

module.exports = {
  verifySignature, isAllowedNumber, extractIncomingText, extractIncomingMedia, fetchWhatsAppMedia,
  sendWhatsAppText, digitsOnly, WHATSAPP_TEXT_LIMIT, WHATSAPP_API_VERSION,
};
