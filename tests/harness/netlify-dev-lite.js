// A minimal stand-in for `netlify dev` used only by this repo's own test suite — routes
// `/.netlify/functions/<name>` requests to the real handler modules under
// netlify/functions/, and serves the rest of the repo as static files (so a test's browser
// can load index.html, app.js, strategy-ui.js exactly as production does). No network
// access, no external dependencies — plain Node http.
"use strict";
// 127.0.0.1, not "localhost" — GitHub Actions runners don't support IPv6, and a browser
// resolving "localhost" can still try ::1 first and stall before falling back. Every e2e
// test fetches these URLs from inside a real Chromium page, so an ambiguous hostname here
// is enough to hang every one of them.
process.env.FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || "http://127.0.0.1:9030";
// Since the fail-closed auth fix, Strategy OS's endpoints reject any request with no
// matching loona_auth cookie — tests driving this server need to actually set that cookie
// in the browser context (see the addCookies() call in each Playwright test), matching this
// same credentials value's SHA-256 hash.
process.env.BASIC_AUTH_CREDENTIALS = process.env.BASIC_AUTH_CREDENTIALS || "gokul:supersecret";
process.env.URL = process.env.URL || "http://127.0.0.1:9020";

const http = require("http");
const fs = require("fs");
const path = require("path");
const HUB = path.join(__dirname, "..", "..");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css" };

// Mirrors netlify.toml's own /strategy/* redirect: that path is served from the built
// apps/strategy output at dist/strategy/, not the repo root like everything else here —
// so tests exercise the exact same routing shape production actually has, build step
// included (run `npm run build` before pointing a test at this server's /strategy/ path).
const STRATEGY_DIST = path.join(HUB, "dist", "strategy");

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";

  if (p === "/strategy" || p.startsWith("/strategy/")) {
    const rel = p === "/strategy" ? "/index.html" : p.slice("/strategy".length) || "/index.html";
    const assetPath = path.join(STRATEGY_DIST, rel);
    if (!assetPath.startsWith(STRATEGY_DIST)) { res.statusCode = 403; return res.end("forbidden"); }
    return fs.readFile(assetPath, (err, data) => {
      if (err) {
        // SPA fallback, same as netlify.toml's status=200 rewrite — any /strategy/* path
        // that isn't a real built asset still serves the app shell.
        return fs.readFile(path.join(STRATEGY_DIST, "index.html"), (err2, indexData) => {
          if (err2) { res.statusCode = 404; return res.end("not found — did you run `npm run build`?"); }
          res.setHeader("Content-Type", "text/html");
          res.end(indexData);
        });
      }
      res.setHeader("Content-Type", MIME[path.extname(assetPath)] || "application/octet-stream");
      res.end(data);
    });
  }

  const full = path.join(HUB, p);
  if (!full.startsWith(HUB)) { res.statusCode = 403; return res.end("forbidden"); }
  fs.readFile(full, (err, data) => {
    if (err) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("Content-Type", MIME[path.extname(full)] || "application/octet-stream");
    res.end(data);
  });
}

// Auto-discovers every function file instead of a hand-maintained allowlist — a new
// netlify/functions/*.js file is picked up automatically, no separate list to remember to
// update (a real, recurring maintenance gap in this file's earlier ad-hoc version).
const FUNCTIONS_DIR = path.join(HUB, "netlify", "functions");
function knownFunctionNames() {
  return fs.readdirSync(FUNCTIONS_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.slice(0, -3));
}

async function handleFunction(name, req, res, queryStringParameters) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const modPath = path.join(FUNCTIONS_DIR, `${name}.js`);
      delete require.cache[require.resolve(modPath)];
      const mod = require(modPath);
      // This stand-in server is always plain http, unlike Netlify's real (always-https)
      // edge — siteBaseUrl() in strategy-run-start.js/strategy-stage-approve.js/
      // strategy-stage-retry.js/strategy-stage-reopen.js defaults to "https" when
      // x-forwarded-proto is absent (correct in real production), so any caller that
      // doesn't set this explicitly (browser-issued fetches from index.html, in
      // particular) would otherwise have its background-function trigger fetch try a TLS
      // handshake against this http server. Filling it in here, once, means every test —
      // Node scripts and Playwright alike — gets a working trigger chain without each one
      // needing to know this quirk.
      const headers = Object.assign({ "x-forwarded-proto": "http" }, req.headers);
      const event = { httpMethod: req.method, headers, body, queryStringParameters: queryStringParameters || {} };
      const result = await mod.handler(event);
      res.statusCode = result.statusCode || 200;
      Object.entries(result.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
      // Real Netlify Functions base64-decode the body for the client when
      // isBase64Encoded is set (strategy-deck-download.js's .pptx response) — replicate
      // that here instead of writing the raw base64 text straight to the response.
      res.end(result.isBase64Encoded ? Buffer.from(result.body || "", "base64") : (result.body || ""));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
  });
}

const server = http.createServer((req, res) => {
  const [p, queryString] = req.url.split("?");
  const fnMatch = p.match(/^\/\.netlify\/functions\/([a-z0-9-]+)$/);
  if (fnMatch && knownFunctionNames().includes(fnMatch[1])) {
    const queryStringParameters = Object.fromEntries(new URLSearchParams(queryString || ""));
    return handleFunction(fnMatch[1], req, res, queryStringParameters);
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.statusCode = 404;
  res.end("not found");
});

const PORT = process.env.DEV_LITE_PORT || 9020;
// Bind explicitly to 127.0.0.1 (see the FIREBASE_DB_URL comment above) rather than the OS
// default, which prefers the IPv6 wildcard when available.
server.listen(PORT, "127.0.0.1", () => console.log(`netlify-dev-lite listening on ${PORT}`));
