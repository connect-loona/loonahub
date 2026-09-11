// Strategy OS's HTTP-facing endpoints (strategy-run-start.js, strategy-stage-approve.js)
// need to require the site's login cookie — unlike most of Hub's other Netlify Functions,
// which basic-auth.ts's edge gate lets through unauthenticated (fine for a low-stakes chat
// helper; not fine for something that can kick off billed AI runs and touch a client's
// live strategy). Rather than editing basic-auth.ts's own function-exclusion logic — a
// shared-infrastructure change affecting ~30 other functions, worth keeping minimal — this
// replicates just its cookie check, scoped to these two functions only.
//
// Same cookie name, same hash, same env var, same fail-closed posture: basic-auth.ts
// treats missing or malformed BASIC_AUTH_CREDENTIALS as "sign-in unavailable" (503) rather
// than letting requests through, and this matches that — mirror it here again if that
// file's malformed-credentials check ever changes.
"use strict";
const crypto = require("crypto");

const COOKIE_NAME = "loona_auth";

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });
  return out;
}

const { fbGet, FB } = require("./firebase");
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "AIzaSyBnESbCpAiVcSPHOZk4ANFwlIqw7DhB4A0";

function bearerToken(event) {
  const headers = (event && event.headers) || {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === "authorization");
  const match = key && String(headers[key]).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function deriveEmail(member) {
  return String(member.email || `${String(member.name || "").toLowerCase().replace(/\s+/g, "")}@loona.in`).toLowerCase();
}

function localTestCaller(token) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(FB)) return null;
  const parts = token.split(":");
  if (parts.length !== 4 || parts[0] !== "test") return null;
  try {
    return { email: decodeURIComponent(parts[1]).toLowerCase(), actor: decodeURIComponent(parts[2]), uid: parts[3] };
  } catch {
    return null;
  }
}

async function resolveFirebaseCaller(token) {
  const testCaller = localTestCaller(token);
  if (testCaller) return testCaller;
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: token }),
  });
  const data = await response.json().catch(() => null);
  const user = response.ok && data && data.users && data.users[0];
  if (!user || !user.email) return null;
  const email = String(user.email).toLowerCase();
  const members = Object.values((await fbGet("members")) || {}).filter((member) => member && member.name);
  const match = members.find((member) => deriveEmail(member) === email);
  return match ? { email, actor: match.name, uid: user.localId } : null;
}

// Strategy actions require both the Hub perimeter cookie and a current Firebase team
// session. The actor is resolved server-side and never trusted from the request body.
async function checkAuthorization(event) {
  const credentials = process.env.BASIC_AUTH_CREDENTIALS;
  const sepIndex = credentials ? credentials.indexOf(":") : -1;
  if (!credentials || sepIndex <= 0 || sepIndex === credentials.length - 1) {
    return { ok: false, reason: "Strategy authentication is unavailable." };
  }
  const cookieHeader = (event.headers && (event.headers.cookie || event.headers.Cookie)) || "";
  const cookies = parseCookies(cookieHeader);
  if (!cookies[COOKIE_NAME]) {
    return { ok: false, reason: "Hub sign-in is required." };
  }
  if (cookies[COOKIE_NAME] !== sha256Hex(credentials)) {
    return { ok: false, reason: "Hub sign-in has expired." };
  }
  const token = bearerToken(event);
  if (!token) return { ok: false, reason: "Firebase sign-in is required." };
  try {
    const caller = await resolveFirebaseCaller(token);
    return caller ? { ok: true, ...caller } : { ok: false, reason: "Firebase session is invalid or is not a Hub team member." };
  } catch (error) {
    console.error("Strategy Firebase authentication failed:", error);
    return { ok: false, reason: "Firebase authentication could not be verified." };
  }
}

async function isAuthorized(event) {
  return (await checkAuthorization(event)).ok;
}

module.exports = { isAuthorized, checkAuthorization };
