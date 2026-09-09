// Reproduces the reported bug: open a run's detail page, go back to the plain run list —
// the list page should NOT show detail-page furniture (Brand memory / Review status
// sidebars, the numbered stage rail) built from the run you just left. That happened
// because window._soCurrentRun (a global strategy-ui.js reads to build the workspace)
// was never cleared by soBackToList().
const path = require("path");
const { chromium } = require("playwright");
const {
  HUB, RTDB_URL, DEV_LITE_URL, FIXED_NOW,
  req, chromiumLaunchOptions, combinedInit, blockRealFirebaseSdk, authCookie, loginAsGokul,
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
  const runId = "stale-workspace-test-run";

  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "strategy_needs_review", owner: "Gokul", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      research: { status: "approved" },
      strategy: { status: "needs_review", checkpoint: strategy },
      copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
  });
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, {
    rro: { id: "rro", name: "RRO Foods", oneLineTruth: "test truth", audiences: [], portfolios: [], deliverables: {} },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 1800 } });
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

  // Confirm the plain list page has NO workspace furniture before touching any run.
  check("list page has no Brand memory sidebar before opening a run", await page.locator("#so-root", { hasText: "Brand memory" }).count() === 0);

  // Open the run — its detail page SHOULD show Brand memory / the stage rail.
  await page.evaluate((id) => { window.soOpenRun(id); }, runId);
  await page.locator("#so-root button", { hasText: "All runs" }).waitFor({ state: "visible", timeout: 8000 });
  await page.locator(".so-stage-rail").waitFor({ state: "visible", timeout: 8000 });
  check("detail page correctly shows Brand memory", await page.locator("#so-root", { hasText: "Brand memory" }).count() > 0);

  // Go back to the list — this is the exact reported bug.
  await page.evaluate(() => { window.soBackToList(); });
  await page.waitForTimeout(600);

  check("window._soCurrentRun was actually cleared", await page.evaluate(() => window._soCurrentRun === null));
  check("list page shows \"All monthly strategies\" (the real list content)", (await page.locator("#so-root", { hasText: "trategies" }).count()) > 0);
  check("list page does NOT show the leftover Brand memory sidebar", await page.locator("#so-root .so-workspace-side", { hasText: "Brand memory" }).count() === 0);
  check("list page does NOT show the leftover numbered stage rail", await page.locator(".so-stage-rail").count() === 0);
  check("list page does NOT show the leftover Review status sidebar", await page.locator("#so-root", { hasText: "Review status" }).count() === 0);
  check("the \"+ New monthly strategy\" button is there (real list-page furniture)", await page.locator("#so-root button", { hasText: "New monthly strategy" }).count() > 0);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
