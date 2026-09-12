// UI test for the run list's Active/Archived tabs and the Archive -> Restore -> Purge
// flow that replaced the old outright Delete button.
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
  const runId = "archive-ui-test-run";
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", runtime: "fixture", fixtureDir,
    status: "failed", owner: "Gokul", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: { research: { status: "failed" } }, approvals: {},
  });
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, {
    rro: { id: "rro", name: "RRO Foods", oneLineTruth: "test", audiences: [], portfolios: [], deliverables: {} },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 1400 } });
  await context.addCookies([authCookie()]);
  await blockRealFirebaseSdk(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let dialogLog = [];
  page.on("dialog", async (dialog) => {
    dialogLog.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "confirm") await dialog.accept();
    else if (dialog.type() === "prompt") await dialog.accept("Abandoned — duplicate test run.");
    else await dialog.dismiss();
  });

  await page.addInitScript(combinedInit, { fixed: FIXED_NOW, baseUrl: RTDB_URL });
  await page.goto(`${DEV_LITE_URL}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await loginAsGokul(page);
  await page.waitForTimeout(500);
  await page.locator(".nav-btn", { hasText: "Strategy legacy" }).click(); // Strategy OS itself is now a real link to /strategy/; this legacy embedded flow uses the rollback button
  await waitFor(async () => (await page.locator("#so-root table", { hasText: "RRO Foods" }).count()) > 0 || null,
    { label: "initial run list renders" });

  // ---- Active tab shows the run, Archived tab is empty ----
  check("Active tab shows the run by default", true);
  check("the row offers Archive (not the old Delete)", await page.locator("#so-root button", { hasText: /^Archive$/ }).count() > 0);
  check("the row does NOT offer a Delete button", await page.locator("#so-root button", { hasText: "Delete" }).count() === 0);

  await page.locator("#so-root button", { hasText: /^Archived/ }).click();
  await waitFor(async () => (await page.locator("#so-root", { hasText: "No archived runs" }).count()) > 0 || null,
    { label: "archived tab renders empty" });
  check("Archived tab starts empty", true);

  // ---- Archive it from the Active tab ----
  await page.locator("#so-root button", { hasText: /^Active/ }).click();
  await waitFor(async () => (await page.locator("#so-root button", { hasText: /^Archive$/ }).count()) > 0 || null,
    { label: "active tab renders with the run" });
  await page.locator("#so-root button", { hasText: /^Archive$/ }).click();
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.archivedAt ? r : null;
  }, { label: "run gets archivedAt in Firebase" });
  check("archive confirm dialog fired", dialogLog.some((d) => d.type === "confirm" && d.message.includes("Archive")), dialogLog);
  check("archive reason prompt fired", dialogLog.some((d) => d.type === "prompt"), dialogLog);
  const archived = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("archivedBy recorded", archived.archivedBy === "Gokul", archived.archivedBy);
  check("archiveReason recorded", archived.archiveReason === "Abandoned — duplicate test run.", archived.archiveReason);

  // ---- The run disappears from Active, appears in Archived ----
  await waitFor(async () => (await page.locator("#so-root table", { hasText: "RRO Foods" }).count()) === 0 || null,
    { label: "run leaves the active list" });
  check("run no longer listed under Active", true);
  await page.locator("#so-root button", { hasText: /^Archived/ }).click();
  await waitFor(async () => (await page.locator("#so-root table", { hasText: "RRO Foods" }).count()) > 0 || null,
    { label: "run appears under Archived" });
  check("run now listed under Archived", true);
  check("archived row offers Restore", await page.locator("#so-root button", { hasText: "Restore" }).count() > 0);
  check("archived row offers Purge permanently", await page.locator("#so-root", { hasText: "Purge permanently" }).count() > 0);

  // ---- Restore it — it should come back under Active ----
  dialogLog = [];
  await page.locator("#so-root button", { hasText: "Restore" }).click();
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && !r.archivedAt ? r : null;
  }, { label: "archivedAt cleared in Firebase" });
  check("restore confirm dialog fired", dialogLog.some((d) => d.type === "confirm" && d.message.includes("Restore")), dialogLog);
  const restored = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("archivedBy/archiveReason cleared on restore", restored.archivedBy == null && restored.archiveReason == null, restored);

  await waitFor(async () => (await page.locator("#so-root table", { hasText: "RRO Foods" }).count()) === 0 || null,
    { label: "run leaves the archived list once restored" });
  await page.locator("#so-root button", { hasText: /^Active/ }).click();
  await waitFor(async () => (await page.locator("#so-root table", { hasText: "RRO Foods" }).count()) > 0 || null,
    { label: "restored run reappears under Active" });
  check("restored run is back under Active", true);

  // ---- Archive again, then purge for real — a mismatched typed confirmation refuses ----
  await page.locator("#so-root button", { hasText: /^Archive$/ }).click();
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.archivedAt ? r : null;
  }, { label: "re-archived" });
  await page.locator("#so-root button", { hasText: /^Archived/ }).click();
  await waitFor(async () => (await page.locator("#so-root table", { hasText: "RRO Foods" }).count()) > 0 || null,
    { label: "re-archived run appears under Archived" });

  page.removeAllListeners("dialog");
  let purgePrompt = null;
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") { purgePrompt = dialog.message(); await dialog.accept("the wrong label entirely"); }
    else await dialog.dismiss();
  });
  await page.locator("#so-root a", { hasText: "Purge permanently" }).click();
  await page.waitForTimeout(400);
  check("purge asks for the run's exact label", !!purgePrompt, purgePrompt);
  const stillThereAfterMismatch = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("a mismatched typed confirmation does NOT delete the run", !!stillThereAfterMismatch);

  page.removeAllListeners("dialog");
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept(purgePrompt.split("\n\n").pop());
    else await dialog.dismiss();
  });
  await page.locator("#so-root a", { hasText: "Purge permanently" }).click();
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r === null ? true : null;
  }, { label: "run actually removed from Firebase" });
  check("a matching typed confirmation permanently deletes the run", true);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
