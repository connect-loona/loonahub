// e2e test for the research/copy/creative-direction/deck-builder review boards and the
// deck-complete actions (download/Canva/create team tasks) — the remaining Step 4 review
// screens ported from strategy-app.js's researchReviewHtml/copyReviewHtml/
// directionReviewHtml/deckReviewHtml/deckCompleteActionsHtml. Each stage gets its own run
// (distinguished by month) since a run's review body only ever shows its single most
// advanced reviewable stage.
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

async function openRunByMonth(page, monthLabel) {
  await page.locator("button", { hasText: /^Active/ }).click().catch(() => {});
  await waitFor(async () => (await page.locator("tr", { hasText: monthLabel }).count()) > 0 || null, { label: `run row for ${monthLabel} renders` });
  await page.locator("tr", { hasText: monthLabel }).click();
  await waitFor(async () => (await page.locator(".st-stage-rail").count()) > 0 || null, { label: `run detail opens for ${monthLabel}` });
}

async function backToList(page) {
  await page.locator("button", { hasText: "All runs" }).click();
  await waitFor(async () => (await page.locator("text=Strategy runs").count()) > 0 || null, { label: "back on run list" });
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });

  // ---- Research run ----
  await req("PUT", `${RTDB_URL}/strategy_runs/research-run.json`, {
    runId: "research-run", brandId: "rro", month: "2026-11", owner: "Gokul", status: "research_needs_review",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", approvals: {},
    stages: {
      research: {
        status: "needs_review",
        checkpoint: {
          sources: [{ id: "S1", url: "https://example.com/s1", type: "brand" }],
          liveQuestions: [{ verbatim: "Why does this taste different?", underlyingNeed: "Consistency", sourceIds: ["S1"] }],
          arguments: [{ disagreement: "Is fresh better than filtered?", sideA: "Fresh always wins", sideB: "Filtered is safer", credibleBrandPosition: "Filtered, done right", credibilityReason: "Matches our process" }],
          unspokenBehaviours: [{ behaviour: "People reuse oil past its prime", hiddenTension: "Guilt about waste" }],
          exhaustedTerritory: [{ territory: "Generic health claims", reasonExhausted: "Overused by every competitor" }],
        },
      },
    },
  });

  // ---- Copy run ----
  await req("PUT", `${RTDB_URL}/strategy_runs/copy-run.json`, {
    runId: "copy-run", brandId: "rro", month: "2026-12", owner: "Gokul", status: "copy_needs_review",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", approvals: {},
    stages: {
      research: { status: "approved", checkpoint: {} },
      strategy: { status: "approved", checkpoint: { monthThesis: "t", assets: [] } },
      copy: {
        status: "needs_review",
        checkpoint: {
          assets: [{
            assetId: "RRO-01", format: "reel", portfolioName: "Oil", hook: "The recipe is right.",
            onCreative: { cover: "Pan on stove", frames: [{ label: "Frame 1", text: "Pour oil" }] },
            script: { durationSeconds: 15, scenes: [{ timing: "0-3s", visual: "Close on pan", voiceover: "The recipe is right." }] },
            claimAudit: { status: "flagged", verificationFlags: ["Needs legal sign-off"] },
            captions: [{ version: 1, angle: "Nostalgia", copy: "Some things you inherit.", hashtags: ["#RRO"] }],
          }],
        },
        // Keyed by section (see pipeline.js's ASSET_STAGE_CONFIG.copy.sections /
        // CopyReview.tsx) — captions and script are now independently refinable threads.
        candidates: { "RRO-01::captions": { status: "ready", requestType: "refine", section: "captions", candidate: { hook: "New hook", captions: [{ version: 2, angle: "Bold", copy: "New copy line." }], claimAudit: { status: "ready" } } } },
        locks: {},
      },
    },
  });

  // ---- Creative direction run ----
  await req("PUT", `${RTDB_URL}/strategy_runs/direction-run.json`, {
    runId: "direction-run", brandId: "rro", month: "2027-01", owner: "Gokul", status: "creative-direction_needs_review",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", approvals: {},
    stages: {
      research: { status: "approved", checkpoint: {} },
      strategy: { status: "approved", checkpoint: { monthThesis: "t", assets: [] } },
      copy: { status: "approved", checkpoint: { assets: [] } },
      "creative-direction": {
        status: "needs_review",
        checkpoint: {
          assets: [{
            assetId: "RRO-01", format: "reel", productionMode: "in_house", visualConcept: "Warm kitchen morning light",
            artDirection: "Handheld, natural", palette: ["warm amber", "cream"], typography: "Serif display",
            composition: "Rule of thirds", shotList: [{ shot: "1", framing: "Close-up", action: "Pour oil", productVisibility: "Full label" }],
            references: [{ url: "https://example.com/ref", title: "Reference reel", source: "Instagram", useFor: "Pacing", rightsNote: "Internal use only" }],
            designNotes: ["Keep captions large"], avoid: ["Harsh studio lighting"],
          }],
          productionNotes: ["Shoot in the morning for natural light."],
        },
      },
    },
  });

  // ---- Deck run (needs_review, to check the review board + inline edits) ----
  await req("PUT", `${RTDB_URL}/strategy_runs/deck-run.json`, {
    runId: "deck-run", brandId: "rro", month: "2027-02", owner: "Gokul", status: "deck-builder_needs_review",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", approvals: {},
    stages: {
      research: { status: "approved", checkpoint: {} },
      strategy: { status: "approved", checkpoint: { monthThesis: "t", assets: [] } },
      copy: { status: "approved", checkpoint: { assets: [] } },
      "creative-direction": { status: "approved", checkpoint: { assets: [] } },
      "deck-builder": {
        status: "needs_review",
        checkpoint: {
          title: "February deck", pages: [{
            pageNumber: 1, assetId: "RRO-01", format: "reel", portfolioAndSku: "Oil / Filtered", idea: "The recipe is right",
            hook: "The recipe is right.", creativeCopy: "Some things you inherit.", direction: "Warm morning light",
            shotList: "Close on pan, pour oil", captionOne: "A", captionTwo: "B", captionThree: "C",
            owner: "", productionStatus: "not_started",
          }],
        },
      },
    },
  });

  // ---- Deck-complete run (already approved, to check the completion actions) ----
  await req("PUT", `${RTDB_URL}/strategy_runs/deck-complete-run.json`, {
    runId: "deck-complete-run", brandId: "rro", month: "2027-03", owner: "Gokul", status: "deck-builder_approved",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    approvals: { "deck-builder": { decidedAt: "2026-09-09T01:00:00.000Z", decidedBy: "Gokul" } },
    stages: {
      research: { status: "approved", checkpoint: {} },
      strategy: { status: "approved", checkpoint: { monthThesis: "t", assets: [] } },
      copy: { status: "approved", checkpoint: { assets: [] } },
      "creative-direction": { status: "approved", checkpoint: { assets: [] } },
      "deck-builder": {
        status: "approved",
        checkpoint: { title: "March deck", pages: [{ pageNumber: 1, assetId: "RRO-01", format: "reel", idea: "Idea", hook: "Hook", creativeCopy: "Copy", direction: "Dir", shotList: "Shots", captionOne: "A", captionTwo: "B", captionThree: "C", owner: "Priya", productionStatus: "complete" }] },
      },
    },
  });

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "run list renders" });

  // ---- Research review ----
  await openRunByMonth(page, "November 2026");
  let mainText = await page.locator(".st-workspace-main").textContent();
  check("research: live question renders", mainText.includes("Why does this taste different?"), mainText.slice(0, 200));
  check("research: category argument renders", mainText.includes("Is fresh better than filtered?"));
  check("research: unspoken behaviour renders", mainText.includes("People reuse oil past its prime"));
  check("research: kill list renders", mainText.includes("Generic health claims"));
  await backToList(page);

  // ---- Copy review ----
  await openRunByMonth(page, "December 2026");
  mainText = await page.locator(".st-workspace-main").textContent();
  check("copy: asset hook renders", mainText.includes("The recipe is right."));
  check("copy: caption renders", mainText.includes("Some things you inherit."));
  check("copy: claim audit chip renders", mainText.includes("flagged"));
  check("copy: verification flag renders", mainText.includes("Needs legal sign-off"));
  check("copy: candidate preview renders with copy-specific fields", mainText.includes("New copy line.") && mainText.includes("Proposed replacement"));
  check("copy: offers Replace (not Discard)", await page.locator(".st-workspace-main button", { hasText: "Replace" }).count() > 0);
  await backToList(page);

  // ---- Creative direction review ----
  await openRunByMonth(page, "January 2027");
  mainText = await page.locator(".st-workspace-main").textContent();
  check("creative-direction: visual concept renders", mainText.includes("Warm kitchen morning light"));
  check("creative-direction: shot list renders", mainText.includes("Pour oil"));
  check("creative-direction: reference renders", mainText.includes("Reference reel"));
  check("creative-direction: avoid note renders", mainText.includes("Harsh studio lighting"));
  check("creative-direction: production notes render", mainText.includes("Shoot in the morning"));
  await backToList(page);

  // ---- Deck review — inline edits ----
  await openRunByMonth(page, "February 2027");
  mainText = await page.locator(".st-workspace-main").textContent();
  check("deck: page idea renders", mainText.includes("The recipe is right"));
  await page.locator(".st-workspace-main input[placeholder='Owner']").fill("Priya");
  await page.locator(".st-workspace-main input[placeholder='Owner']").blur();
  const afterOwner = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/deck-run/stages/deck-builder/checkpoint/pages/0.json`)).body;
    return r && r.owner === "Priya" ? r : null;
  }, { label: "deck page owner saved via the new endpoint" });
  check("deck: owner field saved", afterOwner.owner === "Priya");
  await page.locator(".st-workspace-main select").selectOption("in_progress");
  const afterStatus = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/deck-run/stages/deck-builder/checkpoint/pages/0.json`)).body;
    return r && r.productionStatus === "in_progress" ? r : null;
  }, { label: "deck page status saved via the new endpoint" });
  check("deck: production status saved", afterStatus.productionStatus === "in_progress");
  await backToList(page);

  // ---- Deck-complete actions ----
  await openRunByMonth(page, "March 2027");
  const reviewPanelText = await page.locator(".st-review-panel").textContent();
  check("deck-complete: offers a download link", await page.locator(".st-review-panel a", { hasText: "Download deck" }).count() > 0);
  check("deck-complete: shows the Canva not-connected note", reviewPanelText.includes("Canva isn't connected"));
  check("deck-complete: offers Create team tasks", await page.locator(".st-review-panel button", { hasText: "Create team tasks" }).count() > 0);
  await page.locator(".st-review-panel button", { hasText: "Create team tasks" }).click();
  await waitFor(async () => (await page.locator(".st-review-panel button", { hasText: "Team tasks created" }).count()) > 0 || null, { label: "team tasks button shows created state" });
  const afterTasks = await req("GET", `${RTDB_URL}/strategy_runs/deck-complete-run.json`);
  check("deck-complete: teamTasksCreatedAt stamped", !!afterTasks.body.teamTasksCreatedAt, afterTasks.body.teamTasksCreatedAt);
  const tasks = (await req("GET", `${RTDB_URL}/tasks.json`)).body || {};
  check("deck-complete: a real task was created", Object.values(tasks).some((t) => t.strategy_run_id === "deck-complete-run"));

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
