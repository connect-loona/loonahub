#!/usr/bin/env node
// Assembles dist/ for deploy: the legacy Hub's static files (untouched, allowlisted below)
// alongside the new Strategy OS build's own output at dist/strategy/.
//
// Why an allowlist, not "copy everything except node_modules/tests/etc.": a denylist fails
// open — a new top-level file added later and forgotten about would get published by
// default. An allowlist fails closed — it just doesn't get served until someone deliberately
// adds it here, which is the safer default for what's effectively "the legacy Hub's public
// surface" from here on.
//
// Order matters: dist/ is wiped first, THEN apps/strategy builds (creating dist/strategy/),
// THEN the legacy files are copied in — so a legacy file can never clobber the Strategy
// build's own output, and vice versa.
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const LEGACY_FILES = [
  "index.html",
  "app.js",
  "strategy-app.js",
  "strategy-ui.js",
  "design-tokens.css",
  "monitoring.css",
  "monitoring.js",
  "sw.js",
  "manifest.json",
  "robots.txt",
  "apple-touch-icon.png",
  "apple-touch-icon-precomposed.png",
];
// "strategy-old" is a frozen rollback snapshot (see strategy-old/README.md) — copied
// verbatim like any other legacy dir, but deliberately NOT kept in sync with the live
// files of the same name at the repo root.
const LEGACY_DIRS = ["assets", "icons", "independence", "strategy-old"];

console.log("Cleaning dist/...");
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

console.log("Building Strategy OS (apps/strategy)...");
execSync("npm ci && npm run build", { cwd: path.join(ROOT, "apps/strategy"), stdio: "inherit" });

console.log("Copying legacy Hub static files into dist/...");
for (const file of LEGACY_FILES) {
  const src = path.join(ROOT, file);
  if (!fs.existsSync(src)) { console.warn(`  (skipping missing file: ${file})`); continue; }
  fs.copyFileSync(src, path.join(DIST, file));
}
for (const dir of LEGACY_DIRS) {
  const src = path.join(ROOT, dir);
  if (!fs.existsSync(src)) { console.warn(`  (skipping missing dir: ${dir})`); continue; }
  fs.cpSync(src, path.join(DIST, dir), { recursive: true });
}

console.log("dist/ ready.");
