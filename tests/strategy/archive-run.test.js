// Verifies strategy-run-start.js's duplicate-active-run guard treats an archived run as no
// longer active — archiving a stale/abandoned run (index.html's soArchiveRun, a direct
// Firebase write setting archivedAt/archivedBy/archiveReason) must free up its brand + month
// for a fresh run without needing its status to change at all.
const path = require("path");
const { HUB, RTDB_URL } = require("../harness/shared");
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
const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");

function startRun() {
  delete require.cache[require.resolve(path.join(HUB, "netlify/functions/strategy-run-start.js"))];
  const runStart = require(path.join(HUB, "netlify/functions/strategy-run-start.js"));
  return runStart.handler({
    httpMethod: "POST",
    headers: { cookie: authCookie },
    body: JSON.stringify({ brandId: "rro", month: "2026-10", actor: "Gokul", runtime: "fixture", fixtureDir }),
  });
}

(async () => {
  await fbSet("strategy_runs", null);

  // ---- 1. A plain "failed" run for this brand + month blocks a new one, same as always ----
  const staleRunId = "rro_2026-10_stale-run";
  await fbSet(`strategy_runs/${staleRunId}`, {
    runId: staleRunId, brandId: "rro", month: "2026-10", status: "failed", owner: "Gokul",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    stages: { research: { status: "failed" } }, approvals: {},
  });
  const blocked = await startRun();
  check("an un-archived stale run still blocks starting a new one (409)", blocked.statusCode === 409, blocked.body);

  // ---- 2. Archiving that run (setting archivedAt, as soArchiveRun does) frees the slot ----
  await fbSet(`strategy_runs/${staleRunId}/archivedAt`, "2026-09-09T00:00:00.000Z");
  await fbSet(`strategy_runs/${staleRunId}/archivedBy`, "Gokul");
  await fbSet(`strategy_runs/${staleRunId}/archiveReason`, "Abandoned test run.");

  const afterArchive = await startRun();
  check("an archived run no longer blocks starting a new one", afterArchive.statusCode === 200, afterArchive.body);
  const newRunId = afterArchive.statusCode === 200 ? JSON.parse(afterArchive.body).runId : null;

  const staleDoc = await fbGet(`strategy_runs/${staleRunId}`);
  check("archiving didn't touch the archived run's own status field", staleDoc.status === "failed", staleDoc.status);

  // ---- 3. The archived run itself, unchanged, still blocks a THIRD run once restored ----
  if (newRunId) await fbSet(`strategy_runs/${newRunId}`, null); // clear the fresh run so only the restored one remains
  await fbSet(`strategy_runs/${staleRunId}/archivedAt`, null);
  await fbSet(`strategy_runs/${staleRunId}/archivedBy`, null);
  await fbSet(`strategy_runs/${staleRunId}/archiveReason`, null);
  const afterRestore = await startRun();
  check("restoring the archived run (clearing archivedAt) makes it block new runs again", afterRestore.statusCode === 409, afterRestore.body);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
