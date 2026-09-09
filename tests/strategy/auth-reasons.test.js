// Verifies checkAuthorization() returns a distinct, safe reason for each failure mode,
// and that strategy-run-start.js actually surfaces it in the 401 response body.
const path = require("path");
const { HUB, RTDB_URL } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL; // unused here but harmless if unset
const crypto = require("crypto");
const { checkAuthorization } = require(path.join(HUB, "netlify/functions/lib/strategy/auth.js"));

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

withEnv(undefined, () => {
  const r = checkAuthorization({ headers: {} });
  check('missing credentials -> ok:false with the "not visible to this function" reason', r.ok === false && /not visible to this function/.test(r.reason), r);
});

withEnv("gokul:supersecret", () => {
  const r = checkAuthorization({ headers: {} });
  check('valid credentials but no cookie -> ok:false with the "no cookie" reason', r.ok === false && /No loona_auth cookie/.test(r.reason), r);
});

withEnv("gokul:supersecret", () => {
  const r = checkAuthorization({ headers: { cookie: "loona_auth=wrongvalue" } });
  check('valid credentials but wrong cookie -> ok:false with the "doesn\'t match" reason', r.ok === false && /doesn't match/.test(r.reason), r);
});

withEnv("gokul:supersecret", () => {
  const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
  const r = checkAuthorization({ headers: { cookie: `loona_auth=${token}` } });
  check("correct cookie -> ok:true with no reason", r.ok === true && r.reason === undefined, r);
});

// ---- End-to-end through the actual function handler ----
withEnv(undefined, () => {
  const modPath = path.join(HUB, "netlify/functions/strategy-run-start.js");
  delete require.cache[require.resolve(modPath)];
  const mod = require(modPath);
  return mod.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ brandId: "rro", month: "2026-10", actor: "Gokul" }) })
    .then((res) => {
      const body = JSON.parse(res.body);
      check("strategy-run-start returns 401 with a reason field when credentials are missing", res.statusCode === 401 && !!body.reason, body);
    });
}).then(() => {
  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
});
