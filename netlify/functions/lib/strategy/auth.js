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

// Returns { ok: true } or { ok: false, reason }. The reason is safe to show the caller —
// it never includes the actual credential value, only which check failed — and exists
// specifically to tell apart three failure modes that a bare "Unauthorized" can't
// distinguish from the outside: the env var not being visible to this function at all
// (e.g. scoped to Edge Functions only in Netlify's dashboard, so a regular Function's
// process.env never sees it), the browser not sending a cookie, or a cookie that doesn't
// match. Temporary/diagnostic — safe to leave in, but the goal is to delete this level of
// detail once the real cause is confirmed and fixed.
function checkAuthorization(event) {
  const credentials = process.env.BASIC_AUTH_CREDENTIALS;
  const sepIndex = credentials ? credentials.indexOf(":") : -1;
  if (!credentials || sepIndex <= 0 || sepIndex === credentials.length - 1) {
    return { ok: false, reason: "BASIC_AUTH_CREDENTIALS is not visible to this function (missing, empty, or malformed) — check its scope in Netlify's environment variable settings includes Functions, not just Edge Functions." };
  }
  const cookieHeader = (event.headers && (event.headers.cookie || event.headers.Cookie)) || "";
  const cookies = parseCookies(cookieHeader);
  if (!cookies[COOKIE_NAME]) {
    return { ok: false, reason: "No loona_auth cookie was sent with this request." };
  }
  if (cookies[COOKIE_NAME] !== sha256Hex(credentials)) {
    return { ok: false, reason: "The loona_auth cookie doesn't match this function's BASIC_AUTH_CREDENTIALS value — possibly a stale cookie, or the value differs from what basic-auth.ts is using." };
  }
  return { ok: true };
}

// Kept for compatibility with anything calling the plain boolean check.
function isAuthorized(event) {
  return checkAuthorization(event).ok;
}

module.exports = { isAuthorized, checkAuthorization };
