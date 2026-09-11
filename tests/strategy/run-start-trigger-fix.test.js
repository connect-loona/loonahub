// Verifies the two fixes: (1) siteBaseUrl() derives a usable base from the incoming
// request's Host header instead of relying on process.env.URL/DEPLOY_URL, which the live
// site proved unreliable (a run got stuck showing "queued" forever with the old code);
// (2) if the trigger fetch DOES still fail for some other reason, the run doc is marked
// "failed" with a real detail message instead of vanishing into a silently-logged catch.
const path = require("path");
const { HUB, RTDB_URL, sleep } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";

const crypto = require("crypto");
const { fbSet, fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;

(async () => {
  await fbSet("strategy_runs", null);

  // ---- 1. With no Host header AND no env vars, the OLD code would fetch a bare relative
  // path and throw immediately — now surfaced as a "failed" stage instead of silently lost. ----
  delete require.cache[require.resolve(path.join(HUB, "netlify/functions/strategy-run-start.js"))];
  const runStart = require(path.join(HUB, "netlify/functions/strategy-run-start.js"));
  delete process.env.URL;
  delete process.env.DEPLOY_URL;

  const res1 = await runStart.handler({
    httpMethod: "POST",
    headers: { cookie: authCookie, authorization: "Bearer test:gokul%40loona.in:Gokul:gokul-fake-uid" }, // deliberately no host header
    body: JSON.stringify({ brandId: "rro", month: "2026-10", actor: "Gokul", runtime: "fixture", fixtureDir: path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10") }),
  });
  check("run-start still succeeds even if the trigger call itself fails", res1.statusCode === 200, res1);
  const runId1 = JSON.parse(res1.body).runId;
  await sleep(300); // let the failed fbSet calls land
  const doc1 = await fbGet(`strategy_runs/${runId1}`);
  check("with no Host header and no env vars, the run is marked failed (not stuck silently in queued)", doc1.status === "failed" && doc1.stages.research.status === "failed", doc1 && { status: doc1.status, researchStatus: doc1.stages.research.status, detail: doc1.stages.research.detail });

  // ---- 2. With a real Host header pointing at our fake-dev-lite-equivalent server, the
  // trigger should actually succeed and the background function should run for real. ----
  // (We don't have a full dev-lite server running in this quick check, but we can at least
  // confirm siteBaseUrl() builds a URL that isn't the old bare-relative-path failure mode,
  // by checking a request WITH a host header does NOT immediately fail for the same reason —
  // it may still fail to actually reach the background function without a listener there,
  // but the failure mode/error message should be a real network error, not a URL parse error.)
  // Wipe first — run 1 above is still "failed" (active by design, so it's retried rather
  // than silently duplicated), which would otherwise trip the duplicate-active-run guard.
  await fbSet("strategy_runs", null);
  const res2 = await runStart.handler({
    httpMethod: "POST",
    headers: { cookie: authCookie, authorization: "Bearer test:gokul%40loona.in:Gokul:gokul-fake-uid", host: "localhost:9999" }, // nothing listening here either, but it IS a valid absolute URL now
    body: JSON.stringify({ brandId: "rro", month: "2026-10", actor: "Gokul", runtime: "fixture", fixtureDir: path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10") }),
  });
  check("run-start (with Host header) succeeds", res2.statusCode === 200, res2);
  const runId2 = JSON.parse(res2.body).runId;
  await sleep(300);
  const doc2 = await fbGet(`strategy_runs/${runId2}`);
  check("with a Host header, siteBaseUrl() builds a real absolute URL (fails with a connection error, not a URL-parse error)", doc2.stages.research.detail && /ECONNREFUSED|fetch failed/i.test(doc2.stages.research.detail), doc2 && doc2.stages.research.detail);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
