// ============================================================================
// LOONA · Independence Day microsite — internal participant list (Netlify Function)
// ----------------------------------------------------------------------------
// Backs the password-gated admin view at /independence/admin/ (see that
// page). NOT part of the public, no-login microsite despite living under
// /independence/ — that whole subpath is deliberately excluded from the
// site's shared BASIC_AUTH_CREDENTIALS edge gate (see
// netlify/edge-functions/basic-auth.ts) so the public hoist flow never
// hits a login wall, and that exclusion covers this admin page too. So
// this function does its own password check instead of relying on that
// gate — see PASSWORD below.
//
//   GET /.netlify/functions/independence-admin
//     Header: X-Admin-Password: <password>
//     -> 401 {error} if it doesn't match INDEPENDENCE_ADMIN_PASSWORD (or
//        that env var was never set — fails closed, not open).
//     -> 200 { entries, todayCount, truncated }
//        entries: [{ key, name, city, lat, lon, ts, date, from }] for
//        TODAY only, most recent first.
//        todayCount: today's real total from the same daily counter the
//        public "X flags hoisted today" line uses — fetched
//        independently of the entries query below as a cross-check (see
//        `truncated`), not derived from entries.length.
//        truncated: true if entries came back short of todayCount.
//     -> 502 {error, firebaseError} if the Firebase read itself failed
//        (distinct from "no entries yet" — see FIREBASE_ERROR_HANDLING).
//
// FIREBASE_ERROR_HANDLING: an earlier version queried Firebase directly
// with orderBy="date"&equalTo=<today> to avoid an arbitrary count cap —
// but this path already has an index declared on "ts" (fetchDots() in
// independence-hoist.js has queried orderBy="ts" successfully all
// along), and once ANY index is declared on a path, Firebase's REST API
// rejects queries ordered by a field that ISN'T one of the declared
// indexes, with an error response — it does NOT just fall back to an
// unindexed scan. That error response is still a 200 with a JSON body
// like {"error": "Index not defined..."}, and the old code never checked
// res.statusCode or looked for that shape, so it silently iterated an
// {error: "..."} object as if it were hoist entries, found nothing
// object-shaped, and returned an empty list with no indication anything
// had gone wrong — exactly what showed up live (todayCount: 22,
// entries: 0). Fixed two ways: (1) back to orderBy="ts" (the field
// that's actually indexed), filtering by `date` in JS afterward instead
// of in the query itself — still scales to one day's real turnout, no
// arbitrary cap, just done after the fetch instead of by Firebase; (2)
// fbGetQuery now recognizes a Firebase error-shaped response and the
// handler returns a real 502 instead of quietly treating it as "zero
// hoists today", so this class of bug fails loudly next time instead of
// looking identical to an empty log.
//
// name/city/lat/lon here are exactly what independence-hoist.js already
// writes to /independenceHoists/log for every hoist (name arrives
// separately, see that file's "setName" action) — this function only
// reads, no new data collection of its own.
// ============================================================================

const https = require("https");
const { URL } = require("url");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");
const PASSWORD = process.env.INDEPENDENCE_ADMIN_PASSWORD;

function todayIST() {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}

// Resolves to { ok: true, data } normally, or { ok: false, error } if
// Firebase itself returned an error-shaped body (e.g. a missing-index
// rejection) or the request failed outright — callers must check `ok`
// rather than assuming a parsed JSON body means the read succeeded.
function fbGetQuery(path, query) {
  return new Promise((resolve) => {
    const u = new URL(FB + path + ".json?" + query);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Accept: "application/json" } }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let b; try { b = JSON.parse(buf); } catch (e) { resolve({ ok: false, error: "Non-JSON response: " + buf.slice(0, 200) }); return; }
        if (b && typeof b === "object" && typeof b.error === "string") { resolve({ ok: false, error: b.error }); return; }
        resolve({ ok: true, data: b });
      });
    }).on("error", (e) => resolve({ ok: false, error: String(e) }));
  });
}
function fbGet(path) {
  return new Promise((resolve) => {
    const u = new URL(FB + path + ".json");
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Accept: "application/json" } }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let b; try { b = JSON.parse(buf); } catch (e) { b = null; } resolve(b); });
    }).on("error", () => resolve(null));
  });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: CORS, body: "Method not allowed" };

  const supplied = (event.headers && (event.headers["x-admin-password"] || event.headers["X-Admin-Password"])) || "";
  // Fails closed: an unset env var rejects every password (including an
  // empty one) rather than the page silently having no protection.
  if (!PASSWORD || supplied !== PASSWORD) {
    return { statusCode: 401, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Wrong password" }) };
  }

  const today = todayIST();
  // orderBy="ts" — the field this path actually has an index on (see
  // FIREBASE_ERROR_HANDLING above) — then filtered down to today's date
  // in JS below. limitToLast is still generous rather than tight, as a
  // ceiling against pulling in old days' entries too, not because
  // there's any realistic risk of today alone exceeding it.
  const [logRes, todayCountRaw] = await Promise.all([
    fbGetQuery("/independenceHoists/log", 'orderBy="ts"&limitToLast=5000'),
    fbGet("/independenceHoists/daily/" + today + "/count"),
  ]);
  const todayCount = typeof todayCountRaw === "number" ? todayCountRaw : 0;

  if (!logRes.ok) {
    return {
      statusCode: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Firebase read failed", firebaseError: logRes.error }),
    };
  }

  const entries = [];
  const raw = logRes.data;
  if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([key, entry]) => {
      if (!entry || typeof entry !== "object" || entry.date !== today) return;
      entries.push({
        key,
        name: typeof entry.name === "string" ? entry.name : null,
        city: typeof entry.city === "string" ? entry.city : null,
        lat: typeof entry.lat === "number" ? entry.lat : null,
        lon: typeof entry.lon === "number" ? entry.lon : null,
        ts: typeof entry.ts === "number" ? entry.ts : null,
        date: typeof entry.date === "string" ? entry.date : null,
        from: typeof entry.from === "string" ? entry.from : null,
      });
    });
  }
  entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const truncated = entries.length < todayCount;

  return {
    statusCode: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify({ entries, todayCount, truncated }),
  };
};
