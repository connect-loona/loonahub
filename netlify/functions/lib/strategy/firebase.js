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

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

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
    if (data) r.write(data);
    r.end();
  });
}

function pathUrl(path) {
  return `${FB}/${path.replace(/^\/+/, "")}.json`;
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
