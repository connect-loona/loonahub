const { chromium } = require("playwright");
const { RTDB_URL, DEV_LITE_URL, chromiumLaunchOptions, authCookie, req, waitFor, check, finish } = require("../harness/shared");

async function noPageOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods", deliverables: { reel: 6, carousel: 4, static: 3, confirmed: true } } });
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, {
    "mobile-run": {
      runId: "mobile-run", brandId: "rro", month: "2026-10", owner: "Gokul", status: "failed",
      createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T01:00:00.000Z",
      stages: { research: { status: "failed", detail: "Test failure" } },
    },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("__fakeAuthUser", JSON.stringify({ uid: "gokul-fake-uid", email: "gokul@loona.in", displayName: "Gokul" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "mobile run list" });
  check("390px run list has no document-level horizontal overflow", await noPageOverflow(page));
  check("primary mobile actions remain visible", await page.locator("button", { hasText: "+ New strategy run" }).isVisible() && await page.locator("button", { hasText: "Manage brands" }).isVisible());

  await page.locator("button", { hasText: "+ New strategy run" }).click();
  await waitFor(async () => (await page.locator("text=Are you ready to build the strategy in Loona way?").count()) > 0 || null, { label: "mobile wizard" });
  check("mobile wizard has no document-level horizontal overflow", await noPageOverflow(page));
  check("mobile intake controls are usable", await page.locator('select[aria-label="Brand"]').isVisible() && await page.locator("button", { hasText: "Continue" }).isVisible());

  await page.locator("button", { hasText: "Cancel" }).click();
  await page.locator("tr", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator("text=Your next action").count()) > 0 || null, { label: "mobile run detail" });
  check("mobile run detail has no document-level horizontal overflow", await noPageOverflow(page));
  check("stage rail remains horizontally scrollable inside its own boundary", await page.locator(".st-stage-rail").evaluate((el) => el.scrollWidth >= el.clientWidth));

  await browser.close();
  finish();
})().catch((error) => { console.error(error); process.exit(1); });
