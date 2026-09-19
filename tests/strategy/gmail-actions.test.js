// Creating a real Gmail draft — the shared core BB's own draft_email tool
// (lib/strategy/bb-email-actions.js) calls.
//
// Never touches a real Google credential, a real Firebase project, or the real network — every
// dependency (fbGet/fetchImpl/serviceAccount) is injected, matching the DI convention every
// other lib/*.js test in this repo uses. There is deliberately no "send" path anywhere in this
// suite, because gmail-actions.js has no send_email function at all.
"use strict";
const crypto = require("crypto");
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { createDraft, resolveRecipients } = require(path.join(HUB, "netlify/functions/lib/gmail-actions"));

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 512, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SERVICE_ACCOUNT = { client_email: "sa@loona-hub.iam.gserviceaccount.com", private_key: privateKey };

function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  function at(p) { return p.split("/").filter(Boolean).reduce((node, key) => (node == null ? node : node[key]), data); }
  async function fbGet(p) { const v = at(p); return v === undefined ? null : v; }
  return { data, fbGet };
}

function makeFetch({ draftResponse = {}, tokenOk = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    let body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ url, method: opts.method || "GET", body });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return { ok: tokenOk, json: async () => (tokenOk ? { access_token: "test-token" } : { error: "unauthorized_client" }) };
    }
    if (opts.method === "POST" && String(url).includes("/drafts")) return { ok: true, json: async () => draftResponse };
    return { ok: false, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const MEMBERS = {
  m1: { name: "Ankita", email: "ankita@loona.in" },
  m2: { name: "Rahul" }, // no explicit email — must derive firstname@loona.in
};

(async () => {
  // ---- createDraft: the happy path ----
  {
    const store = makeStore({ members: MEMBERS });
    const { fetchImpl, calls } = makeFetch({ draftResponse: { id: "draft1" } });
    const result = await createDraft({
      senderName: "Ankita", to: ["Rahul", "client@brand.com"], cc: ["not-an-email"], subject: "Deck for review", body: "Hi, sharing the deck.",
    }, { fbGet: store.fbGet, fetchImpl, serviceAccount: SERVICE_ACCOUNT });

    check("a draft is created successfully", result.success === true, result);
    check("the draft id comes back", result.draftId === "draft1", result);
    check("Rahul's derived email is resolved as a recipient", result.to.includes("rahul@loona.in"), result.to);
    check("the raw external email is resolved as a recipient too", result.to.includes("client@brand.com"), result.to);
    check("a malformed cc entry is reported as unresolved, not silently invited", result.unresolvedCc.includes("not-an-email"), result.unresolvedCc);

    const tokenCall = calls.find((c) => String(c.url).includes("oauth2.googleapis.com"));
    const assertion = new URLSearchParams(tokenCall.body).get("assertion");
    const jwtPayload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64").toString("utf8"));
    check("the draft is genuinely created as the sender being impersonated (JWT sub claim)", jwtPayload.sub === "ankita@loona.in", jwtPayload);
    check("the requested scope is Gmail compose, not Calendar's", jwtPayload.scope === "https://www.googleapis.com/auth/gmail.compose", jwtPayload);

    const draftCall = calls.find((c) => c.method === "POST" && String(c.url).includes("/drafts"));
    const rawMessage = Buffer.from(draftCall.body.message.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    check("the actual subject is in the raw RFC 2822 message", /Subject: Deck for review/.test(rawMessage), rawMessage);
    check("the actual body text is in the raw message", /Hi, sharing the deck\./.test(rawMessage), rawMessage);
    check("the sender's own email is the From header", new RegExp(`From:.*ankita@loona\\.in`).test(rawMessage), rawMessage);
  }

  // ---- resolveRecipients: names and raw emails, mixed freely ----
  {
    const store = makeStore({ members: MEMBERS });
    const memberByName = { ankita: MEMBERS.m1, rahul: MEMBERS.m2 };
    const { resolved, unresolved } = resolveRecipients(["Rahul", "client@brand.com", "Nobody Real", ""], memberByName);
    check("a Hub teammate name resolves to their derived email", resolved.includes("rahul@loona.in"), resolved);
    check("a raw email address is kept as-is", resolved.includes("client@brand.com"), resolved);
    check("an unrecognised name is reported unresolved rather than silently dropped or invented", unresolved.includes("Nobody Real"), unresolved);
    check("a blank entry is quietly ignored, not reported as unresolved", !unresolved.includes(""), unresolved);
  }

  // ---- createDraft: validation ----
  {
    const store = makeStore({ members: MEMBERS });
    const { fetchImpl } = makeFetch({});
    let missing = null;
    try { await createDraft({ senderName: "Ankita", to: ["Rahul"] }, { fbGet: store.fbGet, fetchImpl, serviceAccount: SERVICE_ACCOUNT }); }
    catch (error) { missing = error.message; }
    check("missing subject/body is refused", /Missing required fields/.test(missing || ""), missing);

    let unknownSender = null;
    try {
      await createDraft({ senderName: "Someone Not On The Team", to: ["Rahul"], subject: "x", body: "x" }, { fbGet: store.fbGet, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    } catch (error) { unknownSender = error.message; }
    check("a sender not on the roster is refused, rather than silently drafting as nobody", /not found in the team roster/.test(unknownSender || ""), unknownSender);

    let noRecipient = null;
    try {
      await createDraft({ senderName: "Ankita", to: ["Nobody Real", "not-an-email"], subject: "x", body: "x" }, { fbGet: store.fbGet, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    } catch (error) { noRecipient = error.message; }
    check("a draft with no valid recipient at all is refused", /No valid recipient/.test(noRecipient || ""), noRecipient);
  }

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
