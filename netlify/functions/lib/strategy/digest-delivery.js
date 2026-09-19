// Sends one of BB's daily digests to every teammate on the WhatsApp allowlist, and reports
// honestly on what actually arrived.
//
// The honesty matters more than usual here. Meta only lets a business send free-form WhatsApp
// text inside the 24-hour window that opens when that person last messaged you; outside it,
// the send is rejected unless it uses a pre-approved template. The team messaging BB daily
// keeps those windows open, which is the whole basis for sending these over WhatsApp at all —
// but it is an assumption about human behaviour, not a guarantee the platform makes.
//
// So a rejection is never swallowed. Each recipient's outcome is recorded, and the caller
// gets the failures back to put somewhere a human will see them. The failure mode this exists
// to prevent is the quiet one: somebody stops messaging BB, their window closes, they silently
// stop receiving the morning rundown, and nobody notices for a month.
"use strict";
const { sendWhatsAppText } = require("./whatsapp");
const { fbSet, fbSafeKey } = require("./firebase");

// Meta's code for "more than 24 hours have passed since that person last messaged you", which
// is the one failure here that means something other than a bug.
const WINDOW_CLOSED_CODES = new Set([131047, 131051]);

function recipients(allowlist) {
  return String(allowlist || "")
    .split(",")
    .map((entry) => String(entry).replace(/\D/g, ""))
    .filter(Boolean);
}

function describeFailure(error) {
  const message = error && error.message ? String(error.message) : String(error || "unknown error");
  const code = Number((/\b1310\d\d\b/.exec(message) || [])[0] || 0);
  if (WINDOW_CLOSED_CODES.has(code)) {
    return { reason: "window_closed", detail: "Their 24-hour window has closed — they have not messaged BB since yesterday, so Meta refused a free-form message." };
  }
  return { reason: "send_failed", detail: message.slice(0, 300) };
}

// Sends to everyone, one at a time, and never lets one bad recipient stop the rest. Returns
// { delivered, failed } so the caller can decide how loudly to complain.
async function deliverDigest({ text, allowlist, slot, accessToken, phoneNumberId }, deps = {}) {
  const send = deps.sendWhatsAppText || sendWhatsAppText;
  const set = deps.fbSet || fbSet;
  const to = recipients(allowlist);
  const delivered = [];
  const failed = [];

  for (const number of to) {
    try {
      await send({ to: number, text, accessToken, phoneNumberId });
      delivered.push(number);
    } catch (error) {
      failed.push({ number, ...describeFailure(error) });
    }
  }

  // A record per run, so "did the team actually get Tuesday's rundown" is answerable later
  // rather than a matter of memory. Best-effort: a failed ledger write must not turn into a
  // failed send when the messages themselves went out fine.
  try {
    const stamp = new Date().toISOString();
    await set(`bb_digest_log/${fbSafeKey(stamp.slice(0, 10))}/${fbSafeKey(slot || "unknown")}`, {
      sentAt: stamp, slot: slot || "unknown",
      deliveredCount: delivered.length, failedCount: failed.length,
      delivered, failed, text: String(text || "").slice(0, 4000),
    });
  } catch (error) { console.error("Could not record the digest delivery log:", error.message); }

  return { delivered, failed, attempted: to.length };
}

module.exports = { deliverDigest, recipients, describeFailure, WINDOW_CLOSED_CODES };
