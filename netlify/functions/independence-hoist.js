// ============================================================================
// LOONA · Independence Day microsite — hoist counter (Netlify Function)
// ----------------------------------------------------------------------------
// Backs the public, no-login microsite at /independence/ (see
// independence/index.html). That page is deliberately vanilla — no Firebase
// SDK loaded client-side — so it talks to this one small endpoint instead:
//
//   GET  /.netlify/functions/independence-hoist
//     -> { count, allTimeCount } — today's (IST) hoist count so far, for the
//        "X flags hoisted today" line shown before anyone's even hoisted yet.
//
//   POST /.netlify/functions/independence-hoist   { from?: string }
//     -> { count, allTimeCount, rank } — records one more hoist, atomically
//        incrementing both today's (IST) and the all-time counters via
//        Firebase's server-side ".sv":{"increment"} value (a single PUT, no
//        read-modify-write race between concurrent hoisters), and echoes
//        back the post-increment daily count as `rank` — "you're the Nth
//        person today" is just that number.
//
// Same open-REST-call pattern (no auth token) as the rest of this repo's
// Netlify functions (see overdue-tasks-daily.js) — this project's Firebase
// rules already allow it project-wide, so no new access is being opened up
// here specifically for the public microsite.
//
// `from` (the referring hoister's slug, from ?from=<slug> on the share link)
// is logged to /independenceHoists/log for later curiosity/debugging — never
// trusted for anything security-sensitive, just a courtesy breadcrumb.
// ============================================================================

const https = require("https");
const { URL } = require("url");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

function req(method, urlStr, bodyObj) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const data = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const h = { Accept: "application/json" };
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let b; try { b = JSON.parse(buf); } catch (e) { b = { _raw: buf.slice(0, 300) }; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: String(e) } }));
    if (data) r.write(data);
    r.end();
  });
}
function fbGet(path) { return req("GET", FB + path + ".json", null); }
function fbPut(path, val) { return req("PUT", FB + path + ".json", val); }
function fbPost(path, val) { return req("POST", FB + path + ".json", val); }

function todayIST() {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const date = todayIST();

  if (event.httpMethod === "GET") {
    const [dayRes, allRes] = await Promise.all([
      fbGet("/independenceHoists/daily/" + date + "/count"),
      fbGet("/independenceHoists/allTimeCount"),
    ]);
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ count: dayRes.body || 0, allTimeCount: allRes.body || 0 }),
    };
  }

  if (event.httpMethod === "POST") {
    let from = null;
    try {
      const parsed = JSON.parse(event.body || "{}");
      if (parsed && typeof parsed.from === "string") from = parsed.from.slice(0, 60);
    } catch (e) { /* ignore malformed body, just don't log a referrer */ }

    const [dayRes, allRes] = await Promise.all([
      fbPut("/independenceHoists/daily/" + date + "/count", { ".sv": { increment: 1 } }),
      fbPut("/independenceHoists/allTimeCount", { ".sv": { increment: 1 } }),
    ]);
    // Best-effort log, doesn't block the response either way.
    fbPost("/independenceHoists/log", { date, from, ts: { ".sv": "timestamp" } });

    const count = typeof dayRes.body === "number" ? dayRes.body : 1;
    const allTimeCount = typeof allRes.body === "number" ? allRes.body : count;
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ count, allTimeCount, rank: count }),
    };
  }

  return { statusCode: 405, headers: CORS, body: "Method not allowed" };
};
