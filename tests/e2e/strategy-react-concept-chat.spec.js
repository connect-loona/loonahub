// e2e coverage for ConceptChatPanel.tsx — clicking "Refine" on a concept card opens a
// running chat: each message chains onto whatever the previous round produced (rendered as
// a growing transcript), and "Finalize" commits the latest round into the checkpoint. Runs
// against the real fixture runtime end to end (same fixtureDir/strategy.json every other
// concept-card e2e test uses), not a hand-seeded candidate — this is exercising the actual
// multi-turn conversation, not just the presence of a ready candidate.
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

(async () => {
  const runId = "react-concept-chat-test-run";
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const researchFixture = require(path.join(fixtureDir, "research.json"));
  const strategyFixture = require(path.join(fixtureDir, "strategy.json"));

  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });
  await req("PUT", `${RTDB_URL}/strategy_runs/${runId}.json`, {
    runId, brandId: "rro", month: "2026-10", owner: "Gokul", status: "strategy_needs_review",
    runtime: "fixture", fixtureDir,
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    stages: {
      // A per-asset "refine" re-validates the whole strategy checkpoint (validateStrategy
      // cross-references research's own liveQuestions/arguments/etc ids), so — unlike other
      // concept-card e2e tests that only ever APPROVE strategy wholesale — this one needs
      // the real research checkpoint, not a stub.
      research: { status: "approved", checkpoint: researchFixture },
      strategy: { status: "needs_review", checkpoint: strategyFixture, locks: {} },
    },
    approvals: {},
  });
  const originalAsset = strategyFixture.assets.find((a) => a.assetId === "RRO-01");

  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  await context.addCookies([authCookie()]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("text=RRO Foods").count()) > 0 || null, { label: "run list renders" });
  await page.locator("tr", { hasText: "RRO Foods" }).click();
  await waitFor(async () => (await page.locator(".st-stage-rail").count()) > 0 || null, { label: "run detail renders" });

  const rro01Row = page.locator(".st-concept-row", { hasText: "RRO-01" });

  // ---- 1. Opening the chat with no candidate yet shows a plain compose box, no thread ----
  await rro01Row.locator("button", { hasText: "Refine" }).click();
  check("compose box opens with no thread yet", await rro01Row.locator(".st-chat-thread").count() === 0);
  check("Send is offered", await rro01Row.locator("button", { hasText: "Send" }).count() > 0);

  // ---- 2. First message ----
  await rro01Row.locator("textarea").fill("Make it about pan loyalty vs oil indifference.");
  await rro01Row.locator("button", { hasText: "Send" }).click();
  await waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy/candidates/RRO-01.json`)).body;
    return c && c.status === "ready" ? c : null;
  }, { label: "first refine candidate ready" });
  await waitFor(async () => (await rro01Row.locator("text=Proposed replacement").count()) > 0 || null, { label: "candidate preview renders" });
  check("first turn's note renders in the thread", (await rro01Row.locator(".st-chat-thread").textContent()).includes("pan loyalty"));
  check("an assistant turn renders too", (await rro01Row.locator(".st-chat-turn-assistant").count()) > 0);
  check("Finalize is offered", await rro01Row.locator("button", { hasText: "Finalize" }).count() > 0);

  // ---- 3. Second message — the compose box is still there once ready, no need to reopen
  // "Refine" — and it chains onto the first round instead of losing it ----
  await rro01Row.locator("textarea").fill("Now lean harder into the loyalty angle.");
  await rro01Row.locator("button", { hasText: "Send" }).click();
  await waitFor(async () => {
    const c = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}/stages/strategy/candidates/RRO-01.json`)).body;
    return c && c.status === "ready" && c.history && c.history.length === 4 ? c : null;
  }, { label: "second (chained) refine candidate ready with 4 history turns" });
  await waitFor(async () => (await rro01Row.locator(".st-chat-turn-user").count()) === 2 || null, { label: "second turn's UI catches up" });
  const threadText = await rro01Row.locator(".st-chat-thread").textContent();
  check("BOTH rounds' notes are still visible in the thread (chained, not replaced)", threadText.includes("pan loyalty") && threadText.includes("loyalty angle"), threadText);
  check("two assistant turns now render", (await rro01Row.locator(".st-chat-turn-assistant").count()) === 2);

  // ---- 4. Finalize commits the latest (second) round into the checkpoint ----
  await rro01Row.locator("button", { hasText: "Finalize" }).click();
  const runAfterFinalize = await waitFor(async () => {
    const r = (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
    const asset = r.stages.strategy.checkpoint.assets.find((a) => a.assetId === "RRO-01");
    return asset.hook !== originalAsset.hook ? r : null;
  }, { label: "finalize commits the candidate into the checkpoint" });
  check("checkpoint hook actually changed", true);
  check("checkpoint still has the same asset count", runAfterFinalize.stages.strategy.checkpoint.assets.length === strategyFixture.assets.length);
  await waitFor(async () => (await rro01Row.locator(".st-chat-thread").count()) === 0 || null, { label: "chat thread closes after finalize" });
  check("chat closes after finalize (candidate cleared)", true);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
