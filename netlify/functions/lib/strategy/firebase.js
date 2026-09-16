// Plain REST access to the same Firebase Realtime Database every other Netlify Function
// in this repo uses (see petpooja-sync.js's req() for the original pattern) — no
// firebase-admin, no service-account credential, just unauthenticated PUT/PATCH/GET
// against <databaseURL>/<path>.json, matching how the rest of Hub already writes to
// Firebase from server-side functions. Strategy OS data lives under its own top-level
// keys (strategy_brands, strategy_months, strategy_learnings, strategy_runs,
// strategy_activity) so it never collides with the app's existing collections.
"use strict";
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { authedUrl } = require("../firebase-auth");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

// A socket that never gets a response otherwise hangs forever — Node sets no default
// timeout — and every endpoint built on this file calls fbGet/fbSet synchronously before
// it can answer at all. Left unbounded, a single slow or stuck connection to Firebase
// stalls the request until the platform's own hard timeout kills it, which reaches the
// person as a raw, bodyless error rather than anything this file's own callers ever get a
// chance to turn into a real message (see strategy-run-start.js and its "Request failed."
// fallback in the frontend's api.ts — that text is exactly what a platform timeout with no
// JSON body produces). Bounding it here means a hung connection fails fast, as a normal
// rejected Error every caller already knows how to handle.
const REQUEST_TIMEOUT_MS = 10000;

function req(method, urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const headers = { Accept: "application/json" };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    // Real Firebase is always https; a local fake RTDB used for testing (see
    // scratchpad/fake-rtdb-server.js) is plain http — pick the transport by the URL's own
    // protocol instead of hard-coding https, so FIREBASE_DB_URL can point at either.
    const transport = u.protocol === "http:" ? http : https;
    const r = transport.request({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let body;
        try { body = JSON.parse(buf); } catch (e) { body = { _raw: buf.slice(0, 300) }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`Firebase ${method} ${u.pathname} failed: ${res.statusCode} ${JSON.stringify(body).slice(0, 300)}`));
      });
    });
    r.on("error", reject);
    r.setTimeout(REQUEST_TIMEOUT_MS, () => r.destroy(new Error(`Firebase ${method} ${u.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms.`)));
    if (data) r.write(data);
    r.end();
  });
}

function pathUrl(path) {
  // authedUrl attaches the database credential when one is configured, and is a no-op
  // otherwise — see lib/firebase-auth.js for why the database could not be locked down until
  // the functions were able to identify themselves.
  return authedUrl(`${FB}/${path.replace(/^\/+/, "")}.json`);
}

async function fbGet(path) {
  const value = await req("GET", pathUrl(path));
  return value === null ? null : value;
}

async function fbSet(path, value) {
  return req("PUT", pathUrl(path), value === undefined ? null : value);
}

async function fbUpdate(path, patch) {
  return req("PATCH", pathUrl(path), patch);
}

async function fbPush(path, value) {
  const result = await req("POST", pathUrl(path), value);
  return result && result.name;
}

// Firebase RTDB keys can't contain ".", "#", "$", "[", "]", "/" — same restriction the
// rest of Hub already works around (see fbSafeKey() in index.html) for brand/member names
// used as keys.
function fbSafeKey(raw) {
  return String(raw).replace(/[.#$[\]/]/g, "_");
}

module.exports = { fbGet, fbSet, fbUpdate, fbPush, fbSafeKey, FB };
