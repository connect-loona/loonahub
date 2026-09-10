// e2e coverage for three related additions to the React run-detail screen at /strategy/:
//
// 1. "Your next action" now renders full-width above the numbered stage rail, not as a
//    sidebar column next to it (see RunDetail.tsx).
// 2. Approving Strategy/Copy while assets are still unlocked now confirms first — dismissing
//    leaves the stage untouched, accepting proceeds (see NextActionCard.tsx's unlockedCount()).
// 3. The Copy stage's per-asset actions: a "Suggest another" button (mirrors Strategy's
//    "Suggest similar"), a "Captions" subheading, and per-caption/script "Refine this" links
//    that target one specific part of the asset (see CopyReview.tsx / strategy-concept-
//    propose.js's `focus` field).
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
  const runId = "react-lock-gate-test-run";
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  // The real strategy fixture, not a hand-rolled stand-in — approving this stage below
  // triggers the REAL copy stage generation for real (same fixture runtime/fixtureDir), and
  // that fixture's copy.json is only valid against this exact strategy asset list (asset
  // count, format, portfolioId and skuIds all have to line up — see validateCopy).
  const strategyFixture = require(path.join(fixtureDir, "strategy.json"));

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul", status: "strategy_needs_review",
    runtime: "fixture", fixtureDir,
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      research: { status: "approved", checkpoint: { arguments: [] } },
      strategy: { status: "needs_review", checkpoint: strategyFixture, locks: {} },
    },
    approvals: {},
  });
  const assetCount = strategyFixture.assets.length;

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
  await page.locator("tr", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator(".st-stage-rail").count()) > 0 || null, { label: "run detail renders" });

  // ---- 1. Layout: "Your next action" sits above the numbered stage rail ----
  const actionTop = await page.locator(".st-review-panel").boundingBox();
  const railTop = await page.locator(".st-stage-rail").boundingBox();
  check("\"Your next action\" renders above the stage rail", actionTop && railTop && actionTop.y < railTop.y, { actionTop, railTop });
  check("\"Your next action\" spans (roughly) the full width, not a narrow sidebar column", actionTop && railTop && actionTop.width > railTop.width * 0.9, { actionWidth: actionTop && actionTop.width, railWidth: railTop && railTop.width });

  // ---- 2. Approving with assets still unlocked confirms first ----
  let dialogLog = [];
  let dismissNextConfirm = true;
  page.on("dialog", async (dialog) => {
    dialogLog.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "confirm" && dismissNextConfirm) { dismissNextConfirm = false; await dialog.dismiss(); }
    else if (dialog.type() === "confirm") await dialog.accept();
    else if (dialog.type() === "prompt") await dialog.accept("Test note.");
    else await dialog.dismiss();
  });

  await page.locator(".st-review-panel button", { hasText: "Approve" }).click();
  await page.waitForTimeout(300); // dialog handling is async; give the dismiss a moment to land
  check("confirm dialog fired warning about unlocked assets", dialogLog.some((d) => d.type === "confirm" && d.message.includes(String(assetCount)) && d.message.toLowerCase().includes("not locked")), dialogLog);
  const runAfterDismiss = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("dismissing the confirm leaves the stage untouched (still needs_review)", runAfterDismiss.stages.strategy.status === "needs_review", runAfterDismiss.stages.strategy.status);

  await page.locator(".st-review-panel button", { hasText: "Approve" }).click();
  const approvedRun = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages.strategy.status === "approved" ? r : null;
  }, { label: "strategy approved after accepting the confirm" });
  check("accepting the confirm proceeds to approve", approvedRun.stages.strategy.status === "approved");

  // ---- 3. Copy stage: "Suggest another", "Captions" subheading, targeted "Refine this" ----
  // Approving strategy above already queued the copy stage and fired its background
  // function for real (same fixture runtime/fixtureDir) — wait for that to land rather
  // than writing over it directly, which would race the in-flight generation.
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages.copy && r.stages.copy.status === "needs_review" && r.stages.copy.checkpoint ? r : null;
  }, { label: "copy stage auto-generated and reached needs_review", timeoutMs: 20000 });
  // App.tsx's view state is plain in-memory useState (no URL routing) — a full page reload
  // resets it back to the run list, so re-open the run rather than expecting the reload to
  // land back on its detail view.
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "back on the run list after reload" });
  await page.locator("tr", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator("text=Captions").count()) > 0 || null, { label: "copy review renders with the Captions subheading" });
  check('"Captions" subheading renders on each copy card', await page.locator("text=Captions").count() > 0);
  check('"Suggest another" button is offered on copy cards', await page.locator("button", { hasText: "Suggest another" }).count() > 0);

  const rro01Row = page.locator(".st-concept-row", { hasText: "RRO-01" });
  await rro01Row.locator('a[aria-label="Refine Caption A"]').click();
  await waitFor(async () => (await rro01Row.locator("text=Focused on:").count()) > 0 || null, { label: "refine box shows what it's focused on" });
  check("targeted refine box names the focused caption", (await rro01Row.locator("text=Focused on:").textContent()).includes("Caption A"));
  await rro01Row.locator("textarea").fill("Add a clear CTA at the end.");
  await rro01Row.locator("button", { hasText: "Send" }).click();

  const candidate = await waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01.json`)).body;
    return c && c.status !== "running" ? c : null;
  }, { label: "targeted refine candidate ready" });
  check("targeted refine reached the backend with the right focus", candidate.focus === "Caption A", candidate.focus);
  check("targeted refine candidate is ready", candidate.status === "ready", candidate);
  await waitFor(async () => (await page.locator("text=Proposed replacement").count()) > 0 || null, { label: "candidate preview shows up in the UI" });
  check("candidate preview names the focus", (await page.locator(".st-candidate-box").first().textContent()).includes("Caption A"));

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
