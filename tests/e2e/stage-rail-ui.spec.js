// Regression test for the strategy-ui.js numbered stage rail: it used to freeze on stage 1
// (Research) whenever a run's TOP-LEVEL status was the bare "failed" string (which is what
// pipeline.js's executeStage actually writes once a stage's repair loop is exhausted, for
// EVERY stage, not just research) — the rail's old current-index logic pattern-matched that
// string against STAGE_KEYS prefixes, and "failed" doesn't start with any of them, so it
// silently fell through to index 0 no matter which stage really failed. It also verifies the
// "Your next action" card correctly lands in strategy-ui.js's review sidebar instead of the
// sidebar's generic "This stage is already approved or still running." fallback text.
const { chromium } = require("playwright");
const {
  RTDB_URL, DEV_LITE_URL, FIXED_NOW,
  req, chromiumLaunchOptions, combinedInit, blockRealFirebaseSdk, authCookie, loginAsGokul,
} = require("../harness/shared");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);

  // Craft a run where COPY has genuinely failed — top-level status is the bare "failed"
  // string pipeline.js actually writes, research/strategy are approved, everything after
  // copy is still locked. This is exactly the shape a real failed run has in production.
  const runId = "rro_2026-10_stage-rail-test";
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    status: "failed",
    stages: {
      research: { status: "approved", checkpoint: { assets: [] } },
      strategy: { status: "approved", checkpoint: { assets: [] } },
      copy: { status: "failed", detail: "copy failed validation: - A-07 uses language matching claim rule availability-geography without configured approval or a flag." },
      "creative-direction": { status: "locked" },
      "deck-builder": { status: "locked" },
    },
    approvals: {},
  });
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, {
    rro: { id: "rro", name: "RRO Foods", oneLineTruth: "test", audiences: [], portfolios: [], deliverables: {} },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 1600 } });
  await context.addCookies([authCookie()]);
  await blockRealFirebaseSdk(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.addInitScript(combinedInit, { fixed: FIXED_NOW, baseUrl: RTDB_URL });
  await page.goto(`${DEV_LITE_URL}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await loginAsGokul(page);
  await page.waitForTimeout(500);
  await page.locator(".nav-btn", { hasText: "Strategy OS" }).click();
  await page.waitForTimeout(400);

  await page.evaluate((id) => { window.soOpenRun(id); }, runId);
  await page.locator(".so-stage-rail").waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(300); // let the MutationObserver-driven decorate() pass settle

  const railText = await page.locator(".so-stage-rail").textContent();
  check("rail shows the current label set (Deck, not the stale \"Canva deck\")", railText.includes("Deck") && !railText.includes("Canva deck"), railText);

  const activeStep = await page.locator(".so-stage-step.is-active").textContent();
  check("rail highlights Copy as active (the stage that actually failed), not Research", activeStep.includes("Copy"), activeStep);

  const doneSteps = await page.locator(".so-stage-step.is-done").allTextContents();
  check("Research and Strategy are marked done (already approved)", doneSteps.some((t) => t.includes("Research")) && doneSteps.some((t) => t.includes("Strategy")), doneSteps);

  const stripHidden = await page.locator("#so-stage-strip").isHidden().catch(() => null);
  check("the old box-grid stage strip is hidden (replaced by the rail)", stripHidden === true, stripHidden);

  const reviewText = await page.locator(".so-review-panel").textContent();
  check("review sidebar shows the REAL \"Your next action\" card, not the generic fallback", reviewText.includes("Your next action") && !reviewText.includes("already approved or still running"), reviewText.slice(0, 200));

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
