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
const { pathToFileURL } = require("url");
const HUB = path.join(__dirname, "..", "..");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css" };

// Mirrors netlify.toml's own /strategy/* redirect: that path is served from the built
// apps/strategy output at dist/strategy/, not the repo root like everything else here —
// so tests exercise the exact same routing shape production actually has, build step
// included (run `npm run build` before pointing a test at this server's /strategy/ path).
const STRATEGY_DIST = path.join(HUB, "dist", "strategy");
// Visual Studio is served the same way, from its own build at dist/visual/ — see
// netlify.toml's matching /visual/* rewrite.
const VISUAL_DIST = path.join(HUB, "dist", "visual");

// Both apps route identically (a built SPA behind a status=200 rewrite), so the handling is
// shared rather than duplicated per app.
function serveApp(distRoot, prefix, p, res) {
  const rel = p === prefix ? "/index.html" : p.slice(prefix.length) || "/index.html";
  const assetPath = path.join(distRoot, rel);
  if (!assetPath.startsWith(distRoot)) { res.statusCode = 403; return res.end("forbidden"); }
  return fs.readFile(assetPath, (err, data) => {
    if (err) {
      // SPA fallback, same as netlify.toml's status=200 rewrite — any path under the app
      // that isn't a real built asset still serves the app shell.
      return fs.readFile(path.join(distRoot, "index.html"), (err2, indexData) => {
        if (err2) { res.statusCode = 404; return res.end("not found — did you run `npm run build`?"); }
        res.setHeader("Content-Type", "text/html");
        res.end(indexData);
      });
    }
    res.setHeader("Content-Type", MIME[path.extname(assetPath)] || "application/octet-stream");
    res.end(data);
  });
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";

  if (p === "/visual" || p.startsWith("/visual/")) return serveApp(VISUAL_DIST, "/visual", p, res);

  if (p === "/strategy" || p.startsWith("/strategy/")) {
    const rel = p === "/strategy" ? "/index.html" : p.slice("/strategy".length) || "/index.html";
    const assetPath = path.join(STRATEGY_DIST, rel);
    if (!assetPath.startsWith(STRATEGY_DIST)) { res.statusCode = 403; return res.end("forbidden"); }
    return fs.readFile(assetPath, (err, data) => {
      if (err) {
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

// Both function generations live in this directory and neither can be ignored.
//
// The classic ones are CommonJS .js exporting `handler(event)`. The newer ones are .mjs
// exporting a default `(Request) => Response` — that is how visual-asset and
// visual-reference-upload are written, and until this understood .mjs they could not be
// exercised by any test at all, locally or in CI. Two endpoints serving client images, with no
// coverage, because the harness could not load the file extension.
function knownFunctionNames() {
  const names = new Set();
  for (const file of fs.readdirSync(FUNCTIONS_DIR)) {
    if (file.endsWith(".mjs")) names.add(file.slice(0, -4));
    else if (file.endsWith(".js")) names.add(file.slice(0, -3));
  }
  return [...names];
}

function functionFile(name) {
  const mjs = path.join(FUNCTIONS_DIR, `${name}.mjs`);
  if (fs.existsSync(mjs)) return { file: mjs, esm: true };
  const js = path.join(FUNCTIONS_DIR, `${name}.js`);
  if (fs.existsSync(js)) return { file: js, esm: false };
  return null;
}

// Netlify answers a background function with 202 and an empty body straight away, then runs it
// out of band. Awaiting it here instead would make every browser test see a generation as
// instant and synchronous — which is exactly the production behaviour the job queue exists to
// avoid, so the tests would be proving the opposite of what ships.
function isBackground(name) {
  return name.endsWith("-background");
}

// Background work currently in flight.
//
// Answering 202 and working afterwards is the right simulation — it is what Netlify does, and
// it is the only way a test can observe a job while it is still queued or running. But the
// Strategy OS tests were all written against a harness that finished the work before replying,
// so for them "the response arrived" meant "the stage has run".
//
// Rather than sprinkle polling through five existing test files, the harness tracks what is
// still running and offers a way to wait for quiet. Node-based tests drain it after each call
// (see shared.js's req) and keep their old, simpler shape; the browser never drains, so the
// Visual Studio job tests see the genuinely asynchronous behaviour that ships.
const inFlight = new Set();

function trackBackground(promise) {
  inFlight.add(promise);
  promise.finally(() => inFlight.delete(promise));
}

async function waitForBackgroundIdle(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, 50))]);
  }
  return inFlight.size === 0;
}

