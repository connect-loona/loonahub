const path = require("path");
const crypto = require("crypto");
const { HUB, RTDB_URL, TEST_BEARER, check, finish } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
const { checkAuthorization } = require(path.join(HUB, "netlify/functions/lib/strategy/auth.js"));

(async () => {
  delete process.env.BASIC_AUTH_CREDENTIALS;
  let result = await checkAuthorization({ headers: {} });
  check("missing perimeter configuration returns a safe reason", result.ok === false && result.reason === "Strategy authentication is unavailable.", result);
  process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
  const hash = crypto.createHash("sha256").update(process.env.BASIC_AUTH_CREDENTIALS).digest("hex");
  result = await checkAuthorization({ headers: { cookie: `loona_auth=${hash}` } });
  check("missing Firebase session returns a safe reason", result.ok === false && /Firebase sign-in/.test(result.reason), result);
  result = await checkAuthorization({ headers: { cookie: `loona_auth=${hash}`, authorization: `Bearer ${TEST_BEARER}` } });
  check("verified session resolves the server-owned actor", result.ok === true && result.actor === "Gokul" && result.email === "gokul@loona.in", result);
  const mod = require(path.join(HUB, "netlify/functions/strategy-run-start.js"));
  delete process.env.BASIC_AUTH_CREDENTIALS;
  const response = await mod.handler({ httpMethod: "POST", headers: {}, body: "{}" });
  check("the endpoint surfaces only the safe 401 reason", response.statusCode === 401 && JSON.parse(response.body).reason === "Strategy authentication is unavailable.", JSON.parse(response.body));
  finish();
})().catch((error) => { console.error(error); process.exit(1); });
