// e2e test for surfacing executeCompetitiveStage's own findings (pipeline.js) in the review
// screen: which model(s) actually wrote a stage, whether an independent critic reviewed it,
// per-asset scores/reasoning, and — the failure mode this whole feature exists to catch
// (validation.js:166) — a gate where the writer's own self-report and the critic's fresh
// judgement disagree.
//
// This data (`run.metrics.<stage>`) is written by the backend and never produced by driving
// the UI itself, so it's seeded directly into Firebase, same as every other run-detail e2e
// spec seeds its checkpoint data.
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

function gate(pass) { return { logoSwapPass: pass, killListPass: true, tensionPass: true, overheardPass: true }; }

(async () => {
  const runId = "critic-review-test-run";
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul", status: "strategy_needs_review",
    runtime: "fixture", fixtureDir,
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
    stages: {
      research: { status: "approved", checkpoint: { arguments: [] } },
      strategy: {
        status: "needs_review",
        checkpoint: {
          monthThesis: "Test thesis.",
          assets: [
            // Self-report says this cleared every gate — the critic disagrees on tension,
            // which is exactly the case validation.js:166 could never have caught before.
            { assetId: "RRO-01", format: "reel", conceptName: "Concept one", portfolioId: "rro-oil", hook: "Hook one", tension: "It teaches something useful.", sendTo: "Sibling", gate: gate(true) },
            { assetId: "RRO-02", format: "carousel", conceptName: "Concept two", portfolioId: "rro-dairy", hook: "Hook two", tension: "Tension two", sendTo: "Parent", gate: gate(true) },
          ],
        },
        candidates: {},
        locks: {},
      },
      copy: { status: "locked" }, "creative-direction": { status: "locked" }, "deck-builder": { status: "locked" },
    },
    approvals: {},
    metrics: {
      strategy: {
        durationMs: 4000, attempts: 1, repairs: 0, outcome: "needs_review",
        servedBy: "claude+openai", modelTier: "standard", escalated: false,
        competition: { servedBy: "claude+openai", contested: true, basedOn: "claude", swapsFromChallenger: 1, swaps: [{ assetId: "RRO-01", from: 5, to: 8 }] },
        criticVerdicts: [
          { assetId: "RRO-01", logoSwapPass: true, killListPass: true, tensionPass: false, overheardPass: true, score: 8, reasoning: "Strong anchor, but the tension reads like a category truism.", fixes: ["State the actual friction, not the benefit."] },
          { assetId: "RRO-02", logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true, score: 9, reasoning: "Specific and well-anchored.", fixes: [] },
        ],
        criticPortfolioNotes: ["Two concepts lean on the same 'reuse the oil' territory."],
        gateWarnings: null,
        criticSkippedReason: null,
      },
    },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1400, height: 1400 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("__fakeAuthUser", JSON.stringify({ uid: "u", email: "gokul@loona.in", displayName: "Gokul" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "run list renders" });
  await page.locator("tr", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator("text=Concepts").count()) > 0 || null, { label: "strategy review renders" });

  const panelText = await page.locator(".st-workspace-main").textContent();

  // ---- Stage-level summary ----
  check("names both models and that one led overall", /Claude.*led overall|led overall.*Claude/.test(panelText), panelText.slice(0, 400));
  check("reports the swap count from independent review", /1 concept came from the runner-up/.test(panelText), panelText.slice(0, 400));
  check("surfaces the portfolio-level note", panelText.includes("reuse the oil"), panelText.slice(0, 600));

  // ---- Per-asset critic note ----
  check("RRO-01's independent score is shown", panelText.includes("Independent review: 8/10"), panelText.slice(0, 800));
  check("RRO-01's critic reasoning is shown", panelText.includes("category truism"), panelText.slice(0, 800));
  check("RRO-01's suggested fix is shown", panelText.includes("State the actual friction"), panelText.slice(0, 800));

  // ---- The disputed-gate indicator: self-report says pass, critic says fail ----
  const rro01Row = page.locator(".st-concept-row", { hasText: "Concept one" });
  const disputedChip = rro01Row.locator(".st-chip", { hasText: "Tension" });
  check("the disputed gate is still shown as passing (the self-reported value)", (await disputedChip.textContent()).includes("✓"));
  check("the disputed gate carries the disagreement marker", (await disputedChip.textContent()).includes("⚠"));
  const disputedTitle = await disputedChip.getAttribute("title");
  check("the disputed gate explains why it's marked", disputedTitle && disputedTitle.includes("disagreed"), disputedTitle);

  // ---- A gate where self-report and critic AGREE must not be falsely flagged ----
  const rro01LogoChip = rro01Row.locator(".st-chip", { hasText: "Logo-swap" });
  check("an agreeing gate carries no disagreement marker", !(await rro01LogoChip.textContent()).includes("⚠"), await rro01LogoChip.textContent());

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
