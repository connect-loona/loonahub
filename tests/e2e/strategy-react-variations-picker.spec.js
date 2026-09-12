// e2e for the "variations" picker (ConceptChatPanel.tsx's VariationsPicker) — up to four
// fresh takes at once, two per configured model provider, replacing what "Get 3 variations"
// used to (mis)label a single "similar" candidate as. Covers: the button actually sends
// action: "variations" (not "similar"), the picker renders one card per ready variation
// tagged with its provider, accepting a specific card commits THAT one (not another), and
// discarding clears the whole set.
//
// The real four-way model fan-out isn't driven through the UI here (that's
// tests/strategy/asset-variations.test.js's job, against fake providers) — the ready
// candidate doc is seeded directly into Firebase, exactly as the real background function
// would leave it, and this checks what the screen does with it.
//
// Requires `npx vite build --mode test` to have been run in apps/strategy/ first.
const path = require("path");
const { chromium } = require("playwright");
const { HUB, RTDB_URL, DEV_LITE_URL, chromiumLaunchOptions, authCookie, req, waitFor } = require("../harness/shared");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

(async () => {
  const runId = "variations-picker-test-run";
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const copyFixture = require(path.join(fixtureDir, "copy.json"));
  const baseAsset = copyFixture.assets.find((a) => a.assetId === "RRO-01");

  function variantCaptions(label) {
    return baseAsset.captions.map((c, i) => Object.assign({}, c, { copy: `${label} caption ${i}` }));
  }

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul", status: "copy_needs_review",
    runtime: "fixture", fixtureDir,
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
    stages: {
      research: { status: "approved", checkpoint: { arguments: [] } },
      strategy: { status: "approved", checkpoint: require(path.join(fixtureDir, "strategy.json")) },
      copy: { status: "needs_review", checkpoint: copyFixture, locks: {} },
    },
    approvals: {},
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1400, height: 1400 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let lastProposeBody = null;
  await page.route("**/.netlify/functions/strategy-concept-propose", async (route) => {
    lastProposeBody = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "running" }) });
  });

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("__fakeAuthUser", JSON.stringify({ uid: "u", email: "gokul@loona.in", displayName: "Gokul" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "run list renders" });
  await page.locator(".st-run-card", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator("text=Captions").count()) > 0 || null, { label: "copy review renders" });

  const row = page.locator(".st-concept-row", { hasText: "RRO-01" }).first();

  // ---- 1. The button sends the real "variations" action, not "similar" ----
  await row.locator("button", { hasText: "Get variations" }).click();
  await waitFor(() => lastProposeBody || null, { label: "propose request captured" });
  check("clicking Get variations sends action: \"variations\"", lastProposeBody.action === "variations", lastProposeBody);
  check("it's scoped to the captions section", lastProposeBody.section === "captions", lastProposeBody);

  // ---- 2. Simulate the background job finishing: seed a ready variations candidate ----
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01::captions.json`, {
    status: "ready", requestType: "variations", focus: "Captions", section: "captions",
    history: [
      { role: "user", notes: null, focus: "Captions", requestType: "variations", at: "2026-09-12T00:01:00.000Z" },
      { role: "assistant", summary: "4 variations ready (2 ChatGPT, 2 Claude).", at: "2026-09-12T00:01:05.000Z" },
    ],
    variations: [
      { provider: "openai", candidate: Object.assign({}, baseAsset, { captions: variantCaptions("ChatGPT A") }) },
      { provider: "openai", candidate: Object.assign({}, baseAsset, { captions: variantCaptions("ChatGPT B") }) },
      { provider: "claude", candidate: Object.assign({}, baseAsset, { captions: variantCaptions("Claude A") }) },
      { provider: "claude", candidate: Object.assign({}, baseAsset, { captions: variantCaptions("Claude B") }) },
    ],
    updatedAt: "2026-09-12T00:01:05.000Z",
  });

  await waitFor(async () => (await row.locator("text=4 variations ready").count()) > 0 || null, { label: "picker renders" });
  const pickerText = await row.textContent();
  check("all four variations are shown", (pickerText.match(/Use this one/g) || []).length === 4, pickerText.length);
  check("each provider is labeled", /CHATGPT/.test(pickerText.toUpperCase()) && /CLAUDE/.test(pickerText.toUpperCase()), pickerText.slice(0, 200));

  // ---- 3. Accepting the THIRD card (Claude A) commits that one, not another ----
  const useButtons = row.locator("button", { hasText: "Use this one" });
  await useButtons.nth(2).click();
  const committed = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    const asset = r && r.stages.copy.checkpoint.assets.find((a) => a.assetId === "RRO-01");
    return asset && asset.captions[0].copy.startsWith("Claude A") ? asset : null;
  }, { label: "the chosen variation is committed" });
  check("the specific card clicked (Claude A) is what got committed", committed.captions[0].copy === "Claude A caption 0", committed.captions[0].copy);
  const candidateAfterAccept = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01::captions.json`)).body;
  check("the candidate is cleared after accepting", candidateAfterAccept === null, candidateAfterAccept);

  // ---- 4. Discard all clears the set without committing anything ----
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01::captions.json`, {
    status: "ready", requestType: "variations", section: "captions", history: [],
    variations: [{ provider: "openai", candidate: Object.assign({}, baseAsset, { captions: variantCaptions("Should be discarded") }) }],
    updatedAt: "2026-09-12T00:02:00.000Z",
  });
  await waitFor(async () => (await row.locator("button", { hasText: "Discard all" }).count()) > 0 || null, { label: "second picker renders" });
  await row.locator("button", { hasText: "Discard all" }).click();
  await waitFor(async () => {
    const doc = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/copy/candidates/RRO-01::captions.json`)).body;
    return doc === null ? true : null;
  }, { label: "discard clears the candidate" });
  const finalCheckpoint = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
  check("discarding did not commit the discarded variation", finalCheckpoint.stages.copy.checkpoint.assets.find((a) => a.assetId === "RRO-01").captions[0].copy !== "Should be discarded caption 0");

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
