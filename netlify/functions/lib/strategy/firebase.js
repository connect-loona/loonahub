// Authenticated REST access for Strategy OS. Real Firebase traffic is signed with a
// service account; only the local HTTP test database is allowed to run without one.
"use strict";
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

let cachedAccessToken = "";
let cachedAccessTokenUntil = 0;

function serviceAccount() {
  const raw = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) throw new Error("client_email/private_key missing");
    return parsed;
  } catch (error) {
    throw new Error(`FIREBASE_ADMIN_SERVICE_ACCOUNT is malformed: ${error.message}`);
  }
}

async function firebaseAuthorizationHeader() {
  const account = serviceAccount();
  const isLocalTestDatabase = new URL(FB).protocol === "http:";
  if (!account) {
    if (isLocalTestDatabase) return null;
    throw new Error("Authenticated Firebase access requires FIREBASE_ADMIN_SERVICE_ACCOUNT.");
  }
  if (cachedAccessToken && Date.now() < cachedAccessTokenUntil) return `Bearer ${cachedAccessToken}`;
  const base64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(account.private_key);
  const assertion = `${signingInput}.${base64url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("Firebase service-account authentication failed.");
  cachedAccessToken = data.access_token;
  cachedAccessTokenUntil = Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000;
  return `Bearer ${cachedAccessToken}`;
}

async function req(method, urlStr, bodyObj) {
  const authorization = await firebaseAuthorizationHeader();
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const headers = { Accept: "application/json" };
    if (authorization) headers.Authorization = authorization;
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
