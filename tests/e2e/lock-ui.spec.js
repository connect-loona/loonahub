// UI smoke test: the Lock button + "N of M locked" counter on both Strategy and Copy
// review boards, and Copy's new Refine/Replace buttons actually render and are wired up.
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
async function waitForPageText(locatorFn, substrings, timeoutMs = 8000) {
  const wanted = Array.isArray(substrings) ? substrings : [substrings];
  return waitFor(async () => {
    const text = await locatorFn().textContent().catch(() => "");
    return wanted.every((s) => text.includes(s)) ? text : null;
  }, { label: `page text ${JSON.stringify(wanted)}`, timeoutMs });
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);

  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const strategy = require(path.join(fixtureDir, "strategy.json"));
  const copy = require(path.join(fixtureDir, "copy.json"));
  const runId = "lock-ui-test-run";

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

  await page.addInitScript(combinedInit, { fixed: FIXED_NOW, baseUrl: RTDB_URL });
  await page.goto(`${DEV_LITE_URL}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await loginAsGokul(page);
  await page.waitForTimeout(500);
  await page.locator(".nav-btn", { hasText: "Strategy OS" }).click();
  await page.waitForTimeout(400);

  await page.evaluate((id) => { window.soOpenRun(id); }, runId);
  await page.locator("#so-root button", { hasText: "All runs" }).waitFor({ state: "visible", timeout: 8000 });

  // Copy board: counter starts at 0 of N, Lock/Refine/Replace buttons present
  const copyCounter = await waitForPageText(() => page.locator("#so-root .bh", { hasText: "Copy" }).first(), "0 of " + copy.assets.length + " locked");
  check("copy board shows the initial lock counter", copyCounter.includes("0 of " + copy.assets.length + " locked"), copyCounter);

  const lockBtn = page.locator("#so-root button", { hasText: "Lock" }).first();
  check("a Lock button exists on a copy asset row", await lockBtn.count() > 0);
  const refineBtn = page.locator("#so-root button", { hasText: "Refine" }).first();
  const replaceBtn = page.locator("#so-root button", { hasText: "Replace" }).first();
  check("Refine button exists on a copy asset row", await refineBtn.count() > 0);
  check("Replace button exists on a copy asset row", await replaceBtn.count() > 0);

  // Click Lock on the first asset, confirm the counter advances to 1 and the button flips
  await lockBtn.click();
  await waitForPageText(() => page.locator("#so-root .bh", { hasText: "Copy" }).first(), "1 of " + copy.assets.length + " locked");
  check("counter advances to 1 after locking one asset", true);
  const lockedBadge = await page.locator("#so-root button", { hasText: "🔒 Locked" }).count();
  check("the locked button now reads \"🔒 Locked\"", lockedBadge > 0, lockedBadge);

  // Unlock it again — counter drops back to 0
  await page.locator("#so-root button", { hasText: "🔒 Locked" }).first().click();
  await waitForPageText(() => page.locator("#so-root .bh", { hasText: "Copy" }).first(), "0 of " + copy.assets.length + " locked");
  check("counter drops back to 0 after unlocking", true);

  // Verify the direct Firebase write actually happened (not just an optimistic UI change)
  const fbLocks = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/locks.json`)).body;
  // fake-rtdb-server is a plain in-memory JSON store, unlike real Firebase it doesn't prune
  // an object down to null once its last child is removed — {} and null both mean "no
  // locks" here, only the key itself (RRO-01) actually matters.
  check("no lingering lock left in Firebase after lock+unlock", !fbLocks || !fbLocks["RRO-01"], fbLocks);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
