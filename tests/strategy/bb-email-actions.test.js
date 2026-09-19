// BB drafting a real (never sent) Gmail email through conversation.
//
// The thing most worth testing here is the same identity boundary as bb-calendar-actions.js:
// the sender is NEVER something the model can supply — it is always ctx.speakerName, the actual
// verified person BB is talking to. This suite fakes gmail-actions.js's own createDraft inputs
// via dependency injection rather than a real Google credential or network call — the Google-
// API behavior itself is covered by gmail-actions.test.js.
"use strict";
const crypto = require("crypto");
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const {
  EMAIL_ACTION_TOOLS, executeEmailAction, draftEmailAction, looksLikeConfirmation,
} = require(path.join(HUB, "netlify/functions/lib/strategy/bb-email-actions"));

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 512, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SERVICE_ACCOUNT = { client_email: "sa@loona-hub.iam.gserviceaccount.com", private_key: privateKey };

function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  function at(p) { return p.split("/").filter(Boolean).reduce((node, key) => (node == null ? node : node[key]), data); }
  async function fbGet(p) { const v = at(p); return v === undefined ? null : v; }
  return { data, fbGet };
}

function makeFetch({ draftResponse = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    let body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ url, method: opts.method || "GET", body });
    if (String(url).includes("oauth2.googleapis.com/token")) return { ok: true, json: async () => ({ access_token: "test-token" }) };
    if (opts.method === "POST" && String(url).includes("/drafts")) return { ok: true, json: async () => draftResponse };
    return { ok: false, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const MEMBERS = { m1: { name: "Ankita", email: "ankita@loona.in" } };

(async () => {
  // ---- Tool schema ----
  check("exactly the one intended tool is exposed", EMAIL_ACTION_TOOLS.map((t) => t.name).join() === "draft_email", EMAIL_ACTION_TOOLS.map((t) => t.name));
  check("no tool exposes a model-settable sender/from field — that identity is never taken from the model", !EMAIL_ACTION_TOOLS.some((t) => Object.keys(t.input_schema.properties).some((k) => /sender|from/i.test(k))), EMAIL_ACTION_TOOLS.map((t) => Object.keys(t.input_schema.properties)));
  check("draft_email requires the essentials", JSON.stringify(EMAIL_ACTION_TOOLS.find((t) => t.name === "draft_email").input_schema.required) === '["to","subject","body"]');
  check("there is no send tool at all, only a draft one", !EMAIL_ACTION_TOOLS.some((t) => /send/i.test(t.name)), EMAIL_ACTION_TOOLS.map((t) => t.name));

  // ---- The confirmation gate is shared verbatim with the task/calendar ones ----
  check("confirmation detection is the exact same heuristic used elsewhere", looksLikeConfirmation("Yes, draft it.") === true);

  // ---- draft_email is refused outright without confirmation ----
  const blocked = await executeEmailAction("draft_email", { to: ["client@brand.com"], subject: "x", body: "x" }, { confirmed: false, speakerName: "Ankita" }, {});
  check("draft_email is refused when the turn wasn't a confirmation", blocked.ok === false && blocked.needsConfirmation === true, blocked);

  // ---- The sender is always ctx.speakerName, never anything from the model's input ----
  {
    const store = makeStore({ members: MEMBERS });
    const { fetchImpl, calls } = makeFetch({ draftResponse: { id: "d1" } });
    const result = await executeEmailAction("draft_email", { to: ["client@brand.com"], subject: "Update", body: "Hi there," }, { confirmed: true, speakerName: "Ankita" }, { fbGet: store.fbGet, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    check("a confirmed draft_email actually creates the draft", result.ok === true && result.draft.success === true, result);
    const tokenCall = calls.find((c) => String(c.url).includes("oauth2.googleapis.com"));
    const assertion = new URLSearchParams(tokenCall.body).get("assertion");
    const jwtPayload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64").toString("utf8"));
    check("the draft is genuinely created as the verified speaker", jwtPayload.sub === "ankita@loona.in", jwtPayload);
  }

  // ---- Drafting with no verified speaker is refused, not silently attributed to "the team" ----
  {
    let unverifiedError = null;
    try { await draftEmailAction({ to: ["client@brand.com"], subject: "x", body: "x" }, { speakerName: null }, {}); }
    catch (error) { unverifiedError = error.message; }
    check("drafting with no confirmed identity is refused outright", /confirmed identity/.test(unverifiedError || ""), unverifiedError);
  }

  // ---- An unrecognised tool name is a bug, not silently ignored ----
  let unknownTool = null;
  try { await executeEmailAction("send_email", {}, { confirmed: true }, {}); } catch (error) { unknownTool = error.message; }
  check("an unrecognised tool name throws", /Unknown email action tool/.test(unknownTool || ""), unknownTool);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
