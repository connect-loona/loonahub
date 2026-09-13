// e2e test for the new-run intake wizard at /strategy/ (NewRunWizard.tsx) — the
// brand/type/month intake screen, then either the Monthly deliverables+priorities screen
// or the Campaign details+deliverables screen, submitting through strategy-run-start.js
// same as before but now carrying runType/deliverablesOverride/sourceContext.
//
// Both paths here submit for real (there's no fixture-runtime escape hatch exposed
// through the UI, matching production) — with no OPENAI_API_KEY in this harness, the
// background research call fails fast and the run doc lands on
// stages.research.status === "failed" almost immediately. That's fine: this test is
// checking the wizard's own mechanics (screen transitions, defaults, editability, and what
// gets sent to strategy-run-start.js), not a real research run — see pipeline.test.js and
// run-type-and-deliverables-override.test.js for that, seeded directly against the
// fixture runtime.
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

async function runFor(month) {
  const all = (await req("GET", `${RTDB_URL}/strategy_runs.json`)).body || {};
  return Object.values(all).find((r) => r && r.brandId === "rro" && r.month === month) || null;
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, {
    rro: { id: "rro", name: "RRO Foods", deliverables: { reel: 6, carousel: 4, static: 3, confirmed: true } },
  });
  // Hub's own brand roster (useAllHubBrands) is the source of truth for which brands show
  // up at all — RRO here is both a Hub brand AND has a strategy_brands entry (configured);
  // "Casa Waters" is a real Hub brand with no strategy_brands entry yet, standing in for
  // the common case: most brands exist in Hub long before anyone drafts their Strategy OS
  // setup from Drive.
  await req("PUT", `${RTDB_URL}/brands.json`, {
    b1: { brand: "RRO Foods" },
    b2: { brand: "Casa Waters" },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("button", { hasText: "+ New strategy run" }).count()) > 0 || null, { label: "run list renders" });

  // ---- Monthly path ----
  await page.locator("button", { hasText: "+ New strategy run" }).click();
  await waitFor(async () => (await page.locator("text=Are you ready to build the strategy in Loona way?").count()) > 0 || null, { label: "intake screen renders" });
  check("Type defaults to Monthly strategy", await page.locator('select[aria-label="Type"]').inputValue() === "monthly");

  // ---- Every Hub brand shows up, configured or not — but only a configured one can
  // actually start a run. Casa Waters exists in Hub with no strategy_brands entry yet. ----
  const brandOptions = await page.locator('select[aria-label="Brand"] option').allTextContents();
  check("every Hub brand is listed, not just configured ones", brandOptions.some((t) => t.includes("RRO Foods")) && brandOptions.some((t) => t.includes("Casa Waters")));
  check("the unconfigured brand is labeled as not set up yet", brandOptions.some((t) => t === "Casa Waters (not set up yet)"), brandOptions);
  check("the default selection is the configured brand, not just the first alphabetically", await page.locator('select[aria-label="Brand"]').inputValue() === "rro");

  await page.locator('select[aria-label="Brand"]').selectOption({ label: "Casa Waters (not set up yet)" });
  await page.locator("button", { hasText: "Continue" }).click();
  await waitFor(async () => (await page.locator(".st-error-text").count()) > 0 || null, { label: "blocked-brand error shows" });
  check("picking an unconfigured brand is blocked with a clear reason", (await page.locator(".st-error-text").textContent() || "").includes("hasn't been fully set up in Strategy OS yet"));
  check("a way to actually fix it is offered right there", await page.locator("button", { hasText: "Set it up in Manage brands" }).count() > 0);
  check("it did not advance to the details screen", await page.locator("text=Are you ready to build the strategy in Loona way?").count() > 0);

  // Switch back to the real, configured brand and continue with the rest of the test as before.
  await page.locator('select[aria-label="Brand"]').selectOption({ label: "RRO Foods" });

  await page.locator('input[aria-label="Month"]').fill("2026-11");
  await page.locator("button", { hasText: "Continue" }).click();
  await waitFor(async () => (await page.locator("text=Agreed deliverables for the monthly plan").count()) > 0 || null, { label: "monthly details screen renders" });

  check("deliverables default from the brand's own config", (
    await page.locator('input[aria-label="Count — Reels"]').inputValue() === "6" &&
    await page.locator('input[aria-label="Count — Carousels"]').inputValue() === "4" &&
    await page.locator('input[aria-label="Count — Static"]').inputValue() === "3"
  ));

  await page.locator('input[aria-label="Count — Reels"]').fill("8");
  // Also exercise "+ Add deliverable" — Story is next in the preset list once
  // reel/carousel/static are already used.
  await page.locator("button", { hasText: "+ Add deliverable" }).click();
  await page.locator('input[aria-label="Count — Story"]').fill("2");
  await page.locator('textarea[aria-label="Notes"]').fill("Focus on the Diwali gifting angle this month.");

  // ---- Advanced: which model writes this run (collapsed by default) ----
  check("the model pickers are collapsed until Advanced is opened", await page.locator('select[aria-label="Default model"]').isVisible() === false);
  await page.locator("summary", { hasText: "Advanced" }).click();
  await waitFor(async () => (await page.locator('select[aria-label="Default model"]').isVisible()) || null, { label: "advanced block opens" });
  check("the default model starts on ChatGPT", await page.locator('select[aria-label="Default model"]').inputValue() === "openai");
  check("every stage starts on \"same as default\"", await page.locator('select[aria-label="Copy model"]').inputValue() === "");
  await page.locator('select[aria-label="Default model"]').selectOption("claude");
  await page.locator('select[aria-label="Copy model"]').selectOption("openai");

  await page.locator("button", { hasText: "Submit & start research" }).click();

  // Submitting navigates into the run detail view — wait for the stage rail (renders
  // regardless of whether research itself later succeeds or fails without an API key).
  await waitFor(async () => (await page.locator(".st-stage-rail").count()) > 0 || null, { label: "navigates into run detail after monthly submit" });
  check("navigated into run detail", true);

  const monthlyRun = await waitFor(() => runFor("2026-11"), { label: "monthly run doc exists" });
  check("monthly run tagged runType: monthly", monthlyRun.runType === "monthly", monthlyRun.runType);
  check("monthly run's deliverablesOverride reflects the edited reel count (8), not the brand default (6)", monthlyRun.deliverablesOverride && monthlyRun.deliverablesOverride.reel === 8, monthlyRun.deliverablesOverride);
  check("monthly run's deliverablesOverride keeps the untouched carousel/static defaults", monthlyRun.deliverablesOverride.carousel === 4 && monthlyRun.deliverablesOverride.static === 3);
  check("monthly run's deliverablesOverride includes the added Story row", monthlyRun.deliverablesOverride.story === 2, monthlyRun.deliverablesOverride);
  check("monthly run's sourceContext carries the priorities text (reaches Research's prompt — see pipeline.js)", (monthlyRun.sourceContext || []).some((s) => s.includes("Diwali gifting")), monthlyRun.sourceContext);
  check("the Advanced block's default-model pick is stored on the run", monthlyRun.runtime === "claude", monthlyRun.runtime);
  check("the per-stage override is stored for the stage it was set on", monthlyRun.runtimes && monthlyRun.runtimes.copy === "openai", monthlyRun.runtimes);
  check("stages left on \"same as default\" aren't stored as overrides", monthlyRun.runtimes && !monthlyRun.runtimes.research, monthlyRun.runtimes);

  // ---- Campaign path ----
  await page.locator("button", { hasText: "All runs" }).click();
  await waitFor(async () => (await page.locator("button", { hasText: "+ New strategy run" }).count()) > 0 || null, { label: "back on run list" });

  await page.locator("button", { hasText: "+ New strategy run" }).click();
  await waitFor(async () => (await page.locator("text=Are you ready to build the strategy in Loona way?").count()) > 0 || null, { label: "intake screen renders again" });
  await page.locator('select[aria-label="Type"]').selectOption("campaign");
  await page.locator('input[aria-label="Month"]').fill("2026-12");
  await page.locator("button", { hasText: "Continue" }).click();
  await waitFor(async () => (await page.locator("text=Campaign details").count()) > 0 || null, { label: "campaign details screen renders" });

  check("campaign screen still offers the deliverables picker", await page.locator('input[aria-label="Count — Reels"]').count() > 0);

  // ---- Campaign details are required — a real person hit exactly this by forgetting to
  // fill it in and submitting with only deliverables set. ----
  await page.locator("button", { hasText: "Submit & start research" }).click();
  await waitFor(async () => (await page.locator(".st-error-text").count()) > 0 || null, { label: "error shows for empty campaign details" });
  check("submitting a campaign with no details set is rejected client-side", (await page.locator(".st-error-text").textContent() || "").includes("Explain what this campaign is for"));
  check("it did NOT navigate away — still on the campaign details screen", await page.locator("text=Campaign details").count() > 0);
  check("no run was created for this rejected submit", (await runFor("2026-12")) === null);

  await page.locator('textarea[aria-label="Notes"]').fill("Diwali gifting push across RRO's oil range.");
  await page.locator('input[aria-label="Count — Carousels"]').fill("2");
  await page.locator("button", { hasText: "Submit & start research" }).click();

  await waitFor(async () => (await page.locator(".st-stage-rail").count()) > 0 || null, { label: "navigates into run detail after campaign submit" });
  check("navigated into run detail for the campaign run", true);

  const campaignRun = await waitFor(() => runFor("2026-12"), { label: "campaign run doc exists" });
  check("campaign run tagged runType: campaign", campaignRun.runType === "campaign", campaignRun.runType);
  check("campaign run goes through the same pipeline (still has the standard 5 stages)", Object.keys(campaignRun.stages || {}).length === 5, campaignRun.stages);
  check("campaign run's deliverablesOverride reflects the edited carousel count (2)", campaignRun.deliverablesOverride && campaignRun.deliverablesOverride.carousel === 2, campaignRun.deliverablesOverride);
  check("campaign run's sourceContext carries the campaign details text", (campaignRun.sourceContext || []).some((s) => s.includes("Diwali gifting push")), campaignRun.sourceContext);
  // Advanced was never opened on this path — leaving it alone has to behave exactly as the
  // wizard did before the model pickers existed.
  check("leaving Advanced untouched stores no per-stage overrides", campaignRun.runtimes === null || campaignRun.runtimes === undefined, campaignRun.runtimes);
  check("leaving Advanced untouched keeps the ChatGPT default", campaignRun.runtime === "openai", campaignRun.runtime);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
