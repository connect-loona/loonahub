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
// FIREBASE_ERROR_HANDLING: two rounds of this bug now. Round 1 queried
// orderBy="date"&equalTo=<today>, assumed wrong that "ts" was already a
// declared index on this path (since fetchDots() in independence-hoist.js
// had queried orderBy="ts" "successfully" all along) and switched to
// that instead. Turns out /independenceHoists/log has NEVER had ANY
// `.indexOn` rule declared — fetchDots()'s orderBy="ts" was being
// rejected by Firebase this entire time too, silently, via the exact
// same bug: Firebase's REST API error response for a missing index is
// still a 200 with a JSON body like {"error": "Index not defined..."},
// and neither function checked for that shape, so both iterated
// {error: "..."} as if it were hoist entries, found nothing
// object-shaped, and returned an empty list — indistinguishable from an
// actually-empty log (confirmed live: todayCount: 22, entries: 0), and
// the reason the map's own dots/marker had reportedly gone missing too.
// Fixed for good this time by not using orderBy/limitToLast/equalTo at
// all — a plain full-node GET needs no Firebase index whatsoever, with
// all filtering, sorting, and capping done in JS after the fetch. Kept
// the error-shape check too (now on the plain GET) so any future
// Firebase-side failure still surfaces as a real 502 instead of quietly
// looking like zero hoists.
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
// rejection on a query — shouldn't happen here now that nothing in this
// file uses orderBy/equalTo/limitToLast, but still checked in case a
// plain read is ever rejected for some other reason) or the request
// failed outright — callers must check `ok` rather than assuming a
// parsed JSON body means the read succeeded.
function fbGetChecked(path) {
  return new Promise((resolve) => {
    const u = new URL(FB + path + ".json");
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
  // Plain full-node read (see FIREBASE_ERROR_HANDLING above for why —
  // no orderBy/equalTo/limitToLast, so no Firebase index required at
  // all) — filtered down to today's date in JS below.
  const [logRes, todayCountRaw] = await Promise.all([
    fbGetChecked("/independenceHoists/log"),
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
