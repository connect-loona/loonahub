// Quick smoke check that other Hub tabs still work fine — Strategy OS work is scoped
// entirely to its own IIFE and backend files, but this confirms nothing outside it broke
// (e.g. a stray syntax issue affecting the whole page's script parsing).
const { chromium } = require("playwright");
const { DEV_LITE_URL, FIXED_NOW, chromiumLaunchOptions, blockRealFirebaseSdk, loginAsGokul } = require("../harness/shared");

function fakeDateInit(fixed) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) { super(fixed); } else { super(...args); } }
    static now() { return fixed; }
  }
  window.Date = FixedDate;
}
const FAKE_FB_INIT = () => {
  window.__FB = { store: {}, listeners: [] };
  const FB = window.__FB;
  function getAtPath(path) { const parts = path.split("/").filter(Boolean); let cur = FB.store; for (const p of parts) { if (cur == null) return null; cur = cur[p]; } return cur === undefined ? null : cur; }
  function setAtPath(path, val) { const parts = path.split("/").filter(Boolean); let cur = FB.store; for (let i = 0; i < parts.length - 1; i++) { const p = parts[i]; if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {}; cur = cur[p]; } const last = parts[parts.length - 1]; if (val === null || val === undefined) delete cur[last]; else cur[last] = val; }
  function notify(path) { FB.listeners.forEach((l) => { if (l.path === path || path.startsWith(l.path + "/") || l.path.startsWith(path + "/")) { setTimeout(() => l.cb({ val: () => getAtPath(l.path) }), 0); } }); }
  function makeRef(path) {
    return {
      _path: path,
      on(evt, cb) { FB.listeners.push({ path, cb }); setTimeout(() => cb({ val: () => getAtPath(path) }), 0); },
      once() { return Promise.resolve({ val: () => getAtPath(path) }); },
      set(v) { setAtPath(path, v === undefined ? null : v); notify(path); return Promise.resolve(); },
      update(v) { const cur = getAtPath(path) || {}; const merged = Object.assign({}, cur); Object.keys(v).forEach((k) => { if (v[k] === null || v[k] === undefined) delete merged[k]; else merged[k] = v[k]; }); setAtPath(path, merged); notify(path); return Promise.resolve(); },
      remove() { setAtPath(path, null); notify(path); return Promise.resolve(); },
      child(p) { return makeRef(path + "/" + p); },
      push(value) { const key = "k" + Math.random().toString(36).slice(2); if (value !== undefined) { setAtPath(path + "/" + key, value); notify(path); } return { key }; },
      transaction(fn) { const cur = getAtPath(path); const next = fn(cur); if (next !== undefined) { setAtPath(path, next); notify(path); } return Promise.resolve({ committed: next !== undefined, snapshot: { val: () => next } }); },
    };
  }
  window.firebase = {
    apps: [], initializeApp() { window.firebase.apps.push({}); }, app() { return {}; }, database() { return { ref: makeRef }; },
    auth() { return { onAuthStateChanged() { return () => {}; }, signOut() { return Promise.resolve(); }, currentUser: { getIdToken: async () => "fake-id-token" } }; },
  };
};

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + extra : ""));
  allPass = allPass && cond;
}

(async () => {
  const browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage();
  await blockRealFirebaseSdk(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(fakeDateInit, FIXED_NOW);
  await page.addInitScript(FAKE_FB_INIT);
  await page.goto(`${DEV_LITE_URL}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await loginAsGokul(page);
  await page.waitForTimeout(500);

  // "Strategy OS" itself is now a real link straight into the rebuilt /strategy/ app (see
  // below), not a showPage() tab — clicking it here would navigate the whole page away from
  // the Hub SPA and break every check after it. "Strategy legacy" is the rollback button
  // that still activates the in-Hub #page-strategy panel the rest of this loop's pattern
  // expects.
  const tabs = ["Overview", "Task Board", "Monthly Plan", "Team", "Brands", "Strategy legacy", "Calendar", "Loona Code", "Loonaverse"];
  for (const tab of tabs) {
    await page.locator(".nav-btn", { hasText: tab }).click();
    await page.waitForTimeout(300);
    const activePage = await page.locator(".page.active").getAttribute("id");
    check(`clicking "${tab}" activates its page`, !!activePage, activePage);
  }

  // "Strategy OS" is the real nav link, not a showPage() tab — check it points straight at
  // the rebuilt React app rather than the legacy in-Hub page.
  const newAppLink = page.locator("a.nav-btn", { hasText: "Strategy OS" });
  check("the Strategy OS nav item links straight to the rebuilt /strategy/ app", await newAppLink.getAttribute("href") === "/strategy/", await newAppLink.getAttribute("href"));

  check("no uncaught page errors across all tab navigation", errors.length === 0, JSON.stringify(errors));
  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
