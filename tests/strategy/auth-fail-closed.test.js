// Verifies netlify/functions/lib/strategy/auth.js fails CLOSED on missing/malformed
// BASIC_AUTH_CREDENTIALS, matching basic-auth.ts's own fail-closed behavior for the rest
// of Hub's edge gate.
const path = require("path");
const { HUB } = require("../harness/shared");
const { isAuthorized } = require(path.join(HUB, "netlify/functions/lib/strategy/auth.js"));
const crypto = require("crypto");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra) : ""));
  allPass = allPass && cond;
}

function withEnv(value, fn) {
  const prev = process.env.BASIC_AUTH_CREDENTIALS;
  if (value === undefined) delete process.env.BASIC_AUTH_CREDENTIALS;
  else process.env.BASIC_AUTH_CREDENTIALS = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.BASIC_AUTH_CREDENTIALS;
    else process.env.BASIC_AUTH_CREDENTIALS = prev;
  }
}

// ---- Missing credentials: fail closed (matches basic-auth.ts's 503 behavior) ----
withEnv(undefined, () => {
  check("missing BASIC_AUTH_CREDENTIALS fails closed", isAuthorized({ headers: {} }) === false);
});

// ---- Malformed credentials (no colon): fail closed ----
withEnv("nocolonhere", () => {
  check("a credentials string with no colon fails closed", isAuthorized({ headers: {} }) === false);
});

// ---- Malformed credentials (colon at start): fail closed ----
withEnv(":password", () => {
  check("a credentials string with an empty username fails closed", isAuthorized({ headers: {} }) === false);
});

// ---- Malformed credentials (colon at end): fail closed ----
withEnv("username:", () => {
  check("a credentials string with an empty password fails closed", isAuthorized({ headers: {} }) === false);
});

// ---- Valid credentials, no cookie: rejected ----
withEnv("gokul:supersecret", () => {
  check("valid credentials but no cookie is rejected", isAuthorized({ headers: {} }) === false);
});

// ---- Valid credentials, wrong cookie: rejected ----
withEnv("gokul:supersecret", () => {
  check("valid credentials but a wrong cookie is rejected", isAuthorized({ headers: { cookie: "loona_auth=wrong" } }) === false);
});

// ---- Valid credentials, correct cookie: authorized ----
withEnv("gokul:supersecret", () => {
  const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
  check("valid credentials with the correct cookie is authorized", isAuthorized({ headers: { cookie: `loona_auth=${token}` } }) === true);
  check("the check also works reading a capitalized Cookie header", isAuthorized({ headers: { Cookie: `loona_auth=${token}` } }) === true);
});

console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
process.exit(allPass ? 0 : 1);
