// Lets BB create a real Gmail draft — impersonating whoever she's actually talking to, via the
// exact same domain-wide-delegation service account calendar-actions.js already uses to send
// Calendar invites, just requesting Gmail's own compose scope instead of Calendar's.
//
// Deliberately creates a DRAFT only. Nothing is ever sent from here — the draft lands, unsent,
// in the sender's own Gmail Drafts folder, for them to review, edit and send by hand, exactly
// the same safety margin a human typing an email themselves has. There is no send_email
// function in this file on purpose.
"use strict";
const crypto = require("crypto");
const { authedUrl } = require("./firebase-auth");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signJWT(claims, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claims));
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return signingInput + "." + base64url(signature);
}

// Same service account and env var as calendar-actions.js — domain-wide delegation is
// authorized per scope in the Workspace admin console against that one credential, not one
// credential per API, so Calendar and Gmail access both flow through it.
async function loadServiceAccount(deps) {
  if (deps.serviceAccount) return deps.serviceAccount;
  const raw = deps.serviceAccountRaw || process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_CALENDAR_SERVICE_ACCOUNT not set");
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error("GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON"); }
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key");
  return sa;
}

async function getAccessToken(userEmail, sa, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJWT({ iss: sa.client_email, scope: GMAIL_SCOPE, aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now, sub: userEmail }, sa.private_key);
  const resp = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(jwt),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`Auth failed for ${userEmail}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

async function fbGet(path) {
  const resp = await fetch(authedUrl(`${FB}/${path}.json`));
  return resp.json().catch(() => null);
}

function normName(n) { return String(n || "").trim().toLowerCase(); }

function deriveEmail(member) {
  if (member.email) return member.email;
  return String(member.name || "").toLowerCase().replace(/\s+/g, "") + "@loona.in";
}

async function loadMemberByName(get) {
  const membersData = await get("members");
  const members = Object.values(membersData || {}).filter((m) => m && m.name);
  const memberByName = {};
  members.forEach((m) => { memberByName[String(m.name).toLowerCase()] = m; });
  return memberByName;
}

// Accepts either a raw email address or a Hub teammate's first name for each entry — the same
// two shapes createMeeting() accepts for attendees/guest_emails, just merged into one list here
// since "email Priya and client@brand.com" is one natural sentence, not two separate fields to
// fill in.
function resolveRecipients(list, memberByName) {
  const resolved = [];
  const unresolved = [];
  (Array.isArray(list) ? list : []).forEach((entry) => {
    const raw = String(entry || "").trim();
    if (!raw) return;
    if (EMAIL_RE.test(raw)) { resolved.push(raw.toLowerCase()); return; }
    const member = memberByName[normName(raw)];
    if (member) resolved.push(deriveEmail(member));
    else unresolved.push(raw);
  });
  return { resolved: [...new Set(resolved)], unresolved };
}

// A minimal RFC 2822 message, base64url-encoded the way Gmail's drafts.create expects in
// message.raw. Plain text only — BB never has a reason to send HTML/attachments here.
function buildRawMessage({ fromEmail, fromName, to, cc, subject, body }) {
  const headers = [`From: ${fromName ? `"${fromName}" <${fromEmail}>` : fromEmail}`, `To: ${to.join(", ")}`];
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  headers.push(`Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"');
  return base64url(Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body, "utf8"));
}

// params: { senderName, to, cc, subject, body }
async function createDraft(params, deps = {}) {
  const get = deps.fbGet || fbGet;
  const fetchImpl = deps.fetchImpl || fetch;
  const sa = await loadServiceAccount(deps);

  const { senderName, subject, body } = params;
  if (!senderName || !subject || !body) throw new Error("Missing required fields (senderName, subject, body)");

  const memberByName = await loadMemberByName(get);
  const sender = memberByName[normName(senderName)];
  if (!sender) throw new Error(`"${senderName}" not found in the team roster`);
  const senderEmail = deriveEmail(sender);

  const { resolved: to, unresolved: unresolvedTo } = resolveRecipients(params.to, memberByName);
  const { resolved: cc, unresolved: unresolvedCc } = resolveRecipients(params.cc, memberByName);
  if (!to.length) throw new Error("No valid recipient — give at least one real email address or Hub teammate name.");

  const accessToken = await getAccessToken(senderEmail, sa, fetchImpl);
  const raw = buildRawMessage({ fromEmail: senderEmail, fromName: sender.name, to, cc, subject, body });

  const resp = await fetchImpl("https://www.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Gmail API ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);

  return { success: true, draftId: data.id, from: senderEmail, to, cc, subject, unresolvedTo, unresolvedCc };
}

module.exports = { createDraft, resolveRecipients };
