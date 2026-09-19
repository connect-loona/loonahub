// BB on WhatsApp — Meta's WhatsApp Cloud API talking to the same global BB that already
// answers Strategy OS's "Global BB conversation". Covers the two things this integration
// gets wrong at its own peril: trusting a request that didn't really come from Meta, and
// answering someone who isn't on the internal allowlist. The actual LLM call (askBB) and
// the WhatsApp send call are exercised elsewhere/via injection — this file never reaches a
// real network.
"use strict";
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { HUB, check, finish } = require("../harness/shared");
const {
  verifySignature, isAllowedNumber, extractIncomingText, sendWhatsAppText, digitsOnly,
} = require(path.join(HUB, "netlify/functions/lib/strategy/whatsapp"));

process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
process.env.WHATSAPP_APP_SECRET = "test-app-secret";
process.env.WHATSAPP_ALLOWED_NUMBERS = "+91 98765 43210, +911234567890";
process.env.BASIC_AUTH_CREDENTIALS = process.env.BASIC_AUTH_CREDENTIALS || "gokul:supersecret";

function sign(rawBody, secret = process.env.WHATSAPP_APP_SECRET) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

const webhookModule = require(path.join(HUB, "netlify/functions/_legacy/whatsapp-webhook.js"));

const TEXT_PAYLOAD = (from, textBody, id = "wamid.test1") => JSON.stringify({
  entry: [{ changes: [{ value: {
    messages: [{ from, id, type: "text", text: { body: textBody } }],
    contacts: [{ profile: { name: "Test Teammate" } }],
  } }] }],
});

const STATUS_PAYLOAD = JSON.stringify({
  entry: [{ changes: [{ value: { statuses: [{ id: "wamid.test1", status: "delivered" }] } }] }],
});

