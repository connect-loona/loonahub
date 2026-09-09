// Tests strategy-run-archive.js — the real backend endpoint replacing the legacy Hub's
// direct-Firebase-write pattern for archive/restore/purge (see that file's own header
// comment and docs/strategy-os-touchpoints.md's "Direct Firebase access" table).
const path = require("path");
const { HUB, RTDB_URL } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";

const crypto = require("crypto");
const { fbSet, fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const runArchive = require(path.join(HUB, "netlify/functions/strategy-run-archive.js"));

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;
function call(body) {
  return runArchive.handler({ httpMethod: "POST", headers: { cookie: authCookie }, body: JSON.stringify(body) });
}

(async () => {
  const runId = "run-archive-test-run";
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "rro", month: "2026-10", status: "failed", owner: "Gokul",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: { research: { status: "failed" } }, approvals: {},
  });

  // ---- Auth / validation ----
  const noAuth = await runArchive.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ runId, action: "archive" }) });
  check("rejects an unauthenticated request", noAuth.statusCode === 401);

  const noRunId = await call({ action: "archive" });
  check("rejects a missing runId", noRunId.statusCode === 400);

  const badAction = await call({ runId, action: "delete-forever" });
  check("rejects an invalid action", badAction.statusCode === 400, JSON.parse(badAction.body));

  // ---- Archive ----
  const archiveRes = await call({ runId, action: "archive", actor: "Gokul", reason: "Duplicate test run." });
  check("archive succeeds", archiveRes.statusCode === 200, JSON.parse(archiveRes.body));
  const afterArchive = await fbGet(`strategy_runs/${runId}`);
  check("archivedAt is set", !!afterArchive.archivedAt, afterArchive.archivedAt);
  check("archivedBy is set to the actor", afterArchive.archivedBy === "Gokul");
  check("archiveReason is set", afterArchive.archiveReason === "Duplicate test run.");
  check("archiving does NOT touch the run's own status field", afterArchive.status === "failed", afterArchive.status);

  // ---- Restore ----
  const restoreRes = await call({ runId, action: "restore", actor: "Gokul" });
  check("restore succeeds", restoreRes.statusCode === 200);
  const afterRestore = await fbGet(`strategy_runs/${runId}`);
  check("archivedAt/archivedBy/archiveReason all cleared", afterRestore.archivedAt == null && afterRestore.archivedBy == null && afterRestore.archiveReason == null, afterRestore);
  check("restoring does NOT touch the run's own status field either", afterRestore.status === "failed");

  // ---- Purge ----
  const purgeRes = await call({ runId, action: "purge", actor: "Gokul" });
  check("purge succeeds", purgeRes.statusCode === 200);
  const afterPurge = await fbGet(`strategy_runs/${runId}`);
  check("the run is actually gone after purge", afterPurge === null, afterPurge);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
