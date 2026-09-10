// Tests strategy-deck-page-update.js and strategy-team-tasks-create.js — the real backend
// endpoints replacing the legacy Hub's direct-Firebase-write patterns for editing a deck
// page's Owner/Production status and for "Create team tasks" (see those files' own header
// comments and docs/strategy-os-touchpoints.md's "Direct Firebase access" table).
const path = require("path");
const { HUB, RTDB_URL } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";

const crypto = require("crypto");
const { fbSet, fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const deckPageUpdate = require(path.join(HUB, "netlify/functions/strategy-deck-page-update.js"));
const teamTasksCreate = require(path.join(HUB, "netlify/functions/strategy-team-tasks-create.js"));

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
  const runId = "deck-team-tasks-test-run";
  await fbSet(`strategy_runs/${runId}`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul", status: "deck-builder_approved",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      "deck-builder": {
        status: "approved",
        checkpoint: {
          title: "October deck", pages: [
            { pageNumber: 1, assetId: "RRO-01", format: "reel", idea: "Concept one", owner: "", productionStatus: "not_started" },
            { pageNumber: 2, assetId: "RRO-02", format: "carousel", idea: "Concept two", owner: "", productionStatus: "not_started" },
          ],
        },
      },
    },
  });
  await fbSet("strategy_brands/rro", { id: "rro", name: "RRO Foods" });
  await fbSet("tasks", null);

  // ---- Deck page update: auth / validation ----
  const noAuth = await deckPageUpdate.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ runId, pageIndex: 0, field: "owner", value: "Gokul" }) });
  check("deck page update rejects an unauthenticated request", noAuth.statusCode === 401);
  const badField = await call(deckPageUpdate, { runId, pageIndex: 0, field: "notAField", value: "x" });
  check("deck page update rejects an invalid field", badField.statusCode === 400);

  // ---- Deck page update: success ----
  const updateRes = await call(deckPageUpdate, { runId, pageIndex: 0, field: "owner", value: "Priya" });
  check("deck page update succeeds", updateRes.statusCode === 200, JSON.parse(updateRes.body));
  const page0 = await fbGet(`strategy_runs/${runId}/stages/deck-builder/checkpoint/pages/0`);
  check("owner field is updated", page0.owner === "Priya", page0);
  check("updating owner didn't touch productionStatus", page0.productionStatus === "not_started");

  const statusRes = await call(deckPageUpdate, { runId, pageIndex: 1, field: "productionStatus", value: "in_progress" });
  check("updating productionStatus on a different page succeeds", statusRes.statusCode === 200);
  const page1 = await fbGet(`strategy_runs/${runId}/stages/deck-builder/checkpoint/pages/1`);
  check("productionStatus field is updated on the right page", page1.productionStatus === "in_progress", page1);
  check("page 0's own edit is untouched by page 1's edit", (await fbGet(`strategy_runs/${runId}/stages/deck-builder/checkpoint/pages/0`)).owner === "Priya");

  // ---- Team tasks: auth / validation ----
  const noAuthTasks = await teamTasksCreate.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ runId }) });
  check("team tasks create rejects an unauthenticated request", noAuthTasks.statusCode === 401);
  const noRunId = await call(teamTasksCreate, {});
  check("team tasks create rejects a missing runId", noRunId.statusCode === 400);

  // ---- Team tasks: success ----
  const tasksRes = await call(teamTasksCreate, { runId, actor: "Gokul" });
  check("team tasks create succeeds", tasksRes.statusCode === 200, JSON.parse(tasksRes.body));
  check("reports the right number of tasks created", JSON.parse(tasksRes.body).tasksCreated === 2);
  const tasks = (await fbGet("tasks")) || {};
  const taskList = Object.values(tasks);
  check("one task was created per deck page", taskList.length === 2, taskList.length);
  check("tasks are assigned to the run's owner", taskList.every((t) => t.member === "Gokul"));
  check("tasks carry the strategy run/asset linkage", taskList.some((t) => t.strategy_run_id === runId && t.strategy_asset_id === "RRO-01"));
  check("task text includes the brand name and idea", taskList.some((t) => t.task.includes("RRO Foods") && t.task.includes("Concept one")), taskList[0] && taskList[0].task);
  const afterTasks = await fbGet(`strategy_runs/${runId}`);
  check("teamTasksCreatedAt is stamped on the run", !!afterTasks.teamTasksCreatedAt, afterTasks.teamTasksCreatedAt);

  // ---- Team tasks: no deck to create from ----
  const emptyRunId = "deck-team-tasks-empty-run";
  await fbSet(`strategy_runs/${emptyRunId}`, { runId: emptyRunId, brandId: "rro", month: "2026-10", owner: "Gokul", stages: {} });
  const emptyRes = await call(teamTasksCreate, { runId: emptyRunId, actor: "Gokul" });
  check("team tasks create rejects a run with no finished deck", emptyRes.statusCode === 400, JSON.parse(emptyRes.body));

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
