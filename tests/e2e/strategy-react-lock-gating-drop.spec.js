// e2e coverage for the "only locked things advance" confirm dialog (NextActionCard.tsx) —
// approving a stage with SOME, but not all, assets locked now warns that the unlocked ones
// will be DROPPED from the run entirely (not just "continue anyway"), and dismissing it
// leaves everything untouched. See pipeline.js's applyLockFilterOnApprove for the full
// backend rule; tests/strategy/lock-gating-approve.test.js covers that directly — this
// proves the warning actually reaches the reviewer in the real UI, with the real wording.
//
// Requires `npx vite build --mode test` to have been run in apps/strategy/ first (see
// tests/run-all.js).
const path = require("path");
const { chromium } = require("playwright");
const {
  HUB, RTDB_URL, DEV_LITE_URL, chromiumLaunchOptions, authCookie, req, waitFor,
} = require("../harness/shared");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

async function loginAsFakeUser(page) {
  await page.evaluate(() => {
    localStorage.setItem("__fakeAuthUser", JSON.stringify({ uid: "gokul-fake-uid", email: "gokul@loona.in", displayName: "Gokul" }));
  });
}

(async () => {
  const runId = "react-lock-gating-drop-test-run";
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const strategyFixture = require(path.join(fixtureDir, "strategy.json"));

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul", status: "strategy_needs_review",
    runtime: "fixture", fixtureDir,
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      research: { status: "approved", checkpoint: { arguments: [] } },
      // Only RRO-01 locked — a partial lock, which is exactly the case that should now
      // warn about dropping the rest.
      strategy: { status: "needs_review", checkpoint: strategyFixture, locks: { "RRO-01": { lockedAt: new Date().toISOString(), lockedBy: "Gokul" } } },
    },
    approvals: {},
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "run list renders" });
  await page.locator(".st-run-card", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator(".st-review-panel").count()) > 0 || null, { label: "run detail renders" });

  // ---- 1. Dismissing the warning leaves everything untouched ----
  let dialogLog = [];
  let nextAction = "dismiss";
  page.on("dialog", async (dialog) => {
    dialogLog.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "confirm" && nextAction === "dismiss") await dialog.dismiss();
    else if (dialog.type() === "confirm") await dialog.accept();
    else await dialog.dismiss();
  });

  await page.locator(".st-review-panel button", { hasText: "Approve" }).click();
  await page.waitForTimeout(300);
  const warning = dialogLog.find((d) => d.type === "confirm");
  check("a warning dialog fires for a partial lock", !!warning, dialogLog);
  check("it names how many will actually move forward (1)", warning && warning.message.includes("1 locked"), warning);
  check("it names how many will be dropped (12)", warning && warning.message.includes("12"), warning);
  check("it says the dropped ones are gone for good, not just a soft skip", warning && warning.message.toLowerCase().includes("dropped") && warning.message.toLowerCase().includes("can't be undone"), warning);

  const runAfterDismiss = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("dismissing leaves the stage untouched (still needs_review, all 13 still there)", runAfterDismiss.stages.strategy.status === "needs_review" && runAfterDismiss.stages.strategy.checkpoint.assets.length === strategyFixture.assets.length, runAfterDismiss.stages.strategy.status);

  // ---- 2. Accepting the warning actually drops the unlocked ones ----
  dialogLog = [];
  nextAction = "accept";
  await page.locator(".st-review-panel button", { hasText: "Approve" }).click();
  const approvedRun = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages.strategy.status === "approved" ? r : null;
  }, { label: "strategy approved after accepting the drop warning" });
  check("only the locked asset (RRO-01) survived", approvedRun.stages.strategy.checkpoint.assets.length === 1 && approvedRun.stages.strategy.checkpoint.assets[0].assetId === "RRO-01", approvedRun.stages.strategy.checkpoint.assets);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
