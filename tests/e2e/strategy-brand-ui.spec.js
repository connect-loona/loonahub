// End-to-end test of the "Manage brands" screen: empty state, adding a brand through the
// real form (with validation errors surfacing for too-short required fields), editing an
// existing brand, the Advanced JSON round-tripping portfolios/claim rules/Canva config, and
// the New Run modal picking up brands dynamically instead of a hardcoded list.
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
function waitForCond(fn, label, timeoutMs = 3000) {
  return waitFor(fn, { label, timeoutMs });
}

(async () => {
  // Reset — empty brands, no runs.
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 1400 } });
  // Since the fail-closed auth fix, strategy-run-start/stage-approve/brand-save all require
  // a real loona_auth cookie matching netlify-dev-lite.js's BASIC_AUTH_CREDENTIALS — inject
  // it directly rather than going through the real login page (which this stand-in server
  // doesn't implement).
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

  // ---- Empty state: New Run modal offers no brand picker, points to "add one" ----
  await page.locator("button", { hasText: "+ New monthly strategy" }).click();
  await page.waitForTimeout(200);
  const emptyModalText = await page.locator("#so-new-run-modal").textContent();
  check("New Run modal shows \"no brands\" state when none exist", emptyModalText.includes("No brands configured"));
  check("the \"add one\" link is offered instead of a brand picker", await page.locator("#so-new-run-modal select#so-new-brand").count() === 0);
  await page.locator("#so-new-run-modal a", { hasText: "add one" }).click();
  await page.waitForTimeout(300);

  // ---- Landed on the Add Brand form ----
  check("clicking \"add one\" opens the Add Brand form", (await page.locator("#page-strategy .section-title").textContent()) === "Add brand");

  // ---- Submit with too-few required items -> specific validation errors surface ----
  await page.fill("#so-bf-id", "acme");
  await page.fill("#so-bf-name", "Acme Co");
  await page.fill("#so-bf-category", "Test category");
  await page.fill("#so-bf-market", "Mumbai");
  await page.fill("#so-bf-truth", "Acme makes things people need.");
  await page.fill("#so-bf-descriptors", "bold, clean"); // only 2 — needs 3
  await page.fill("#so-bf-principles", "Make things simple.");
  await page.fill("#so-bf-emojirule", "No emojis.");
  await page.fill("#so-bf-languagerule", "English only.");
  await page.locator("#so-audience-rows .so-row [data-field=\"id\"]").fill("primary");
  await page.locator("#so-audience-rows .so-row [data-field=\"description\"]").fill("desc");
  await page.locator("#so-audience-rows .so-row [data-field=\"buyingSituation\"]").fill("situation");
  await page.locator("#so-audience-rows .so-row [data-field=\"trigger\"]").fill("trigger");
  await page.fill("#so-bf-feel", "clean, bold, modern");
  await page.fill("#so-bf-visprinciples", "Keep it simple.");
  await page.fill("#so-bf-visavoid", "Clutter.");
  await page.locator("#so-pillar-rows .so-row [data-field=\"id\"]").fill("launches");
  await page.locator("#so-pillar-rows .so-row [data-field=\"name\"]").fill("Launches");
  await page.locator("#so-pillar-rows .so-row [data-field=\"description\"]").fill("New product launches.");
  await page.locator("button", { hasText: "Save brand" }).click();
  await waitForCond(async () => ((await page.locator("#so-bf-error").textContent()).length > 0) || null, "validation error text appears");
  const errText = await page.locator("#so-bf-error").textContent();
  check("saving with only 2 voice descriptors (needs 3) shows a specific error", errText.includes("descriptors"), errText);
  check("the form is NOT navigated away on validation failure (still on the form)", (await page.locator("#page-strategy .section-title").textContent()) === "Add brand");

  // ---- Fix it and save successfully ----
  await page.fill("#so-bf-descriptors", "bold, clean, modern");
  await page.locator("button", { hasText: "Save brand" }).click();
  await waitForCond(async () => ((await page.locator("#page-strategy .section-title").textContent()) === "Manage brands") || null, "navigates to brand list on success");
  check("a valid new brand saves and returns to the brand list", true);
  // The list re-renders once the Firebase listener's next poll catches up with the write
  // that just landed — give it a beat rather than asserting on the very first paint.
  await waitForCond(async () => ((await page.locator("#page-strategy").textContent()).includes("Acme Co")) || null, "the new brand appears in the list", 2000);
  const listText = await page.locator("#page-strategy").textContent();
  check("the new brand appears in the list", listText.includes("Acme Co") && listText.includes("acme"));

  // ---- New Run modal now offers the brand ----
  await page.locator("button", { hasText: "All runs" }).click();
  await page.waitForTimeout(300);
  await page.locator("button", { hasText: "+ New monthly strategy" }).click();
  await page.waitForTimeout(200);
  const brandOptions = await page.locator("#so-new-brand option").allTextContents();
  check("the New Run brand picker now includes the brand added through the form", brandOptions.includes("Acme Co"), brandOptions);
  await page.locator("#so-new-run-modal button", { hasText: "Cancel" }).click();

  // ---- Edit the existing RRO seed brand (once it's in Firebase) and confirm the Advanced
  // JSON round-trips its portfolios/claim rules/Canva config untouched ----
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const rroRunStartStatus = await page.evaluate(async (fixtureDir) => {
    const res = await fetch("/.netlify/functions/strategy-run-start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "fixture", fixtureDir }),
    });
    return res.status;
  }, fixtureDir);
  check("starting an RRO run (which seeds strategy_brands/rro as a side effect) succeeds", rroRunStartStatus === 200, rroRunStartStatus);
  await page.locator("button", { hasText: "Manage brands" }).click();
  await waitForCond(async () => ((await page.locator("#page-strategy").textContent()).includes("RRO")) || null, "RRO appears in the brand list once seeded");
  const brandListText = await page.locator("#page-strategy").textContent();
  check("RRO shows up in the brand list once seeded", brandListText.includes("RRO"));

  await page.locator(".pf-absrow", { hasText: "RRO" }).locator("button", { hasText: "Edit" }).click();
  await page.waitForTimeout(300);
  check("editing RRO loads its existing name into the form", await page.inputValue("#so-bf-name") === "RRO Foods");
  check("the brand id field is locked when editing an existing brand", await page.isDisabled("#so-bf-id"));
  const advancedJsonBefore = await page.inputValue("#so-bf-advanced");
  const parsedAdvanced = JSON.parse(advancedJsonBefore);
  check("the Advanced JSON carries RRO's real portfolios through untouched", Array.isArray(parsedAdvanced.portfolios) && parsedAdvanced.portfolios.length === 3, parsedAdvanced.portfolios && parsedAdvanced.portfolios.map((p) => p.id));
  check("the Advanced JSON carries RRO's real claim rules through untouched", Array.isArray(parsedAdvanced.claimRules) && parsedAdvanced.claimRules.length === 5);

  // Make a small real edit and confirm it persists.
  await page.fill("#so-bf-category", "Updated category for this test");
  await page.locator("button", { hasText: "Save brand" }).click();
  await waitForCond(async () => ((await page.locator("#page-strategy .section-title").textContent()) === "Manage brands") || null, "saves the edit");
  const rroDoc = (await req("GET", `${RTDB_URL}/strategy_brands/rro.json`)).body;
  check("the edited category persisted to Firebase", rroDoc.category === "Updated category for this test", rroDoc.category);
  check("editing one field did not corrupt the untouched portfolios", Array.isArray(rroDoc.portfolios) && rroDoc.portfolios.length === 3);
  check("editing one field did not corrupt the untouched Canva config", rroDoc.canva && rroDoc.canva.enabled === false && rroDoc.canva.fields.format === "FORMAT");

  check("no uncaught page errors across the whole flow", errors.length === 0, JSON.stringify(errors));

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
