// Every function that touches the Netlify Blobs store must reach it through
// _shared/visual-blob-store.mjs, which is the only place that statically imports
// @netlify/blobs and calls configureNetlifyStore().
//
// Importing lib/strategy/visual-assets.js directly instead leaves the module-level store
// factory unset, so the function deploys and runs perfectly until the first line that
// actually reads or writes an image — and then throws "Netlify Blobs was not configured for
// this Visual Studio function." That is exactly how Ask BB shipped with every attachment
// silently broken: the upload worked, the request was accepted, and only the background
// worker that finally read the image failed.
//
// Nothing in the type system or the bundler catches that, so it is caught here instead: walk
// each function's real import graph and assert that reaching the store implies configuring it.
"use strict";
const fs = require("fs");
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");

const FUNCTIONS = path.join(HUB, "netlify/functions");
const ASSETS = path.join(FUNCTIONS, "lib/strategy/visual-assets.js");
const SHIM = path.join(FUNCTIONS, "_shared/visual-blob-store.mjs");
// Every visual-assets export whose first act is storeFor() — calling any of these without a
// configured factory throws.
const STORE_CALLS = ["saveBuffer", "saveBBAttachment", "loadAsset", "preserveGeneratedImages", "referenceForProvider", "storeFor"];

// Bare `import "./x.mjs"` counts: a side-effect-only import of the shim is exactly how
// several functions correctly configure the store, so missing it would report false alarms.
const SPECIFIER = /(?:require\(\s*["']([^"']+)["']\s*\)|(?:from|import)\s*["']([^"']+)["'])/g;

function localSpecifiers(file) {
  let source;
  try { source = fs.readFileSync(file, "utf8"); } catch { return []; }
  const found = [];
  let match;
  while ((match = SPECIFIER.exec(source))) {
    const spec = match[1] || match[2];
    if (spec && spec.startsWith(".")) found.push(spec);
  }
  SPECIFIER.lastIndex = 0;
  return found;
}

function resolveFrom(file, spec) {
  const base = path.resolve(path.dirname(file), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of localSpecifiers(file)) {
      const resolved = resolveFrom(file, spec);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

(async () => {
  const entries = fs.readdirSync(FUNCTIONS)
    .filter((name) => /\.(mjs|js)$/.test(name))
    .map((name) => path.join(FUNCTIONS, name));
  check("there are function entry points to inspect", entries.length > 10, entries.length);

  const offenders = [];
  let reachCount = 0;
  for (const entry of entries) {
    const closure = importClosure(entry);
    if (!closure.has(ASSETS)) continue;

    // Only care when something in the bundle actually calls a store-backed export — merely
    // importing visual-assets for a constant or a validator never touches Blobs.
    const callsStore = [...closure].filter((file) => file !== ASSETS).some((file) => {
      const source = fs.readFileSync(file, "utf8");
      return STORE_CALLS.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(source));
    });
    if (!callsStore) continue;

    reachCount += 1;
    if (!closure.has(SHIM)) offenders.push(path.basename(entry));
  }

  check("several functions genuinely reach the Blobs store, so this test is actually checking something", reachCount >= 4, reachCount);
  check("every function that reads or writes Blobs goes through the shim that configures it",
    offenders.length === 0, offenders.length ? `not configured: ${offenders.join(", ")}` : "all configured");

  // The regression that took Ask BB's attachments down in production.
  const bbBackground = path.join(FUNCTIONS, "strategy-bb-chat-background.mjs");
  const bbClosure = importClosure(bbBackground);
  check("strategy-bb-chat-background reads attachments through the configured shim", bbClosure.has(SHIM));
  check("and does not import lib/strategy/visual-assets.js directly",
    !/from\s+["']\.\/lib\/strategy\/visual-assets\.js["']/.test(fs.readFileSync(bbBackground, "utf8")));

  // If the shim ever stops configuring the store, every check above passes vacuously.
  check("the shim still calls configureNetlifyStore", /configureNetlifyStore\(\s*getStore\s*\)/.test(fs.readFileSync(SHIM, "utf8")));

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
