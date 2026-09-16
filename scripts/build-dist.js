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

// --include=dev, explicitly. These apps build with Vite and TypeScript, which are
// devDependencies — and `npm ci` installs only production dependencies when NODE_ENV is
// "production", which is exactly what a deploy environment is likely to set. The failure that
// produces is a wall of TS2307 "cannot find module 'vite'" errors that reads like the code is
// broken, when the toolchain simply was not installed. A build's own tools must not depend on
// an ambient variable meant for runtime behaviour.
const buildApp = (dir) => execSync("npm ci --include=dev && npm run build", {
  cwd: path.join(ROOT, dir),
  stdio: "inherit",
  // Belt and braces: even with the flag above, some tooling reads NODE_ENV to decide what to
  // emit. The app builds want a production BUILD, which Vite already does by default here.
  env: Object.assign({}, process.env, { NODE_ENV: "" }),
});

console.log("Building Strategy OS (apps/strategy)...");
buildApp("apps/strategy");

// Do not allow a future Vite/config change to silently restore Strategy's fragile external
// stylesheet. This guard runs in every Netlify/CI production build and catches the exact
// failure mode that otherwise leaves the React app functional but visually reduced to raw
// HTML on a user's device.
const strategyHtmlPath = path.join(DIST, "strategy", "index.html");
const strategyHtml = fs.readFileSync(strategyHtmlPath, "utf8");
if (!strategyHtml.includes("data-loona-strategy-css")) {
  throw new Error("Strategy OS build is missing its inline stylesheet marker.");
}
if (/<link\b[^>]*rel=["']stylesheet["']/i.test(strategyHtml)) {
  throw new Error("Strategy OS build unexpectedly depends on an external stylesheet.");
}

// Visual Studio, on the same footing as Strategy OS: its own Vite build, landing at
// dist/visual/. Both run before the legacy files are copied in, so a legacy file can never
// clobber an app's output.
console.log("Building Visual Studio (apps/visual)...");
buildApp("apps/visual");

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