// A modern (.mjs) function receives a real Web Request. Keep the body as a Buffer throughout:
// reference upload posts raw image bytes, and round-tripping those through a string corrupts
// the image before its signature validation can even run.
function webRequestFor(req, rawBody) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const url = `${proto}://${req.headers.host || "127.0.0.1"}${req.url}`;
  const headers = new Headers();
  // Same reason as the legacy branch in handleFunction below: this stand-in is plain http,
  // but siteBaseUrl() in strategy-stage-approve / strategy-stage-retry /
  // strategy-concept-propose / strategy-concept-discard defaults to "https" when this header
  // is missing — correct on Netlify's always-https edge, fatal here, because the background
  // trigger fetch would then attempt a TLS handshake against an http server and the stage
  // would simply never start. Fill it in for every function the browser reaches, whichever
  // generation it is written in.
  headers.set("x-forwarded-proto", "http");
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, String(value));
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && rawBody.length > 0;
  return new Request(url, { method: req.method, headers, body: hasBody ? rawBody : undefined });
}

async function invokeEsmFunction(file, name, req, rawBody) {
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
  const handler = mod.default;
  if (typeof handler !== "function") throw new Error(`${name}.mjs has no default export to call.`);
  return handler(webRequestFor(req, rawBody), { requestId: `local-${Date.now()}` });
}

async function handleEsmFunction(file, name, req, res, rawBody) {
  const response = await invokeEsmFunction(file, name, req, rawBody);
  if (!(response instanceof Response)) throw new Error(`${name}.mjs did not return a Response.`);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  // arrayBuffer() rather than text(): these responses carry image bytes, and round-tripping
  // them through a string is how a valid PNG becomes a broken one.
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

async function handleFunction(name, req, res, queryStringParameters) {
  const chunks = [];
  req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks);
    const body = rawBody.toString("utf8");
    const target = functionFile(name);
    // Answer first, work after — the same order Netlify uses, so a test can observe a job
    // while it is still queued or running rather than only after it has finished.
    if (target && isBackground(name)) {
      res.statusCode = 202;
      res.end("");
      const headers = Object.assign({ "x-forwarded-proto": "http" }, req.headers);
      let backgroundWork;
      if (target.esm) {
        backgroundWork = invokeEsmFunction(target.file, name, req, rawBody);
      } else {
        const mod = require(target.file);
        backgroundWork = mod.handler({
          httpMethod: req.method,
          headers,
          body,
          queryStringParameters: queryStringParameters || {},
        });
      }
      trackBackground(Promise.resolve(backgroundWork).catch((e) => {
        console.error(`[dev-lite] background ${name} failed:`, e && e.stack ? e.stack : e);
      }));
      return;
    }
    try {
      if (!target) throw new Error(`No function file for "${name}".`);
      if (target.esm) {
        await handleEsmFunction(target.file, name, req, res, rawBody);
        return;
      }
      const modPath = target.file;
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
  // Test-harness only, and never part of the deployed site: block until no background function
  // is still running. See trackBackground above for why this exists.
  if (p === "/__dev/background-idle") {
    return waitForBackgroundIdle().then((idle) => {
      res.statusCode = idle ? 200 : 504;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ idle, running: inFlight.size }));
    });
  }
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
