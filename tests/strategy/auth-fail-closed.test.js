const path = require("path");
const crypto = require("crypto");
const { HUB, RTDB_URL, TEST_BEARER, check, finish } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
const { isAuthorized } = require(path.join(HUB, "netlify/functions/lib/strategy/auth.js"));

function event(cookie, bearer = TEST_BEARER) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return { headers };
}

(async () => {
  const previous = process.env.BASIC_AUTH_CREDENTIALS;
  delete process.env.BASIC_AUTH_CREDENTIALS;
  check("missing Hub credentials fails closed", !(await isAuthorized(event())));
  process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
  const hash = crypto.createHash("sha256").update(process.env.BASIC_AUTH_CREDENTIALS).digest("hex");
  check("missing perimeter cookie is rejected", !(await isAuthorized(event(null))));
  check("wrong perimeter cookie is rejected", !(await isAuthorized(event("loona_auth=wrong"))));
  check("missing Firebase bearer is rejected", !(await isAuthorized(event(`loona_auth=${hash}`, null))));
  check("invalid Firebase bearer is rejected", !(await isAuthorized(event(`loona_auth=${hash}`, "not-a-test-token"))));
  check("valid Hub and Firebase authentication is accepted", await isAuthorized(event(`loona_auth=${hash}`)));
  if (previous === undefined) delete process.env.BASIC_AUTH_CREDENTIALS; else process.env.BASIC_AUTH_CREDENTIALS = previous;
  finish();
})().catch((error) => { console.error(error); process.exit(1); });
