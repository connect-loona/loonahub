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

// Returns true if the request should proceed, false if it should be rejected.
function isAuthorized(event) {
  const credentials = process.env.BASIC_AUTH_CREDENTIALS;
  const sepIndex = credentials ? credentials.indexOf(":") : -1;
  if (!credentials || sepIndex <= 0 || sepIndex === credentials.length - 1) return false; // fail closed, same as basic-auth.ts
  const cookies = parseCookies((event.headers && (event.headers.cookie || event.headers.Cookie)) || "");
  return cookies[COOKIE_NAME] === sha256Hex(credentials);
}

module.exports = { isAuthorized };
