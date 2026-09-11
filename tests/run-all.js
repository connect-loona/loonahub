#!/usr/bin/env node
// Orchestrator for the whole Strategy OS test suite: starts the two harness stand-in
// servers (fake-rtdb-server.js on FAKE_RTDB_PORT, netlify-dev-lite.js on DEV_LITE_PORT),
// runs every backend test in tests/strategy/ and every Playwright UI test in tests/e2e/ in
// sequence (each as its own process, for the same isolation these tests always ran with
// during development), then tears the servers down. Exits non-zero if any sub-test fails.
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn, execSync } = require("child_process");
const http = require("http");

const HUB = path.join(__dirname, "..");
const RTDB_PORT = process.env.FAKE_RTDB_PORT || 9030;
const DEV_LITE_PORT = process.env.DEV_LITE_PORT || 9020;

// Every test file only wipes the specific paths it cares about (matching what a human
// tester would clear before checking a specific flow), so leftover data from earlier files
// — runs, learning events, activity logs, full fixture checkpoints — piles up in the shared
// fake-rtdb-server across the whole suite. Left alone, that pile-up is enough to visibly
// slow down UI tests that render "all runs"/"all brands" lists late in the run (a real
// timeout was observed here once the store had ~18 files' worth of accumulated docs). Wipe
// every known Strategy OS path before each file so every test starts against a clean store,
// regardless of what the file itself remembers to reset.
const ALL_STRATEGY_PATHS = [
  "strategy_runs", "strategy_brands", "strategy_months", "strategy_learning_events",
  "strategy_learnings", "strategy_activity", "strategy_stage_versions", "strategy_brand_library",
  "strategy_feedback", "tasks",
];
function wipeAll(rtdbUrl) {
  return Promise.all(ALL_STRATEGY_PATHS.map((p) => new Promise((resolve) => {
    const req = http.request(`${rtdbUrl}/${p}.json`, { method: "PUT", headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", resolve);
    req.end("null");
  })));
}

function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`));
        setTimeout(attempt, 200);
      });
    })();
  });
}

function spawnServer(scriptPath, extraEnv) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: HUB,
    env: Object.assign({}, process.env, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child._output = () => output;
  return child;
}

function runTestFile(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [filePath], { cwd: HUB, stdio: "inherit" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function listTestFiles(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((f) => path.join(dir, f));
}

(async () => {
  console.log("Starting harness servers...");
  const rtdb = spawnServer(path.join(HUB, "tests/harness/fake-rtdb-server.js"), { FAKE_RTDB_PORT: RTDB_PORT });
  const devLite = spawnServer(path.join(HUB, "tests/harness/netlify-dev-lite.js"), {
    DEV_LITE_PORT,
    FIREBASE_DB_URL: `http://127.0.0.1:${RTDB_PORT}`,
  });

  let results = [];
  try {
    await waitForHttp(`http://127.0.0.1:${RTDB_PORT}/.json`);
    await waitForHttp(`http://127.0.0.1:${DEV_LITE_PORT}/index.html`);
    console.log("Harness servers are up.\n");

    // Optional filter: `node tests/run-all.js strategy` or `node tests/run-all.js e2e`
    // runs just that half of the suite (used by the npm test:strategy/test:e2e scripts).
    const only = process.argv[2];
    const strategyTests = only === "e2e" ? [] : listTestFiles(path.join(HUB, "tests/strategy"), ".test.js");
    const e2eTests = only === "strategy" ? [] : listTestFiles(path.join(HUB, "tests/e2e"), ".spec.js");
    const allTests = strategyTests.concat(e2eTests);

    // The React Strategy OS e2e tests (tests/e2e/strategy-react-*.spec.js) load
    // apps/strategy's built output at /strategy/ (see netlify-dev-lite.js's own handling
    // of that path) — built in test mode, which swaps in firebase.fake.ts instead of the
    // real Firebase SDK (see apps/strategy/src/lib/firebase.ts). Only worth doing when
    // e2e tests are actually going to run.
    if (e2eTests.length > 0) {
      console.log("Building Strategy OS (test mode)...");
      execSync("npm ci && npm run build:test", { cwd: path.join(HUB, "apps/strategy"), stdio: "inherit" });
    }

    const rtdbUrl = `http://127.0.0.1:${RTDB_PORT}`;
    for (const file of allTests) {
      const label = path.relative(HUB, file);
      await wipeAll(rtdbUrl);
      console.log(`\n=== ${label} ===`);
      const passed = await runTestFile(file);
      results.push({ label, passed });
    }
  } finally {
    rtdb.kill();
    devLite.kill();
  }

  console.log("\n\n===== SUMMARY =====");
  for (const r of results) {
    console.log((r.passed ? "✅" : "❌") + " " + r.label);
  }
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    console.log(`\n✅ ALL ${results.length} TEST FILES PASSED`);
    process.exit(0);
  } else {
    console.log(`\n❌ ${failed.length} OF ${results.length} TEST FILES FAILED`);
    process.exit(1);
  }
})();
