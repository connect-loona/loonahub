// e2e test for the new React Strategy OS run detail / review-gate screen at /strategy/ —
// the working-instructions doc calls this "the interface that matters most": thirteen
// concept cards, each editable, regeneratable with a stated reason, or killable with a
// stated reason. Checks the stage rail, brand memory panel, "Your next action" card, and
// the strategy stage's concept cards (gates, candidate preview, lock toggle, approve)
// against the same fixtures the legacy tests use — a genuine like-for-like comparison of
// the port's fidelity, not a fresh design tested in isolation.
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

function gate(pass) { return { logoSwapPass: pass, killListPass: true, tensionPass: true, overheardPass: true }; }

(async () => {
  const runId = "react-detail-test-run";
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, {
    rro: {
      id: "rro", name: "RRO Foods", oneLineTruth: "Real oil, honestly labelled.",
      audiences: [{ description: "Home cooks who reuse oil" }, { description: "Health-conscious parents" }],
      approvedWork: [{ title: "Q3 Deck", url: "https://example.com/deck", month: "2026-07", type: "deck" }],
    },
  });
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul", status: "strategy_needs_review",
    runtime: "fixture", fixtureDir,
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      research: { status: "approved", checkpoint: { arguments: [] } },
      strategy: {
        status: "needs_review",
        checkpoint: {
          monthThesis: "The ingredient people treat as background is often the decision changing the result.",
          assets: [
            { assetId: "RRO-01", format: "reel", conceptName: "Concept one", portfolioId: "rro-oil", hook: "Hook one", tension: "Tension one", sendTo: "Sibling", gate: gate(true) },
            { assetId: "RRO-02", format: "carousel", conceptName: "Concept two", portfolioId: "rro-dairy", hook: "Hook two", tension: "Tension two", sendTo: "Parent", gate: gate(false) },
            { assetId: "RRO-03", format: "static", conceptName: "Concept three", portfolioId: "rro-oil", hook: "Hook three", tension: "Tension three", sendTo: "Cook", gate: gate(true) },
          ],
        },
        candidates: {
          "RRO-01": { status: "ready", requestType: "similar", candidate: { conceptName: "Replacement concept", hook: "New hook", tension: "New tension" } },
        },
        locks: {},
      },
    },
    approvals: {},
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let dialogLog = [];
  page.on("dialog", async (dialog) => {
    dialogLog.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "confirm") await dialog.accept();
    else if (dialog.type() === "prompt") await dialog.accept("Test reason.");
    else await dialog.dismiss();
  });

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "run list renders" });

  await page.locator("tr", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator(".st-stage-rail").count()) > 0 || null, { label: "run detail renders with stage rail" });

  // ---- Stage rail ----
  const doneSteps = await page.locator(".st-stage-step.is-done").allTextContents();
  check("rail marks Research as done", doneSteps.some((t) => t.includes("Research")), doneSteps);
  const activeStep = await page.locator(".st-stage-step.is-active").textContent();
  check("rail highlights Strategy as active", activeStep.includes("Strategy"), activeStep);

  // ---- Brand memory ----
  const memoryText = await page.locator(".st-workspace-side", { hasText: "Brand memory" }).textContent();
  check("brand memory shows the brand truth", memoryText.includes("Real oil, honestly labelled."), memoryText);
  check("brand memory shows approved work", memoryText.includes("Q3 Deck"));

  // ---- Next action card ----
  const reviewPanelText = await page.locator(".st-review-panel").textContent();
  check("next action card shows Ready for review", reviewPanelText.includes("Ready for review"), reviewPanelText.slice(0, 200));
  check("next action card offers Approve", await page.locator(".st-review-panel button", { hasText: "Approve" }).count() > 0);
  check("next action card offers Send back with notes", await page.locator(".st-review-panel button", { hasText: "Send back with notes" }).count() > 0);

  // ---- Concept cards ----
  const mainText = await page.locator(".st-workspace-main").textContent();
  check("all three concepts render", ["Concept one", "Concept two", "Concept three"].every((c) => mainText.includes(c)), mainText.slice(0, 300));
  check("month thesis renders", mainText.includes("The ingredient people treat as background"));
  const passChips = await page.locator(".st-chip-pass").count();
  const failChips = await page.locator(".st-chip-fail").count();
  check("gate chips render both pass and fail states", passChips > 0 && failChips > 0, { passChips, failChips });

  // ---- Candidate preview (seeded ready candidate on RRO-01) ----
  check("the seeded candidate shows as a proposed replacement", mainText.includes("Replacement concept") && mainText.includes("Proposed replacement"));

  // ---- Discard the candidate suggestion ----
  await page.locator("button", { hasText: "Discard suggestion" }).click();
  await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy/candidates/RRO-01.json`)).body;
    return r === null ? true : null;
  }, { label: "candidate cleared via the new endpoint" });
  // Firebase itself is already clear at this point, but the page's own polling fake
  // backend (firebase.fake.ts) hasn't necessarily caught up yet — wait for the UI to
  // actually reflect it rather than checking on the same tick as the Firebase-side wait.
  await waitFor(async () => (await page.locator("text=Proposed replacement").count()) === 0 || null, { label: "candidate preview disappears from the page" });
  check("candidate preview disappears from the page", true);

  // ---- Lock toggle ----
  const rro2Row = page.locator(".st-concept-row", { hasText: "Concept two" });
  await rro2Row.locator("button", { hasText: "Lock" }).click();
  const lockedRun = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy/locks/RRO-02.json`)).body;
    return r || null;
  }, { label: "lock recorded via the new endpoint" });
  check("lock is recorded with the actor", lockedRun.lockedBy === "Gokul", lockedRun);
  await waitFor(async () => (await rro2Row.locator("button", { hasText: "🔒 Locked" }).count()) > 0 || null, { label: "row shows locked state" });
  check("concept row shows the locked button label", true);
  check("lock summary reflects 1 of 3 locked", (await page.locator(".st-lock-summary").textContent()).includes("1 of 3 locked"));

  // ---- Approve the strategy stage ----
  await page.locator(".st-review-panel button", { hasText: "Approve" }).click();
  const approvedRun = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    return r && r.stages.strategy.status === "approved" ? r : null;
  }, { label: "strategy stage approved via the new endpoint" });
  check("strategy stage is approved", approvedRun.stages.strategy.status === "approved");
  check("approval recorded the actor", approvedRun.approvals.strategy.decidedBy === "Gokul", approvedRun.approvals.strategy);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
