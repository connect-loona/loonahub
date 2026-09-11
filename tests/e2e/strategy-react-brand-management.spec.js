// e2e test for the new React "Manage brands" screens (BrandList/BrandForm) — the last
// stubbed piece of the run list from Step 4a. Mirrors the legacy strategy-brand-ui.spec.js
// scenarios (empty state, validation, save, edit-existing with Advanced JSON round-trip)
// against the React port instead.
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
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, null);

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 1400 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=Strategy OS").count()) > 0 || null, { label: "run list renders" });

  // ---- Empty state ----
  await page.locator("button", { hasText: "Manage brands" }).click();
  // Wait for the empty-state note itself, not just "+ Add brand" (which BrandList renders
  // unconditionally in its header, before useBrands()'s live listener has delivered its
  // first snapshot — its board shows "Loading…" until then). Waiting on the button alone
  // confirms navigation but not that the brands listener has actually resolved, racing
  // the very next check against a still-"Loading…" board.
  await waitFor(async () => (await page.locator("text=No brands configured yet").count()) > 0 || null, { label: "empty brand list renders" });
  check("empty brand list shows the empty-state note", true);

  await page.locator("button", { hasText: "+ Add brand" }).click();
  // Same ambiguous-text hazard as above — the button we just clicked already contains
  // "Add brand" as a substring, so wait for something only the form itself has.
  await waitFor(async () => (await page.locator("button", { hasText: "Save brand" }).count()) > 0 || null, { label: "add brand form renders" });
  check("clicking + Add brand opens the form", await page.locator("input[disabled]").count() === 0, "id field should be editable for a new brand");

  // ---- Submit with too-few required items -> specific validation error ----
  // The form has no name/id attrs on its inputs (unlike the legacy DOM's #so-bf-* ids) —
  // target by order within each labeled board instead.
  const idInput = page.locator(".st-board").filter({ hasText: "Basics" }).locator("input").nth(0);
  const nameInput = page.locator(".st-board").filter({ hasText: "Basics" }).locator("input").nth(1);
  const categoryInput = page.locator(".st-board").filter({ hasText: "Basics" }).locator("input").nth(2);
  const marketInput = page.locator(".st-board").filter({ hasText: "Basics" }).locator("input").nth(3);
  const truthArea = page.locator(".st-board").filter({ hasText: "Basics" }).locator("textarea").nth(0);
  await idInput.fill("acme");
  await nameInput.fill("Acme Co");
  await categoryInput.fill("Test category");
  await marketInput.fill("Mumbai");
  await truthArea.fill("Acme makes things people need.");

  const voiceBoard = page.locator(".st-board").filter({ hasText: "Voice" });
  await voiceBoard.locator("input").nth(0).fill("bold, clean"); // only 2 descriptors — needs 3
  await voiceBoard.locator("textarea").nth(0).fill("Make things simple.");
  await voiceBoard.locator("input").nth(2).fill("No emojis.");
  await voiceBoard.locator("input").nth(3).fill("English only.");

  const audienceBoard = page.locator(".st-board").filter({ hasText: "Audiences" });
  await audienceBoard.locator("input").nth(0).fill("primary");
  await audienceBoard.locator("textarea").nth(0).fill("desc");
  await audienceBoard.locator("textarea").nth(1).fill("situation");
  await audienceBoard.locator("textarea").nth(2).fill("trigger");

  const visualBoard = page.locator(".st-board").filter({ hasText: "Visual" });
  await visualBoard.locator("input").nth(0).fill("clean, bold, modern");
  await visualBoard.locator("textarea").nth(0).fill("Keep it simple.");
  await visualBoard.locator("textarea").nth(1).fill("Clutter.");

  const pillarBoard = page.locator(".st-board").filter({ hasText: "Content pillars" });
  await pillarBoard.locator("input").nth(0).fill("launches");
  await pillarBoard.locator("input").nth(1).fill("Launches");
  await pillarBoard.locator("textarea").nth(0).fill("New product launches.");

  await page.locator("button", { hasText: "Save brand" }).click();
  await waitFor(async () => (await page.locator(".st-error-text").count()) > 0 || null, { label: "validation error appears" });
  const errText = await page.locator(".st-error-text").textContent();
  check("saving with only 2 voice descriptors (needs 3) shows a specific error", errText.includes("descriptors"), errText);
  check("the form is NOT navigated away on validation failure", await page.locator("text=Add brand").count() > 0);

  // ---- Fix it and save successfully ----
  await voiceBoard.locator("input").nth(0).fill("bold, clean, modern");
  await page.locator("button", { hasText: "Save brand" }).click();
  await waitFor(async () => (await page.locator("text=Manage brands").count()) > 0 || null, { label: "navigates to brand list on success" });
  await waitFor(async () => (await page.locator("text=Acme Co").count()) > 0 || null, { label: "new brand appears in the list" });
  check("a valid new brand saves and returns to the brand list", true);
  const savedDoc = (await req("GET", `${RTDB_URL}/strategy_brands/acme.json`)).body;
  check("the brand was actually written to Firebase", savedDoc && savedDoc.name === "Acme Co", savedDoc);

  // ---- Edit an existing, richly-configured brand (RRO) and confirm the Advanced JSON
  // round-trips its portfolios/claim rules untouched ----
  // Seeded the same way the legacy strategy-brand-ui.spec.js does: starting a real run
  // against RRO's own fixture auto-populates strategy_brands/rro as a side effect, with a
  // fully schema-valid config (hand-rolling a minimal {id:...}-only portfolios/claimRules
  // stub here would fail strategy-brand-save.js's own validation the moment anything gets
  // re-saved, since PortfolioSchema/ClaimRuleSchema require several more fields than that).
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const rroRunStartStatus = await page.evaluate(async (fixtureDir) => {
    const res = await fetch("/.netlify/functions/strategy-run-start", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test:gokul%40loona.in:Gokul:gokul-fake-uid" },
      body: JSON.stringify({ brandId: "rro", month: "2026-11", actor: "Gokul", runtime: "fixture", fixtureDir }),
    });
    return res.status;
  }, fixtureDir);
  check("starting an RRO run (which seeds strategy_brands/rro as a side effect) succeeds", rroRunStartStatus === 200, rroRunStartStatus);

  // Saving Acme above already returned us to the brand list (BrandForm's onSaved) — no
  // navigation needed, just wait for RRO's own listener update to land on the page
  // that's already showing.
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "RRO appears in the brand list once seeded" });
  await page.locator(".pf-absrow", { hasText: "RRO" }).locator("button", { hasText: "Edit" }).click();
  await waitFor(async () => (await page.locator(".st-board").filter({ hasText: "Basics" }).locator("input").nth(1).inputValue()) === "RRO Foods" || null, { label: "edit form populates RRO's existing name" });
  check("editing RRO loads its existing name into the form", true);
  check("the brand id field is locked when editing an existing brand", await page.locator(".st-board").filter({ hasText: "Basics" }).locator("input").nth(0).isDisabled());

  const advancedTextarea = page.locator("details textarea");
  const advancedJson = await advancedTextarea.inputValue();
  const parsedAdvanced = JSON.parse(advancedJson);
  check("the Advanced JSON carries RRO's real portfolios through untouched", Array.isArray(parsedAdvanced.portfolios) && parsedAdvanced.portfolios.length === 3, parsedAdvanced.portfolios);
  check("the Advanced JSON carries RRO's real claim rules through untouched", Array.isArray(parsedAdvanced.claimRules) && parsedAdvanced.claimRules.length === 5);

  await categoryInput.fill("Updated category for this test");
  await page.locator("button", { hasText: "Save brand" }).click();
  await waitFor(async () => (await page.locator("text=Manage brands").count()) > 0 || null, { label: "saves the edit" });
  const afterEdit = (await req("GET", `${RTDB_URL}/strategy_brands/rro.json`)).body;
  check("the edited category persisted to Firebase", afterEdit.category === "Updated category for this test", afterEdit.category);
  check("editing one field did not corrupt the untouched portfolios", Array.isArray(afterEdit.portfolios) && afterEdit.portfolios.length === 3);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
