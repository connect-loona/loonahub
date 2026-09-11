// e2e coverage for AgentGreeting.tsx — the "we're here to help you" agent lineup shown
// once per browser session on the run list.
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

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_runs.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, { rro: { id: "rro", name: "RRO Foods" } });

  const browser = await chromium.launch(chromiumLaunchOptions());

  // ---- First visit of a session: the greeting renders with the full agent lineup ----
  const context1 = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  await context1.addCookies([authCookie()]);
  const page1 = await context1.newPage();
  const errors1 = [];
  page1.on("pageerror", (e) => errors1.push(e.message));

  await page1.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page1);
  await page1.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page1.locator("text=We're here to help you build this month's strategy").count()) > 0 || null, { label: "agent greeting renders" });
  check("greeting text renders", true);

  for (const name of ["Columbus", "Dora", "Matilda", "Barbie", "Bob"]) {
    check(`lineup includes ${name}`, await page1.locator(".st-agent-chip-name", { hasText: name }).count() > 0);
  }
  check("all five agent chips rendered", await page1.locator(".st-agent-chip").count() === 5);

  // ---- Dismissing hides it, and it stays hidden across a reload in the same session ----
  await page1.locator(".st-agent-greeting-close").click();
  await waitFor(async () => (await page1.locator(".st-agent-greeting").count()) === 0 || null, { label: "greeting dismissed" });
  check("dismissing removes the greeting", true);

  await page1.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page1.locator("button", { hasText: "+ New strategy run" }).count()) > 0 || null, { label: "run list re-renders after reload" });
  check("greeting stays dismissed across a reload in the same session (sessionStorage)", await page1.locator(".st-agent-greeting").count() === 0);

  // ---- A fresh session (new browser context = fresh sessionStorage) sees it again ----
  const context2 = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  await context2.addCookies([authCookie()]);
  const page2 = await context2.newPage();
  const errors2 = [];
  page2.on("pageerror", (e) => errors2.push(e.message));

  await page2.goto(`${DEV_LITE_URL}/strategy/`, { waitUntil: "domcontentloaded" });
  await loginAsFakeUser(page2);
  await page2.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page2.locator(".st-agent-greeting").count()) > 0 || null, { label: "greeting renders again in a fresh session" });
  check("a new browser session sees the greeting again", true);

  check("no page errors (session 1)", errors1.length === 0, errors1);
  check("no page errors (session 2)", errors2.length === 0, errors2);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
