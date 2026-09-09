// Shared helpers for every test in tests/strategy/ and tests/e2e/ — one source of truth
// for the repo path, the two local dev servers' URLs, the auth cookie tests authenticate
// with, HTTP request helpers, polling waits, and the Playwright browser-launch options
// (portable between this sandbox, where Chromium is pre-installed at a fixed path, and CI,
// where `npx playwright install` puts it wherever Playwright's own cache lives).
"use strict";
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const HUB = path.join(__dirname, "..", "..");
const RTDB_URL = process.env.FIREBASE_DB_URL || "http://localhost:9030";
const DEV_LITE_URL = process.env.DEV_LITE_URL || "http://localhost:9020";

// Matches netlify-dev-lite.js's own default BASIC_AUTH_CREDENTIALS — every test
// authenticates as this same fake team login.
const AUTH_TOKEN = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");

// Plain HTTP request helper (Node's http module, no fetch dependency) — used both for
// talking to the fake RTDB directly and for calling netlify-dev-lite's function routes
// from Node-based (non-browser) tests. `auth: true` adds the same loona_auth cookie +
// x-forwarded-proto header a real authenticated browser session would send.
function req(method, url, body, { auth = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (auth) { headers.Cookie = `loona_auth=${AUTH_TOKEN}`; headers["X-Forwarded-Proto"] = "http"; }
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Polls `fn` until it returns a truthy value or the timeout elapses. Used instead of a
// flat sleep everywhere in this suite — a fixed-duration wait after a write is a guess
// about how long that write takes to become visible, and has caused real false-negative
// test failures in this project before (see git history); a poll waits for the actual
// condition instead.
async function waitFor(fn, { label = "condition", timeoutMs = 15000, intervalMs = 150 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

// Wipes a list of top-level Firebase paths back to empty — call at the start of every test
// file so runs don't bleed state into each other (they all share the same fake RTDB
// process across a whole `npm run test:strategy` invocation).
const ALL_STRATEGY_PATHS = [
  "strategy_runs", "strategy_brands", "strategy_months", "strategy_learning_events",
  "strategy_learnings", "strategy_activity", "strategy_stage_versions", "strategy_brand_library",
  "tasks",
];
async function wipeFirebase(paths = ALL_STRATEGY_PATHS) {
  for (const p of paths) await req("PUT", `${RTDB_URL}/${p}.json`, null);
}

// Playwright's chromium.launch() options — reuses this sandbox's pre-installed browser
// when present, otherwise leaves options empty so Playwright falls back to whatever
// `npx playwright install` put in its own cache (e.g. in CI).
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
function chromiumLaunchOptions() {
  return fs.existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};
}

// Passed to page.addInitScript() — Playwright re-serializes this function's source and
// runs it fresh inside the browser context, so it must stay self-contained (no closing
// over anything outside its own params). Gives the page a fixed Date and a plain
// HTTP-polling stand-in for the Firebase JS SDK, backed by the fake RTDB server.
function combinedInit({ fixed, baseUrl }) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) { super(fixed); } else { super(...args); } }
    static now() { return fixed; }
  }
  window.Date = FixedDate;
  function makeRef(path) {
    var listeners = []; var pollTimer = null;
    function url() { return baseUrl + "/" + path.replace(/^\/+/, "") + ".json"; }
    function poll() {
      fetch(url()).then(function (r) { return r.json(); }).then(function (val) {
        listeners.forEach(function (cb) { cb({ val: function () { return val === undefined ? null : val; } }); });
      }).catch(function () {});
    }
    return {
      _path: path,
      on: function (evt, cb) { listeners.push(cb); poll(); if (!pollTimer) pollTimer = setInterval(poll, 200); },
      off: function (evt, cb) { listeners = listeners.filter(function (l) { return l !== cb; }); if (!listeners.length && pollTimer) { clearInterval(pollTimer); pollTimer = null; } },
      once: function () { return fetch(url()).then(function (r) { return r.json(); }).then(function (val) { return { val: function () { return val === undefined ? null : val; } }; }); },
      set: function (v) { return fetch(url(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v === undefined ? null : v) }); },
      update: function (v) { return fetch(url(), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) }); },
      remove: function () { return fetch(url(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: "null" }); },
      child: function (p) { return makeRef(path + "/" + p); },
      // Unlike a stub that returns a fake key without writing anything, this actually
      // POSTs so pushed docs are genuinely verifiable — Firebase's real push() also
      // returns synchronously with a client-generated key, but nothing here needs that
      // key back before the write lands.
      push: function (value) {
        var key = "k" + Math.random().toString(36).slice(2);
        fetch(baseUrl + "/" + path.replace(/^\/+/, "") + "/" + key + ".json", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }).catch(function () {});
        return { key: key };
      },
      transaction: function (fn) {
        return fetch(url()).then(function (r) { return r.json(); }).then(function (cur) {
          var next = fn(cur === undefined ? null : cur);
          if (next === undefined) return { committed: false, snapshot: { val: function () { return cur; } } };
          return fetch(url(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) })
            .then(function () { return { committed: true, snapshot: { val: function () { return next; } } }; });
        });
      },
    };
  }
  window.firebase = {
    apps: [], initializeApp: function () { window.firebase.apps.push({}); }, app: function () { return {}; },
    database: function () { return { ref: makeRef }; },
    auth: function () { return { onAuthStateChanged: function () { return function () {}; }, signOut: function () { return Promise.resolve(); }, currentUser: { getIdToken: function () { return Promise.resolve("t"); } } }; },
  };
}

// Standard fixed timestamp used across tests that need a stable "now" (Sep 9 2026, 06:00
// UTC) — matches the era every fixture in netlify/functions/lib/strategy/fixtures/ was
// written for.
const FIXED_NOW = Date.UTC(2026, 8, 9, 6, 0, 0);

// A run's "loona_auth" cookie, ready to hand to context.addCookies() in a Playwright test.
function authCookie(urlOrigin) {
  return { name: "loona_auth", value: AUTH_TOKEN, url: urlOrigin || DEV_LITE_URL };
}

// Logs a person into Hub inside the page — dismisses the onboarding prompts that would
// otherwise sit on top of the UI a test is trying to interact with.
async function loginAsGokul(page) {
  await page.evaluate(() => {
    window._profilePromptShown = true;
    localStorage.setItem("profile_prompt_dismissed_Gokul", "1");
    window._statusPromptShown = true;
    localStorage.setItem("status_prompt_dismissed_Gokul", "2026-09-03");
    login("Gokul");
  });
}

let allPass = true;
function check(name, cond, extra) {
  // eslint-disable-next-line no-console
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
  return cond;
}
function resetCheckState() { allPass = true; }
function allChecksPassed() { return allPass; }
function finish() {
  // eslint-disable-next-line no-console
  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
}

module.exports = {
  HUB, RTDB_URL, DEV_LITE_URL, AUTH_TOKEN, FIXED_NOW,
  req, sleep, waitFor, wipeFirebase,
  chromiumLaunchOptions, combinedInit, authCookie, loginAsGokul,
  check, resetCheckState, allChecksPassed, finish,
};