(async () => {
  // ---- pure lib functions ----
  check("digitsOnly strips everything but digits", digitsOnly("+91 98765-43210") === "919876543210", digitsOnly("+91 98765-43210"));

  const rawBody = TEXT_PAYLOAD("919876543210", "Hi BB");
  const goodSig = sign(rawBody);
  check("a correctly signed body verifies", verifySignature(rawBody, goodSig, "test-app-secret"));
  check("a tampered body fails verification", !verifySignature(rawBody + "x", goodSig, "test-app-secret"));
  check("the wrong secret fails verification", !verifySignature(rawBody, sign(rawBody, "wrong-secret"), "test-app-secret"));
  check("a missing signature header fails closed", !verifySignature(rawBody, "", "test-app-secret"));
  check("a missing app secret fails closed even with a well-formed signature", !verifySignature(rawBody, goodSig, ""));
  check("a signature header without the sha256= prefix is rejected", !verifySignature(rawBody, goodSig.replace("sha256=", ""), "test-app-secret"));

  check("an allowlisted number (spaced/plus format) matches a plain digit sender id", isAllowedNumber("919876543210", process.env.WHATSAPP_ALLOWED_NUMBERS));
  check("an allowlisted number (already plain) also matches", isAllowedNumber("911234567890", process.env.WHATSAPP_ALLOWED_NUMBERS));
  check("a number not on the allowlist is refused", !isAllowedNumber("919999999999", process.env.WHATSAPP_ALLOWED_NUMBERS));
  check("an empty sender is refused", !isAllowedNumber("", process.env.WHATSAPP_ALLOWED_NUMBERS));

  const incoming = extractIncomingText(JSON.parse(TEXT_PAYLOAD("919876543210", "Hi BB")));
  check("a text message is extracted", incoming && incoming.text === "Hi BB" && incoming.from === "919876543210", incoming);
  check("the sender's WhatsApp display name is carried through", incoming.contactName === "Test Teammate", incoming);
  check("a status callback (no messages[]) yields nothing to answer", extractIncomingText(JSON.parse(STATUS_PAYLOAD)) === null);
  check("a malformed payload yields nothing to answer, not a throw", extractIncomingText({}) === null);
  const nonText = extractIncomingText({ entry: [{ changes: [{ value: { messages: [{ from: "919876543210", id: "x", type: "image" }] } }] }] });
  check("a non-text message type is not treated as a question for BB", nonText === null);

  // ---- sendWhatsAppText: talks through an injected fetch, never the real network ----
  const sentCalls = [];
  await sendWhatsAppText({
    to: "919876543210", text: "Here's what I'd try.", accessToken: "tok", phoneNumberId: "12345",
    fetchImpl: async (url, init) => { sentCalls.push({ url, init }); return { ok: true }; },
  });
  check("the reply is sent to the Graph API messages endpoint for that phone number id", sentCalls[0].url === "https://graph.facebook.com/v20.0/12345/messages", sentCalls[0].url);
  check("the access token is sent as a bearer token", sentCalls[0].init.headers.Authorization === "Bearer tok");
  const sentBody = JSON.parse(sentCalls[0].init.body);
  check("the WhatsApp message body matches BB's answer", sentBody.text.body === "Here's what I'd try." && sentBody.to === "919876543210", sentBody);

  const longText = "x".repeat(5000);
  await sendWhatsAppText({ to: "1", text: longText, accessToken: "tok", phoneNumberId: "1", fetchImpl: async (url, init) => { sentCalls.push({ url, init }); return { ok: true }; } });
  check("a reply longer than WhatsApp's text limit is truncated before sending", JSON.parse(sentCalls[1].init.body).text.body.length === 4096);

  let sendFailed = null;
  try {
    await sendWhatsAppText({ to: "1", text: "hi", accessToken: "tok", phoneNumberId: "1", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "Invalid OAuth token" }) });
  } catch (error) { sendFailed = error.message; }
  check("a rejected WhatsApp send surfaces the failure instead of pretending it worked", /WhatsApp send failed.*401/.test(sendFailed || ""), sendFailed);

  let missingCreds = null;
  try { await sendWhatsAppText({ to: "1", text: "hi", accessToken: "", phoneNumberId: "" }); }
  catch (error) { missingCreds = error.message; }
  check("sending without WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID fails clearly rather than calling Meta with empty credentials", /required to reply on WhatsApp/.test(missingCreds || ""), missingCreds);

  // ---- webhook handler: GET verification handshake ----
  const verifyOk = await webhookModule.handler({ httpMethod: "GET", queryStringParameters: { "hub.mode": "subscribe", "hub.verify_token": "test-verify-token", "hub.challenge": "12345" } });
  check("a correct verify token echoes Meta's challenge back", verifyOk.statusCode === 200 && verifyOk.body === "12345", verifyOk);
  const verifyBad = await webhookModule.handler({ httpMethod: "GET", queryStringParameters: { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345" } });
  check("an incorrect verify token is refused", verifyBad.statusCode === 403, verifyBad);
  const verifyMissingQuery = await webhookModule.handler({ httpMethod: "GET", queryStringParameters: null });
  check("a verification request with no query params doesn't throw", verifyMissingQuery.statusCode === 403, verifyMissingQuery);

  // ---- webhook handler: POST signature + allowlist gating ----
  const originalFetch = global.fetch;
  let backgroundCalls = [];
  global.fetch = async (url, init) => { backgroundCalls.push({ url, init }); return { ok: true }; };
  try {
    const unsigned = await webhookModule.handler({ httpMethod: "POST", headers: { host: "hub.loona.in" }, body: rawBody });
    check("an unsigned POST is rejected", unsigned.statusCode === 401, unsigned);
    check("an unsigned POST never triggers the background reply", backgroundCalls.length === 0, backgroundCalls);

    backgroundCalls = [];
    const disallowedBody = TEXT_PAYLOAD("919999999999", "Hi BB");
    const disallowed = await webhookModule.handler({ httpMethod: "POST", headers: { host: "hub.loona.in", "x-hub-signature-256": sign(disallowedBody) }, body: disallowedBody });
    check("a signed message from a number NOT on the allowlist still gets a 200 (so Meta doesn't retry)", disallowed.statusCode === 200, disallowed);
    check("but it never reaches BB", backgroundCalls.length === 0, backgroundCalls);

    backgroundCalls = [];
    const statusSig = sign(STATUS_PAYLOAD);
    const statusResult = await webhookModule.handler({ httpMethod: "POST", headers: { host: "hub.loona.in", "x-hub-signature-256": statusSig }, body: STATUS_PAYLOAD });
    check("a delivery-status callback is acknowledged without triggering a reply", statusResult.statusCode === 200 && backgroundCalls.length === 0, statusResult);

    backgroundCalls = [];
    const allowedBody = TEXT_PAYLOAD("919876543210", "Hi BB");
    const allowed = await webhookModule.handler({ httpMethod: "POST", headers: { host: "hub.loona.in", "x-hub-signature-256": sign(allowedBody) }, body: allowedBody });
    check("a signed message from an allowlisted number is accepted", allowed.statusCode === 200, allowed);
    check("and triggers exactly one background reply request", backgroundCalls.length === 1, backgroundCalls.length);
    check("the background call is signed for whatsapp-bb-reply-background", backgroundCalls[0].url.includes("/whatsapp-bb-reply-background") && backgroundCalls[0].init.headers["x-loona-background-signature"], backgroundCalls[0]);
    const forwarded = JSON.parse(backgroundCalls[0].init.body);
    check("the sender and message text are forwarded to the background function", forwarded.from === "919876543210" && forwarded.text === "Hi BB", forwarded);

    const methodNotAllowed = await webhookModule.handler({ httpMethod: "DELETE", headers: {} });
    check("a method other than GET/POST is rejected", methodNotAllowed.statusCode === 405, methodNotAllowed);
  } finally {
    global.fetch = originalFetch;
  }

  // ---- the background function itself: modern shape + fails closed on an unsigned call ----
  const backgroundModule = await import(`${pathToFileURL(path.join(HUB, "netlify/functions/whatsapp-bb-reply-background.mjs")).href}?test=${Date.now()}`);
  check("whatsapp-bb-reply-background uses the modern default handler", typeof backgroundModule.default === "function");
  check("whatsapp-bb-reply-background declares modern background mode", backgroundModule.config && backgroundModule.config.background === true, backgroundModule.config);
  await backgroundModule.default(new Request("https://example.test/.netlify/functions/whatsapp-bb-reply-background", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "919876543210", text: "Hi BB", messageId: "wamid.test1" }),
  }));
  check("an unsigned direct call to the background worker is rejected without throwing", true);

  // ---- the one-time introduction is actually wired into the reply, not just implemented ----
  // Driving the whole handler here would mean mocking Anthropic and Meta's send API, so this
  // guards the wiring directly instead. Worth having: twice this week a shipped instruction
  // was correct in its own module and simply never reached the prompt.
  const fs = require("fs");
  const handlerSource = fs.readFileSync(path.join(HUB, "netlify/functions/whatsapp-bb-reply-background.mjs"), "utf8");
  check("the handler threads the introduction into askBB", /askBB\(\{[^}]*introduction[^}]*\}\)/.test(handlerSource), handlerSource.match(/askBB\(\{[^}]*\}\)/));
  check("the introduction is only built when BB has not met them", /alreadyMet \? null : introductionPromptText/.test(handlerSource));
  // Recording the meeting before the message is sent would silently cost that person the
  // only first greeting they ever get.
  check("the meeting is recorded only after the reply has actually been sent",
    handlerSource.indexOf("markMetSafe(from, speaker)") > handlerSource.indexOf("sendWhatsAppText({ to: from"),
    { sent: handlerSource.indexOf("sendWhatsAppText({ to: from"), marked: handlerSource.indexOf("markMetSafe(from, speaker)") });

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
