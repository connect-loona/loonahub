// UI test: clicking a DONE step in the numbered stage rail triggers the confirm dialog and
// (on confirm) actually calls strategy-stage-reopen and resets the run live. Clicking the
// active/future steps does nothing.
const path = require("path");
const { chromium } = require("playwright");
const {
  HUB, RTDB_URL, DEV_LITE_URL, FIXED_NOW,
  req, waitFor, chromiumLaunchOptions, combinedInit, blockRealFirebaseSdk, authCookie, loginAsGokul,
} = require("../harness/shared");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);

  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const strategy = require(path.join(fixtureDir, "strategy.json"));
  const copy = require(path.join(fixtureDir, "copy.json"));
  const runId = "reopen-ui-test-run";

  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "copy_needs_review", owner: "Gokul", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      research: { status: "approved" },
      strategy: { status: "approved", checkpoint: strategy },
      copy: { status: "needs_review", checkpoint: copy },
      "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, {
    rro: { id: "rro", name: "RRO Foods", oneLineTruth: "test", audiences: [], portfolios: [], deliverables: {} },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 2200 } });
  await context.addCookies([authCookie()]);
  await blockRealFirebaseSdk(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Auto-accept the confirm() and capture the prompt() call without answering it yet —
  // we'll flip this per-step below.
  let dialogLog = [];
  page.on("dialog", async (dialog) => {
    dialogLog.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "confirm") await dialog.accept();
    else if (dialog.type() === "prompt") await dialog.accept("Testing the reopen flow.");
    else await dialog.dismiss();
  });

  await page.addInitScript(combinedInit, { fixed: FIXED_NOW, baseUrl: RTDB_URL });
  await page.goto(`${DEV_LITE_URL}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await loginAsGokul(page);
  await page.waitForTimeout(500);
  await page.locator(".nav-btn", { hasText: "Strategy OS" }).click();
  await page.waitForTimeout(400);

  await page.evaluate((id) => { window.soOpenRun(id); }, runId);
  await page.locator("#so-root button", { hasText: "All runs" }).waitFor({ state: "visible", timeout: 8000 });
  await page.locator(".so-stage-rail").waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(300);

  // Clicking the ACTIVE step (Copy, index 2) should do nothing — it's not .is-clickable.
  const activeStep = page.locator(".so-stage-step.is-active");
  check("active step is not marked clickable", !(await activeStep.evaluate((el) => el.classList.contains("is-clickable"))));
  await activeStep.click({ force: true });
  await page.waitForTimeout(300);
  check("clicking the active step did not open any dialog", dialogLog.length === 0, dialogLog);

  // Clicking a DONE step (Strategy, index 1) should confirm+prompt, then actually reopen.
  const doneSteps = page.locator(".so-stage-step.is-done");
  check("two steps (Research, Strategy) are marked done and clickable", await doneSteps.count() === 2);
  const strategyStep = doneSteps.nth(1); // Research=0, Strategy=1
  await strategyStep.click();

  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages.strategy.status === "needs_review" ? r : null;
  }, { label: "reopen lands in Firebase" }).then(
    () => check("clicking the done Strategy step actually reopened it", true),
    () => check("clicking the done Strategy step actually reopened it", false),
  );
  check("confirm dialog fired with the expected warning", dialogLog.some((d) => d.type === "confirm" && d.message.includes("Reopen") && d.message.includes("Copy")), dialogLog);
  check("notes prompt fired", dialogLog.some((d) => d.type === "prompt"), dialogLog);

  const runAfter = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("copy got reset to locked by the click-triggered reopen", runAfter.stages.copy.status === "locked", runAfter.stages.copy.status);

  // The page should live-update: rail's active step should now be Strategy, and the
  // stale Copy review board should be gone (nothing to review yet for a locked stage).
  const railUpdated = await waitFor(async () => {
    const text = await page.locator(".so-stage-step.is-active").textContent().catch(() => "");
    return text.includes("Strategy") ? text : null;
  }, { label: "rail shows Strategy active again" }).catch(() => null);
  check("rail live-updates to show Strategy as active again", !!railUpdated, railUpdated);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
