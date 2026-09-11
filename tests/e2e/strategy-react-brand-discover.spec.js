// e2e for the "Found in Drive" section of Manage brands (BrandList.tsx).
//
// Brand folders exist in Drive before they're ever brands in Hub — someone makes the folder
// and drops the guidelines in. This proves the screen surfaces the folders that have no
// brand yet, hides the ones that do, and hands a finished draft to the brand form for a human
// to review rather than saving anything on its own.
//
// Drive itself is never reached: strategy-brand-discover has no credentials in this harness,
// so the request is intercepted and answered with a fixed folder list. What's under test is
// the screen's behaviour, not Google's.
//
// Requires `npx vite build --mode test` to have been run in apps/strategy/ first.
const { chromium } = require("playwright");
const { RTDB_URL, DEV_LITE_URL, chromiumLaunchOptions, authCookie, req, waitFor } = require("../harness/shared");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

const FOLDERS = [
  { name: "RRO", id: "folder-rro", folderUrl: "https://drive.google.com/drive/folders/folder-rro", brandId: "rro", configured: true },
  { name: "Casa Waters", id: "folder-casa", folderUrl: "https://drive.google.com/drive/folders/folder-casa", brandId: "casa-waters", configured: false },
  { name: "Ostilos", id: "folder-ostilos", folderUrl: "https://drive.google.com/drive/folders/folder-ostilos", brandId: "ostilos", configured: false },
];

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods", category: "Cooking oil" } });
  await req("PUT", `${RTDB_URL}/strategy_brand_drafts.json`, null);

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Stand in for Drive. The draft trigger is answered too, so no background function runs —
  // the draft's arrival is simulated by writing to Firebase, which is how it really lands.
  await page.route("**/.netlify/functions/strategy-brand-discover", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ folders: FOLDERS }) }));
  await page.route("**/.netlify/functions/strategy-brand-draft", (route) =>
    route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) }));

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("__fakeAuthUser", JSON.stringify({ uid: "u", email: "gokul@loona.in", displayName: "Gokul" })));
  await page.reload({ waitUntil: "domcontentloaded" });

  await waitFor(async () => (await page.locator("button", { hasText: "Manage brands" }).count()) > 0 || null, { label: "run list renders" });
  await page.locator("button", { hasText: "Manage brands" }).click();
  await waitFor(async () => (await page.locator("text=Found in Drive").count()) > 0 || null, { label: "Found in Drive section renders" });

  // ---- Only folders WITHOUT a brand appear ----
  const section = page.locator(".st-board", { hasText: "Found in Drive" });
  const sectionText = await section.textContent();
  check("an unconfigured folder is listed", sectionText.includes("Casa Waters") && sectionText.includes("Ostilos"), sectionText.slice(0, 160));
  check("a folder that already has a brand is not listed as missing", !sectionText.includes("RRO"), sectionText.slice(0, 160));
  check("the count reflects only the unconfigured ones", sectionText.includes("2"), sectionText.slice(0, 80));

  // ---- Drafting shows progress ----
  await section.locator("button", { hasText: "Draft from Drive" }).first().click();
  await waitFor(async () => (await section.locator("button", { hasText: "Reading Drive…" }).count()) > 0 || null, { label: "drafting state renders" });
  check("the button shows it's working and can't be clicked twice", await section.locator("button", { hasText: "Reading Drive…" }).first().isDisabled());

  // ---- A finished draft turns into a review step, not a saved brand ----
  await req("PUT", `${RTDB_URL}/strategy_brand_drafts/casa-waters.json`, {
    brandId: "casa-waters", name: "Casa Waters", folderId: "folder-casa", status: "ready",
    readFrom: { fileCount: 9, textFileCount: 6, unreadFiles: [{ name: "big.pdf", reason: "Too large to read (80MB)." }] },
    draft: {
      category: "Premium bottled water",
      market: ["Kerala"],
      aspirationalMarkets: [],
      website: null,
      oneLineTruth: "Water chosen the way wine is chosen.",
      voice: { descriptors: ["calm", "assured", "spare"], principles: ["Never oversell"], bannedWords: ["pure"], bannedMoves: [] },
      audiences: [{ description: "Hosts", tension: "What's on the table says who you are" }],
      pillars: [{ id: "table", name: "The table", intent: "Show it in use" }],
      products: [],
      sources: [{ field: "voice", basis: "Brand guidelines" }],
      gaps: ["No pricing anywhere in the folder"],
    },
  });
  await waitFor(async () => (await section.locator("button", { hasText: "Review & save" }).count()) > 0 || null, { label: "draft ready" });
  const readyText = await section.textContent();
  check("it reports how much of the folder it actually read", readyText.includes("6 of 9 files"), readyText.slice(0, 300));
  check("it flags what the folder couldn't answer", /didn't answer/.test(readyText), readyText.slice(0, 300));
  check("it says which files were too large", /too large to read/i.test(readyText), readyText.slice(0, 300));
  // The in-progress note must clear once the draft lands, or it reads as still running.
  check("the 'reading Drive' progress note is gone once the draft is ready", !/first read of a folder is the slow one/.test(readyText), readyText.slice(0, 300));

  // Nothing may be saved automatically — the brand list must be unchanged at this point.
  const brandsNow = (await req("GET", `${RTDB_URL}/strategy_brands.json`)).body || {};
  check("a ready draft has NOT created a brand on its own", !brandsNow["casa-waters"], Object.keys(brandsNow));

  // ---- Review & save opens the form, prefilled from the draft ----
  await section.locator("button", { hasText: "Review & save" }).click();
  await waitFor(async () => (await page.locator('input[aria-label="Name"], input[value="Casa Waters"]').count()) > 0 || null, { label: "brand form opens" });
  const formHtml = await page.locator(".st-board").first().innerHTML();
  check("the form is prefilled with the drafted truth", formHtml.includes("Water chosen the way wine is chosen"), formHtml.slice(0, 200));
  check("and with the brand's Drive folder link", formHtml.includes("folder-casa"), formHtml.slice(0, 200));

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
