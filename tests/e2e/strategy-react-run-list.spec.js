// The first e2e test for the new React Strategy OS app at /strategy/ — faithfully checks
// the run list screen (Active/Archived tabs, table, New Run modal, archive/restore/purge)
// against the same fixtures the legacy tests use, so this is a genuine like-for-like
// comparison of the port's fidelity, not a fresh design being tested in isolation.
//
// Requires `npx vite build --mode test` to have been run in apps/strategy/ first (see
// tests/run-all.js) — that swaps in firebase.fake.ts (a polling fake backed by
// fake-rtdb-server.js) instead of the real Firebase SDK, so this never touches Loona's
// actual production project. Sign-in is simulated by writing the same localStorage key
// firebase.fake.ts reads (see loginAsFakeUser below) rather than a real Firebase Auth flow.
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

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, {
    rro: { id: "rro", name: "RRO Foods" },
  });
  await req("PUT", `${RTDB_URL}/strategy_runs/react-list-test-run.json`, {
    runId: "react-list-test-run", brandId: "rro", month: "2026-10", status: "failed",
    owner: "Gokul", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T01:00:00.000Z",
    stages: { research: { status: "failed" } },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  // The backend endpoints (strategy-run-start, strategy-run-archive) still only verify
  // the legacy loona_auth cookie today — see api.ts's own comment on why sending the ID
  // token from day one doesn't make this cookie optional yet. Frontend auth is faked
  // separately, via loginAsFakeUser() below.
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Signed-out state first — before writing the fake user.
  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=You're not signed into Hub").count()) > 0 || null, { label: "signed-out state renders" });
  check("shows the signed-out state when no session exists", true);

  await loginAsFakeUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });

  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "run list renders with seeded data" });
  check("Active tab shows the seeded run by default", await page.locator("table", { hasText: "RRO Foods" }).count() > 0);
  check("the row offers Archive", await page.locator("button", { hasText: /^Archive$/ }).count() > 0);

  await page.locator("button", { hasText: /^Archived/ }).click();
  await waitFor(async () => (await page.locator("text=No archived runs").count()) > 0 || null, { label: "archived tab renders empty" });
  check("Archived tab starts empty", true);

  await page.locator("button", { hasText: /^Active/ }).click();
  await waitFor(async () => (await page.locator("button", { hasText: /^Archive$/ }).count()) > 0 || null, { label: "back on active tab" });

  let dialogLog = [];
  page.on("dialog", async (dialog) => {
    dialogLog.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "confirm") await dialog.accept();
    else if (dialog.type() === "prompt") await dialog.accept("React port test archive.");
    else await dialog.dismiss();
  });
  await page.locator("button", { hasText: /^Archive$/ }).click();
  // The endpoint writes archivedAt/archivedBy/archiveReason as three separate sequential
  // fbSet calls — wait for all three, not just the first, or the assertions below can
  // race a write still in flight.
  const archived = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/react-list-test-run.json`)).body;
    return r && r.archivedAt && r.archivedBy && r.archiveReason ? r : null;
  }, { label: "run gets archivedAt/archivedBy/archiveReason via the new endpoint" });
  check("archive confirm dialog fired", dialogLog.some((d) => d.type === "confirm"), dialogLog);
  check("archivedBy recorded as the actor", archived.archivedBy === "Gokul", archived.archivedBy);
  check("archiving didn't touch the run's own status", archived.status === "failed");

  await waitFor(async () => (await page.locator("table", { hasText: "RRO Foods" }).count()) === 0 || null, { label: "run leaves active list" });
  await page.locator("button", { hasText: /^Archived/ }).click();
  await waitFor(async () => (await page.locator("table", { hasText: "RRO Foods" }).count()) > 0 || null, { label: "run appears in archived list" });
  check("run now listed under Archived", true);
  check("archived row offers Restore", await page.locator("button", { hasText: "Restore" }).count() > 0);
  check("archived row offers Purge permanently", await page.locator("text=Purge permanently").count() > 0);

  // New Run wizard — brand picker populated from the seeded brand.
  await page.locator("button", { hasText: /^Active/ }).click();
  await page.waitForTimeout(200);
  await page.locator("button", { hasText: "+ New strategy run" }).click();
  await waitFor(async () => (await page.locator("text=Are you ready to build the strategy in Loona way?").count()) > 0 || null, { label: "New Run wizard's intake screen renders" });
  check("New Run wizard's brand picker includes the seeded brand", await page.locator("select option", { hasText: "RRO Foods" }).count() > 0);
  await page.locator("button", { hasText: "Cancel" }).click();
  await waitFor(async () => (await page.locator("button", { hasText: "+ New strategy run" }).count()) > 0 || null, { label: "Cancel returns to the run list" });

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
