// A plain in-memory JSON store standing in for Firebase Realtime Database's REST API
// (GET/PUT/PATCH/POST at <path>.json) — used only by this repo's own test suite so tests
// need no network access and no real Firebase project.
//
// Known gap (by design, not a bug to fix here): unlike real Firebase, this store does NOT
// drop empty-array values on write — real Firebase silently removes an object key whose
// value is `[]`, which is exactly the bug tests/strategy/firebase-empty-array-drop.test.js
// exists to guard against. That test deliberately simulates the drop by stripping the keys
// itself after writing, rather than relying on this stand-in to reproduce it naturally.
"use strict";
const http = require("http");

let store = {};

function getAtPath(p) {
  const parts = p.split("/").filter(Boolean);
  let cur = store;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[part];
  }
  return cur === undefined ? null : cur;
}
function setAtPath(p, val) {
  const parts = p.split("/").filter(Boolean);
  let cur = store;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cur[part] !== "object" || cur[part] === null) cur[part] = {};
    cur = cur[part];
  }
  const last = parts[parts.length - 1];
  if (val === null || val === undefined) delete cur[last];
  else cur[last] = val;
}
function mergeAtPath(p, patch) {
  const cur = getAtPath(p) || {};
  const merged = Object.assign({}, typeof cur === "object" ? cur : {}, patch);
  setAtPath(p, merged);
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, PATCH, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://localhost");
    const p = u.pathname.replace(/\.json$/, "");
    let payload = null;
    if (body) { try { payload = JSON.parse(body); } catch { payload = null; } }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify(getAtPath(p)));
    } else if (req.method === "PUT") {
      setAtPath(p, payload);
      res.end(JSON.stringify(payload));
    } else if (req.method === "PATCH") {
      mergeAtPath(p, payload);
      res.end(JSON.stringify(payload));
    } else if (req.method === "POST") {
      const key = "k" + Math.random().toString(36).slice(2);
      setAtPath(p + "/" + key, payload);
      res.end(JSON.stringify({ name: key }));
    } else {
      res.statusCode = 405;
      res.end("{}");
    }
  });
});

const PORT = process.env.FAKE_RTDB_PORT || 9030;
server.listen(PORT, () => {
  console.log(`fake RTDB listening on ${PORT}`);
});
