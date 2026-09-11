// e2e coverage for BrandMemory.tsx's Drive library status line — every stage agent
// actually reads a brand's Drive folder as reference material (see google-drive.js/
// pipeline.js), but that was previously invisible from the app itself: the only way to
// check was Netlify's function logs or the Firebase console. This proves the run detail
// screen now surfaces strategy_brand_library/<brandId> (written by loadBrandLibrary())
// directly, both when it's connected and when it failed.
//
// Requires `npx vite build --mode test` to have been run in apps/strategy/ first (see
// tests/run-all.js).
const { chromium } = require("playwright");
const {
  RTDB_URL, DEV_LITE_URL, chromiumLaunchOptions, authCookie, req, waitFor,
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

function seedRun(runId) {
  return req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul", status: "strategy_needs_review",
    runtime: "fixture", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      research: { status: "approved", checkpoint: { arguments: [] } },
      strategy: { status: "needs_review", checkpoint: { monthThesis: "T", assets: [] }, locks: {} },
    },
    approvals: {},
  });
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brand_library.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // ---- 1. No library doc yet (no stage has ever run for this brand) — nothing shown ----
  await seedRun("brand-library-status-run-1");
  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "run list renders" });
  await page.locator("tr", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator(".st-workspace-side").count()) > 0 || null, { label: "brand memory sidebar renders" });
  check("no Drive status shown when nothing has ever been indexed", await page.locator("text=file indexed from").count() + await page.locator("text=files indexed from").count() + await page.locator("text=Drive folder not connected").count() === 0);

  // ---- 2. A successful read shows file count + folder name ----
  await req("PUT", `${RTDB_URL}/strategy_brand_library/rro.json`, {
    brandId: "rro", folderId: "abc123", folderName: "RRO Foods", folderUrl: "https://drive.google.com/drive/folders/abc123",
    indexedAt: "2026-09-11T06:00:00.000Z", fileCount: 12, textFileCount: 9, truncated: false,
  });
  await waitFor(async () => (await page.locator("text=files indexed from RRO Foods").count()) > 0 || null, { label: "success status renders" });
  check("success status shows the file count and folder name", true);
  check("success status is NOT shown in an error color context", await page.locator("text=Drive folder not connected").count() === 0);

  // ---- 3. A failed read (e.g. missing env var, or no matching folder) shows the error ----
  await req("PUT", `${RTDB_URL}/strategy_brand_library/rro.json`, {
    brandId: "rro", indexedAt: null, stale: false, refreshError: "GOOGLE_DRIVE_BRANDS_FOLDER_ID is not configured.", files: [],
  });
  await waitFor(async () => (await page.locator("text=Drive folder not connected").count()) > 0 || null, { label: "failure status renders" });
  check("failure status names the real backend error", (await page.locator(".st-workspace-side").textContent()).includes("GOOGLE_DRIVE_BRANDS_FOLDER_ID is not configured."));

  // ---- 4. A stale cached read (previous success, latest refresh failed) is labelled as such ----
  await req("PUT", `${RTDB_URL}/strategy_brand_library/rro.json`, {
    brandId: "rro", folderName: "RRO Foods", indexedAt: "2026-09-10T00:00:00.000Z", fileCount: 5, stale: true,
    refreshError: "Google Drive request failed (403).",
  });
  await waitFor(async () => (await page.locator("text=last successful read").count()) > 0 || null, { label: "stale status renders" });
  check("stale status is labelled as showing the last successful read", true);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
