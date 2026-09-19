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
  verifySignature, isAllowedNumber, extractIncomingText, extractIncomingMedia, fetchWhatsAppMedia, sendWhatsAppText, digitsOnly,
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

const IMAGE_PAYLOAD = (from, { caption, id = "wamid.img1" } = {}) => JSON.stringify({
  entry: [{ changes: [{ value: {
    messages: [{ from, id, type: "image", image: { id: "media-abc123", mime_type: "image/jpeg", ...(caption ? { caption } : {}) } }],
    contacts: [{ profile: { name: "Test Teammate" } }],
  } }] }],
});

const DOCUMENT_PAYLOAD = (from, { caption, id = "wamid.doc1" } = {}) => JSON.stringify({
  entry: [{ changes: [{ value: {
    messages: [{ from, id, type: "document", document: { id: "media-doc456", mime_type: "application/pdf", filename: "brief.pdf", ...(caption ? { caption } : {}) } }],
    contacts: [{ profile: { name: "Test Teammate" } }],
  } }] }],
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

  // ---- extractIncomingMedia: images and PDFs, so BB can caption a creative, read a
  // screenshot of a client chat, or check a PDF brief sent straight on WhatsApp ----
  const withCaption = extractIncomingMedia(JSON.parse(IMAGE_PAYLOAD("919876543210", { caption: "caption this for Instagram" })));
  check("an image with a caption is extracted", withCaption && withCaption.mediaId === "media-abc123" && withCaption.mimeType === "image/jpeg", withCaption);
  check("the caption becomes the message text", withCaption.text === "caption this for Instagram", withCaption);
  check("the sender's display name is carried through for media too", withCaption.contactName === "Test Teammate", withCaption);

  const noCaption = extractIncomingMedia(JSON.parse(IMAGE_PAYLOAD("919876543210", {})));
  check("an image with no caption is still extracted, with empty text rather than invented text", noCaption && noCaption.text === "", noCaption);

  const pdf = extractIncomingMedia(JSON.parse(DOCUMENT_PAYLOAD("919876543210", { caption: "what's in this brief?" })));
  check("a PDF document is extracted the same way an image is", pdf && pdf.mediaId === "media-doc456" && pdf.mimeType === "application/pdf", pdf);
  check("a document's real filename from Meta is carried through", pdf.filename === "brief.pdf", pdf);
  check("an image never gets a filename invented for it — Meta doesn't send one", extractIncomingMedia(JSON.parse(IMAGE_PAYLOAD("919876543210", {}))).filename === null);

  check("a plain text message is not picked up by the media extractor", extractIncomingMedia(JSON.parse(TEXT_PAYLOAD("919876543210", "Hi BB"))) === null);
  check("a status callback yields nothing to the media extractor either", extractIncomingMedia(JSON.parse(STATUS_PAYLOAD)) === null);
  check("a malformed payload yields nothing rather than throwing", extractIncomingMedia({}) === null);
  const noMediaId = extractIncomingMedia({ entry: [{ changes: [{ value: { messages: [{ from: "919876543210", id: "x", type: "image", image: {} }] } }] }] });
  check("a media message with no id at all is not treated as something to fetch", noMediaId === null);

  // ---- fetchWhatsAppMedia: the two-step handshake (id -> signed URL -> bytes), against an
  // injected fetch so this never reaches Meta's real API ----
  const mediaCalls = [];
  const fakeMediaFetch = async (url, init) => {
    mediaCalls.push({ url, init });
    if (url === "https://graph.facebook.com/v20.0/media-abc123") {
      return { ok: true, json: async () => ({ url: "https://lookaside.example.com/signed-download", mime_type: "image/jpeg" }) };
    }
    if (url === "https://lookaside.example.com/signed-download") {
      return { ok: true, arrayBuffer: async () => Buffer.from("fake-jpeg-bytes") };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const fetched = await fetchWhatsAppMedia({ mediaId: "media-abc123", accessToken: "tok", fetchImpl: fakeMediaFetch });
  check("the media id is looked up on the Graph API first", mediaCalls[0].url === "https://graph.facebook.com/v20.0/media-abc123", mediaCalls[0].url);
  check("the lookup carries the same bearer token a send would", mediaCalls[0].init.headers.Authorization === "Bearer tok");
  check("the signed download URL from the lookup is then fetched, also bearer-authenticated", mediaCalls[1].url === "https://lookaside.example.com/signed-download" && mediaCalls[1].init.headers.Authorization === "Bearer tok", mediaCalls[1]);
  check("the downloaded bytes come back as a Buffer", Buffer.isBuffer(fetched.buffer) && fetched.buffer.toString() === "fake-jpeg-bytes", fetched);
  check("the content type comes from the lookup response", fetched.contentType === "image/jpeg", fetched);

  let lookupFailed = null;
  try { await fetchWhatsAppMedia({ mediaId: "x", accessToken: "tok", fetchImpl: async () => ({ ok: false, status: 404 }) }); }
  catch (error) { lookupFailed = error.message; }
  check("a failed media lookup surfaces as a real error rather than silently returning nothing", /lookup failed.*404/.test(lookupFailed || ""), lookupFailed);

  let downloadFailed = null;
  try {
    await fetchWhatsAppMedia({
      mediaId: "x", accessToken: "tok",
      fetchImpl: async (url) => (url.includes("graph.facebook.com") ? { ok: true, json: async () => ({ url: "https://cdn.example.com/x", mime_type: "image/png" }) } : { ok: false, status: 410 }),
    });
  } catch (error) { downloadFailed = error.message; }
  check("a failed media download (e.g. the signed URL has expired) also surfaces", /download failed.*410/.test(downloadFailed || ""), downloadFailed);

  let missingToken = null;
  try { await fetchWhatsAppMedia({ mediaId: "x", accessToken: "" }); } catch (error) { missingToken = error.message; }
  check("fetching without WHATSAPP_ACCESS_TOKEN fails clearly rather than calling Meta unauthenticated", /required to download WhatsApp media/.test(missingToken || ""), missingToken);

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

    backgroundCalls = [];
    const imageBody = IMAGE_PAYLOAD("919876543210", { caption: "caption this" });
    const imageResult = await webhookModule.handler({ httpMethod: "POST", headers: { host: "hub.loona.in", "x-hub-signature-256": sign(imageBody) }, body: imageBody });
    check("a signed image message from an allowlisted number is accepted", imageResult.statusCode === 200, imageResult);
    check("and it also triggers exactly one background reply request", backgroundCalls.length === 1, backgroundCalls.length);
    const forwardedMedia = JSON.parse(backgroundCalls[0].init.body);
    check("the media id, mime type and caption are all forwarded to the background function", forwardedMedia.mediaId === "media-abc123" && forwardedMedia.mimeType === "image/jpeg" && forwardedMedia.text === "caption this", forwardedMedia);

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

  // ---- resolveWhatsAppMedia: the actual decision logic for an image/PDF someone sends BB —
  // captioning a creative, reading a screenshot of a client chat, checking a PDF brief ----
  const { resolveWhatsAppMedia, captionOrDefault } = backgroundModule;

  const savedAttachments = [];
  const goodImage = await resolveWhatsAppMedia(
    { mediaId: "media-abc123", mimeType: "image/jpeg" },
    {
      fetchWhatsAppMedia: async () => ({ buffer: Buffer.from("jpeg-bytes"), contentType: "image/jpeg" }),
      saveBBAttachment: async (args) => { savedAttachments.push(args); return { assetKey: "brands/global/chats/bb/attachments/fake-key" }; },
    },
  );
  check("a supported image resolves to a vision attachment, not a reply", !goodImage.reply && goodImage.attachment, goodImage);
  check("the attachment carries the actual downloaded bytes", Buffer.isBuffer(goodImage.attachment.data) && goodImage.attachment.data.toString() === "jpeg-bytes", goodImage.attachment);
  check("it is durably saved the same way an Ask BB upload is (brandId: global)", savedAttachments[0].brandId === "global" && savedAttachments[0].contentType === "image/jpeg", savedAttachments[0]);
  check("the saved asset key is recorded so this message's attachment can be referenced later", goodImage.record.assetKey === "brands/global/chats/bb/attachments/fake-key", goodImage.record);
  check("images with no filename from Meta get a sensible default", savedAttachments[0].filename === "photo.jpg", savedAttachments[0]);

  const goodPdf = await resolveWhatsAppMedia(
    { mediaId: "media-doc456", mimeType: "application/pdf", filename: "brief.pdf" },
    { fetchWhatsAppMedia: async () => ({ buffer: Buffer.from("%PDF-fake"), contentType: "application/pdf" }), saveBBAttachment: async () => ({ assetKey: "k" }) },
  );
  check("a PDF is supported the same way an image is", !goodPdf.reply && goodPdf.attachment.contentType === "application/pdf", goodPdf);

  const wrongType = await resolveWhatsAppMedia(
    { mediaId: "x", mimeType: "video/mp4" },
    { fetchWhatsAppMedia: async () => ({ buffer: Buffer.from("video"), contentType: "video/mp4" }), saveBBAttachment: async () => { throw new Error("must not be called"); } },
  );
  check("an unsupported file type gets a direct explanatory reply instead of an attachment", /can only read images.*and PDFs/i.test(wrongType.reply || ""), wrongType);
  check("an unsupported file type is never saved to storage", !wrongType.attachment, wrongType);

  const tooBig = await resolveWhatsAppMedia(
    { mediaId: "x", mimeType: "image/png" },
    { fetchWhatsAppMedia: async () => ({ buffer: Buffer.alloc(11 * 1024 * 1024), contentType: "image/png" }), saveBBAttachment: async () => { throw new Error("must not be called"); } },
  );
  check("a file over the 10MB limit also gets a direct reply rather than being saved", /bigger than the 10MB/i.test(tooBig.reply || ""), tooBig);

  let downloadThrew = false;
  try {
    await resolveWhatsAppMedia({ mediaId: "x", mimeType: "image/png" }, { fetchWhatsAppMedia: async () => { throw new Error("Meta is down"); } });
  } catch { downloadThrew = true; }
  check("a genuine download failure is left to throw, for the caller's own catch-and-log path", downloadThrew);

  // ---- captionOrDefault: BB still needs an instruction when nothing was typed ----
  check("an actual caption is used as-is", captionOrDefault("caption this please", "image/jpeg") === "caption this please");
  check("a caption-less image gets a sensible default asking her to look at it", /take a look/i.test(captionOrDefault("", "image/jpeg")), captionOrDefault("", "image/jpeg"));
  check("a caption-less PDF gets its own wording, not the image one", /PDF/i.test(captionOrDefault("", "application/pdf")) && captionOrDefault("", "application/pdf") !== captionOrDefault("", "image/jpeg"), captionOrDefault("", "application/pdf"));

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

  // ---- media is actually threaded into what BB sees, not just downloaded and discarded ----
  check("a resolved attachment is threaded into askBB's own attachments array",
    /attachments: visionAttachment \? \[visionAttachment\] : \[\]/.test(handlerSource), handlerSource);
  check("an unsupported/oversized file's reply short-circuits before ever calling askBB — no wasted model call",
    /if \(media\.reply\) \{[\s\S]*?return;\s*\}/.test(handlerSource), handlerSource);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
