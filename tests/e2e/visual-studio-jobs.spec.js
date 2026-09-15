// Visual Studio's generation path, in a browser, exactly as it ships.
//
// This file exists because of a specific failure mode. The app previously branched on
// `import.meta.env.MODE === "test"` and sent browser tests down a synchronous endpoint while
// production used a job queue with a background worker and polling. So the machinery that
// actually runs — the part that can strand a round, double-charge, or lose a generation on a
// refresh — had no browser coverage at all, and the suite stayed green precisely because it
// never touched it. The bypass is gone; this proves what replaced it.
//
// The image provider is a local stub (tests/harness/fake-openai-images.js), so this exercises
// the whole real chain — create job, kick background worker, poll, preserve bytes, serve them
// back through the authenticated asset route — without a key, a network, or a bill.
const { chromium } = require("playwright");
const {
  RTDB_URL, DEV_LITE_URL, chromiumLaunchOptions, authCookie, req, waitFor,
} = require("../harness/shared");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

const asUser = async (page) => page.evaluate(() => {
  localStorage.setItem("__fakeAuthUser", JSON.stringify({ uid: "u1", email: "gokul@loona.in", displayName: "Gokul" }));
});

(async () => {
  await req("PUT", `${RTDB_URL}/visual_chats.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_visual.json`, null);
  await req("PUT", `${RTDB_URL}/visual_jobs.json`, null);
  await req("PUT", `${RTDB_URL}/brands.json`, { b1: { brand: "RRO Foods" } });

  const browser = await chromium.launch(chromiumLaunchOptions);
  const context = await browser.newContext();
  await context.addCookies([authCookie(DEV_LITE_URL)]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${DEV_LITE_URL}/visual/`, { waitUntil: "domcontentloaded" });
  await asUser(page);
  await page.reload({ waitUntil: "domcontentloaded" });

  await waitFor(async () => (await page.locator(".vs-project").count()) > 0 || null, { label: "brands render" });
  await page.locator(".vs-project", { hasText: "RRO Foods" }).click();

  // ---- A generation really goes through the job queue ----
  await page.locator(".vs-composer textarea").fill("Primio bottle on a warm marble counter");
  await page.locator(".vs-send").click();

  // Queued or running, observable while it happens — which is only true because the harness
  // answers a background function with 202 and works afterwards, as Netlify does.
  await waitFor(async () => {
    const jobs = (await req("GET", `${RTDB_URL}/visual_jobs.json`)).body || {};
    return Object.keys(jobs).length > 0 ? jobs : null;
  }, { label: "a job record is created" });
  const jobsWhileRunning = (await req("GET", `${RTDB_URL}/visual_jobs.json`)).body || {};
  const firstJob = Object.values(jobsWhileRunning)[0];
  check("sending creates a job rather than calling the provider from the browser",
    Boolean(firstJob && firstJob.id), firstJob && { id: firstJob.id, status: firstJob.status });
  check("the job records which brand and chat it belongs to — never taken from the browser later",
    firstJob.brandId === "rro-foods" && Boolean(firstJob.chatId), { brandId: firstJob.brandId, chatId: firstJob.chatId });

  // The chat must be routable the instant it exists: a refresh one second later has to come
  // back to this conversation, not to an empty studio, or the round looks lost.
  const urlDuring = page.url();
  check("the URL names the brand and chat while the job is still running",
    /brand=rro-foods/.test(urlDuring) && /chat=/.test(urlDuring), urlDuring);

  await waitFor(async () => (await page.locator(".vs-round").count()) > 0 || null, { label: "the round lands", timeoutMs: 30000 });
  check("the finished round appears in the thread", (await page.locator(".vs-round").count()) === 1);

  const finishedJobs = (await req("GET", `${RTDB_URL}/visual_jobs.json`)).body || {};
  check("and the job is marked succeeded", Object.values(finishedJobs)[0].status === "succeeded",
    Object.values(finishedJobs)[0].status);

  // ---- The image is stored, and served from the asset route ----
  const imgSrc = await page.locator(".vs-image img").first().getAttribute("src");
  check("the image is served from the authenticated asset route, not a provider URL",
    /\/\.netlify\/functions\/visual-asset\?key=/.test(imgSrc || ""), imgSrc);
  const rendered = await page.locator(".vs-image img").first().evaluate((el) => el.naturalWidth > 0);
  check("and it actually renders — the bytes survived the round trip", rendered);

  // What the model was asked for is the REWRITTEN prompt, not the words typed. That rewrite is
  // the thing that closes the quality gap, and it is invisible unless something checks it.
  check("the expanded prompt is recorded", (await page.locator(".vs-expanded").count()) === 1);

  // ---- A completed round survives a refresh ----
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator(".vs-round").count()) > 0 || null, { label: "round restored after refresh" });
  check("a completed round is still there after a refresh", (await page.locator(".vs-round").count()) === 1);
  check("and the deep link still points at the same chat", /chat=/.test(page.url()), page.url());

  // ---- Picking writes exactly once ----
  // "Use this" is the whole action now — one click records the pick immediately. The reasons
  // panel (tags + note) used to sit between the click and the write; it was confusing more than
  // it was useful, so picking is a single unambiguous signal on its own.
  const chatId = new URL(page.url()).searchParams.get("chat");
  const before = (await req("GET", `${RTDB_URL}/strategy_visual/rro-foods.json`)).body || {};
  const generationId = Object.keys(before)[0];
  check("nothing is picked yet", before[generationId].pickedIndex === null || before[generationId].pickedIndex === undefined,
    before[generationId].pickedIndex);

  await page.locator('.vs-image figcaption button:text("Use this")').first().click();

  await waitFor(async () => {
    const record = (await req("GET", `${RTDB_URL}/strategy_visual/rro-foods/${generationId}.json`)).body;
    return record && record.pickedIndex === 0 ? record : null;
  }, { label: "the pick is saved" });
  const picked = (await req("GET", `${RTDB_URL}/strategy_visual/rro-foods/${generationId}.json`)).body;
  check("clicking Use this records the pick once", picked.pickedIndex === 0, picked.pickedIndex);

  // ---- Reconnecting to a job that is still in flight ----
  // A generation outlives the tab that started it: the worker keeps going and the round is paid
  // for either way. Refreshing mid-generation must rejoin it, not abandon it.
  await page.locator(".vs-composer textarea").fill("now try a cooler light");
  await page.locator(".vs-send").click();
  await waitFor(async () => {
    const jobs = Object.values((await req("GET", `${RTDB_URL}/visual_jobs.json`)).body || {});
    return jobs.some((job) => job.status === "queued" || job.status === "running") ? true : null;
  }, { label: "second job is in flight" });

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator(".vs-notice").count()) > 0 || (await page.locator(".vs-round").count()) > 1 || null,
    { label: "the refreshed page picks the job back up", timeoutMs: 30000 });

  await waitFor(async () => (await page.locator(".vs-round").count()) === 2 || null,
    { label: "the reconnected round lands", timeoutMs: 40000 });
  check("a refresh mid-generation rejoins the running job rather than losing the round",
    (await page.locator(".vs-round").count()) === 2, await page.locator(".vs-round").count());

  const allJobs = Object.values((await req("GET", `${RTDB_URL}/visual_jobs.json`)).body || {});
  check("and that reconnect did not start a second generation",
    allJobs.length === 2, allJobs.map((j) => j.status));

  // ---- A phone ----
  // The memory column is a fixed 280px on desktop; at phone width everything has to stack, and
  // the composer's controls must never end up behind the panel.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator(".vs-send").count()) > 0 || null, { label: "composer renders at 390px" });
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("the page does not scroll sideways on a phone", !overflows,
    await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })));
  const sendBox = await page.locator(".vs-send").boundingBox();
  check("and Generate is on screen rather than under a panel",
    Boolean(sendBox) && sendBox.x >= 0 && sendBox.x + sendBox.width <= 391, sendBox);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
