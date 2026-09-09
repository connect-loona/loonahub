// Strategy OS's HTTP-facing endpoints (strategy-run-start.js, strategy-stage-approve.js)
// need to require the site's login cookie — unlike most of Hub's other Netlify Functions,
// which are excluded from basic-auth.ts's edge gate wholesale (fine for a low-stakes chat
// helper; not fine for something that can kick off billed AI runs and touch a client's
// live strategy). Rather than carving these paths out of basic-auth.ts's excludedPath
// list — which would be a routing-level change affecting how that shared gate is
// evaluated, and risks nothing else, but is still the kind of shared-infrastructure edit
// worth keeping minimal — this replicates just its cookie check, scoped to these two
// functions only. Same cookie name, same hash, same env var; if BASIC_AUTH_CREDENTIALS
// isn't set (site not password-gated), this lets requests through, matching
// basic-auth.ts's own fail-open behaviour for that case.
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

// Returns true if the request should proceed, false if it should be rejected with 401.
function isAuthorized(event) {
  const credentials = process.env.BASIC_AUTH_CREDENTIALS;
  if (!credentials) return true; // site isn't password-gated — nothing to check
  const cookies = parseCookies((event.headers && (event.headers.cookie || event.headers.Cookie)) || "");
  return cookies[COOKIE_NAME] === sha256Hex(credentials);
}

module.exports = { isAuthorized };
