// strategy-brand-library-scan.js — the on-demand "read this brand's Drive folder now"
// endpoint. Before it, the only way to pick up a newly uploaded file was to start a whole
// strategy run, which is the wrong price for checking whether a re-exported deck is readable.
//
// Checks auth, validation, the scanning marker the app watches, and the guard against
// stacking two scans (each one pays real model calls for anything new, so running two at
// once buys the same reading twice).
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { fbGet, fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const scan = require(path.join(HUB, "netlify/functions/strategy-brand-library-scan.js"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;

function call(body, headers) {
  return scan.handler({
    httpMethod: "POST",
    headers: Object.assign({ cookie: authCookie, host: "127.0.0.1:9020", "x-forwarded-proto": "http" }, headers || {}),
    body: JSON.stringify(body),
  });
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_brand_library.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });

  // ---- Auth: this triggers billed model calls, so it must not be open ----
  const noAuth = await scan.handler({ httpMethod: "POST", headers: { host: "127.0.0.1:9020" }, body: JSON.stringify({ brandId: "rro" }) });
  check("rejects an unauthenticated caller", noAuth.statusCode === 401, noAuth.statusCode);

  // ---- Validation ----
  const badId = await call({ brandId: "RRO Foods!" });
  check("rejects a malformed brandId", badId.statusCode === 400, badId.body);

  const missing = await call({ brandId: "not-a-brand" });
  check("404s for a brand that doesn't exist", missing.statusCode === 404, missing.body);

  // NOTE ON TIMING: this harness runs "-background" functions synchronously (see
  // tests/harness/netlify-dev-lite.js), so by the time handler() returns, the background
  // scan has already run to completion. In production it is genuinely asynchronous. That
  // means the in-flight `scanning: true` marker can't be observed here after the call — so
  // the guard that reads it is tested by seeding that state directly, which is what the
  // endpoint actually reads anyway.

  // ---- A real scan is accepted, and the start is recorded ----
  const ok = await call({ brandId: "rro", actor: "Gokul" });
  check("accepts a scan for a real brand", ok.statusCode === 202, ok.body);
  const marked = await fbGet("strategy_brand_library/rro");
  check("the start time is recorded for the app to show", Boolean(marked.scanStartedAt), marked.scanStartedAt);

  // The background scan failed here (no Drive credentials in this environment), which is
  // the useful half to prove: a failure must clear the flag and keep its reason, or the app
  // would sit showing "Scanning…" forever with nothing running.
  check("a failed scan clears the scanning flag", marked.scanning === false, marked.scanning);
  check("a failed scan records why, where the app can show it", /GOOGLE_DRIVE/.test(marked.scanError || ""), marked.scanError);

  // ---- A second scan while one is genuinely in flight is refused, not stacked ----
  await fbSet("strategy_brand_library/rro", {
    brandId: "rro", scanning: true, scanStartedAt: new Date().toISOString(),
  });
  const second = await call({ brandId: "rro", actor: "Gokul" });
  check("refuses to stack a second scan on top of a running one", second.statusCode === 409, second.body);

  // ---- A scan that never finished must not wedge the button forever ----
  await fbSet("strategy_brand_library/rro", {
    brandId: "rro", scanning: true, scanStartedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
  });
  const afterStale = await call({ brandId: "rro", actor: "Gokul" });
  check("a scan older than 20 minutes is treated as dead, so a new one can start", afterStale.statusCode === 202, afterStale.body);

  // ---- Starting a scan must not destroy what's already known ----
  // A brand mid-scan should still show its last good index, not go blank.
  await fbSet("strategy_brand_library/rro", {
    brandId: "rro", folderName: "RRO", fileCount: 22, textFileCount: 9, indexedAt: "2026-09-11T06:00:00.000Z",
    scanError: "an older failure",
  });
  await call({ brandId: "rro", actor: "Gokul" });
  const preserved = await fbGet("strategy_brand_library/rro");
  check("the previous index survives a new scan starting", preserved.fileCount === 22 && preserved.textFileCount === 9, preserved);
  check("a previous scanError is cleared when a new scan starts", preserved.scanError !== "an older failure", preserved.scanError);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
