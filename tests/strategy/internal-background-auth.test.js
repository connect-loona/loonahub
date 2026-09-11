const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { signedHeaders, verifyInternalRequest, MAX_CLOCK_SKEW_MS } = require(path.join(HUB, "netlify/functions/lib/strategy/internal-auth"));

const now = Date.UTC(2026, 8, 11, 12, 0, 0);
const body = JSON.stringify({ runId: "signed-run" });
const headers = signedHeaders(body, now);

check("a correctly signed body is accepted", verifyInternalRequest({ headers, body }, now).ok === true);
check("changing the body invalidates the signature", verifyInternalRequest({ headers, body: JSON.stringify({ runId: "other-run" }) }, now).ok === false);
check("an unsigned request is rejected", verifyInternalRequest({ headers: {}, body }, now).ok === false);
check("a replay outside the clock window is rejected", verifyInternalRequest({ headers, body }, now + MAX_CLOCK_SKEW_MS + 1).ok === false);

const previous = process.env.STRATEGY_INTERNAL_SECRET;
delete process.env.STRATEGY_INTERNAL_SECRET;
check("missing signing configuration fails closed", verifyInternalRequest({ headers, body }, now).ok === false);
process.env.STRATEGY_INTERNAL_SECRET = previous;
finish();
