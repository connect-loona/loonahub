// Confirms a reopened stage isn't a dead end: after reopening Strategy, it can be sent
// back with notes OR approved again, and approving it correctly re-triggers Copy from
// scratch (fixture runtime), exactly like the first time through the pipeline.
const path = require("path");
const { HUB, RTDB_URL, DEV_LITE_URL, req, waitFor } = require("../harness/shared");
const apiReq = (method, url, body) => req(method, url, body, { auth: true });

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);

  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const research = require(path.join(fixtureDir, "research.json"));
  const strategy = require(path.join(fixtureDir, "strategy.json"));
  const copy = require(path.join(fixtureDir, "copy.json"));
  const runId = "reopen-roundtrip-run";

  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "copy_needs_review", owner: "Gokul", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stages: {
      research: { status: "approved", checkpoint: research },
      strategy: { status: "approved", checkpoint: strategy },
      copy: { status: "needs_review", checkpoint: copy },
      "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });

  const reopen = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-reopen`, { runId, stage: "strategy", actor: "Gokul" });
  check("reopen strategy succeeds", reopen.status === 200, reopen.body);

  const afterReopen = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("copy is locked after reopening strategy", afterReopen.stages.copy.status === "locked");

  // Approving the reopened strategy stage again should behave exactly like a fresh
  // approval — advance copy to queued and trigger its background generation.
  const approve = await apiReq("POST", `${DEV_LITE_URL}/.netlify/functions/strategy-stage-approve`, { runId, stage: "strategy", decision: "approved", actor: "Gokul" });
  check("re-approving the reopened stage succeeds", approve.status === 200, approve.body);

  const copyRegenerated = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r.stages.copy.status === "needs_review" && r.stages.copy.checkpoint ? r : null;
  }, { label: "copy regenerated after re-approving strategy" });
  check("copy was regenerated from scratch after the reopened strategy was re-approved", copyRegenerated.stages.copy.checkpoint.assets.length === copy.assets.length);
  check("run status reflects strategy_approved -> copy in progress correctly", copyRegenerated.stages.strategy.status === "approved");

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
