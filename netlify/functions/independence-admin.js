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
//     -> 200 { entries: [{ key, name, city, lat, lon, ts, date, from }] },
//        most recent first, capped at the last 500 hoists.
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

function fbGetQuery(path, query) {
  return new Promise((resolve) => {
    const u = new URL(FB + path + ".json?" + query);
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

  const raw = await fbGetQuery("/independenceHoists/log", 'orderBy="ts"&limitToLast=500');
  const entries = [];
  if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([key, entry]) => {
      if (!entry || typeof entry !== "object") return;
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

  return {
    statusCode: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  };
};
