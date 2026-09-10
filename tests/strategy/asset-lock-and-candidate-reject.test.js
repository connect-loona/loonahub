// Tests strategy-asset-lock.js and strategy-concept-candidate-reject.js — the real backend
// endpoints replacing the legacy Hub's direct-Firebase-write patterns for the per-asset
// lock toggle and "Discard suggestion" on a ready candidate (see those files' own header
// comments and docs/strategy-os-touchpoints.md's "Direct Firebase access" table).
const path = require("path");
const { HUB, RTDB_URL } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";

const crypto = require("crypto");
const { fbSet, fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const assetLock = require(path.join(HUB, "netlify/functions/strategy-asset-lock.js"));
const candidateReject = require(path.join(HUB, "netlify/functions/strategy-concept-candidate-reject.js"));

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;
function call(fn, body) {
  return fn.handler({ httpMethod: "POST", headers: { cookie: authCookie }, body: JSON.stringify(body) });
}

(async () => {
  const runId = "asset-lock-test-run";
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "rro", month: "2026-10", status: "strategy_needs_review", owner: "Gokul",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      strategy: {
        status: "needs_review",
        checkpoint: { assets: [{ assetId: "RRO-01" }] },
        candidates: { "RRO-01": { status: "ready", candidate: { conceptName: "Test" } } },
      },
    },
  });

  // ---- Auth ----
  const noAuth = await assetLock.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ runId, stage: "strategy", assetId: "RRO-01", locked: true }) });
  check("lock endpoint rejects an unauthenticated request", noAuth.statusCode === 401);
  const noAuthReject = await candidateReject.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ runId, stage: "strategy", assetId: "RRO-01" }) });
  check("candidate-reject endpoint rejects an unauthenticated request", noAuthReject.statusCode === 401);

  // ---- Validation ----
  const missingFields = await call(assetLock, { runId, locked: true });
  check("lock endpoint rejects a missing stage/assetId", missingFields.statusCode === 400);

  // ---- Lock ----
  const lockRes = await call(assetLock, { runId, stage: "strategy", assetId: "RRO-01", actor: "Gokul", locked: true });
  check("locking succeeds", lockRes.statusCode === 200, JSON.parse(lockRes.body));
  const afterLock = await fbGet(`strategy_runs/${runId}/stages/strategy/locks/RRO-01`);
  check("lock is set with lockedBy the actor", !!afterLock && afterLock.lockedBy === "Gokul", afterLock);

  // ---- Unlock ----
  const unlockRes = await call(assetLock, { runId, stage: "strategy", assetId: "RRO-01", actor: "Gokul", locked: false });
  check("unlocking succeeds", unlockRes.statusCode === 200);
  const afterUnlock = await fbGet(`strategy_runs/${runId}/stages/strategy/locks/RRO-01`);
  check("lock is cleared", afterUnlock === null, afterUnlock);

  // ---- Candidate reject ----
  const rejectRes = await call(candidateReject, { runId, stage: "strategy", assetId: "RRO-01" });
  check("rejecting a candidate succeeds", rejectRes.statusCode === 200, JSON.parse(rejectRes.body));
  const afterReject = await fbGet(`strategy_runs/${runId}/stages/strategy/candidates/RRO-01`);
  check("the candidate is cleared", afterReject === null, afterReject);
  const stillReject = await call(candidateReject, { runId, stage: "strategy", assetId: "RRO-01" });
  check("rejecting an already-cleared candidate is still a success (idempotent)", stillReject.statusCode === 200);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
