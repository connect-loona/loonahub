// ============================================================================
// LOONA · Independence Day microsite — hoist counter (Netlify Function)
// ----------------------------------------------------------------------------
// Backs the public, no-login microsite at /independence/ (see
// independence/index.html). That page is deliberately vanilla — no Firebase
// SDK loaded client-side — so it talks to this one small endpoint instead:
//
//   GET  /.netlify/functions/independence-hoist
//     -> { count, allTimeCount, dots } — today's (IST) hoist count so far,
//        for the "X flags hoisted today" line shown before anyone's even
//        hoisted yet, plus a capped set of recent hoist locations (see
//        `dots` below) so the map has something to show even for a visitor
//        who hasn't hoisted yet themselves.
//
//   POST /.netlify/functions/independence-hoist   { from?: string }
//     -> { count, allTimeCount, rank, dot, dots } — records one more hoist,
//        atomically incrementing both today's (IST) and the all-time
//        counters via Firebase's server-side ".sv":{"increment"} value (a
//        single PUT, no read-modify-write race between concurrent
//        hoisters), and echoes back the post-increment daily count as
//        `rank` — "you're the Nth person today" is just that number.
//
// Same open-REST-call pattern (no auth token) as the rest of this repo's
// Netlify functions (see overdue-tasks-daily.js) — this project's Firebase
// rules already allow it project-wide, so no new access is being opened up
// here specifically for the public microsite.
//
// `from` (the referring hoister's slug, from ?from=<slug> on the share link)
// is logged to /independenceHoists/log for later curiosity/debugging — never
// trusted for anything security-sensitive, just a courtesy breadcrumb.
//
// Location for the map ("dot", "dots") comes from Netlify's IP-based geo —
// the `x-nf-geo` request header, base64-encoded JSON populated by Netlify's
// CDN at the edge — NOT the browser's GPS/precise-location permission. This
// is deliberate: city-level accuracy is plenty for a dot on a country-scale
// map, and it means no permission prompt ever interrupts the hoist. A
// visitor whose request doesn't carry that header (some proxies/VPNs strip
// it) just doesn't get a dot — the hoist still counts normally either way.
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
function fbGetQuery(path, query) { return req("GET", FB + path + ".json?" + query, null); }
function fbPut(path, val) { return req("PUT", FB + path + ".json", val); }
function fbPost(path, val) { return req("POST", FB + path + ".json", val); }

function todayIST() {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}

// India's real geographic extent (mainland + islands) — matches the exact
// calibration independence/index.html's projectToMapXY() uses for the
// india-map.svg asset, so anything accepted here actually lands ON the
// drawn map instead of floating off one of its edges.
const IN_BOUNDS = { latMin: 6.5, latMax: 37.6, lonMin: 68.0, lonMax: 97.4 };

function getGeo(event) {
  try {
    const raw = event.headers && (event.headers["x-nf-geo"] || event.headers["X-Nf-Geo"]);
    if (!raw) return null;
    const g = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const lat = g.latitude, lon = g.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    if (lat < IN_BOUNDS.latMin || lat > IN_BOUNDS.latMax || lon < IN_BOUNDS.lonMin || lon > IN_BOUNDS.lonMax) return null;
    // city is shown next to the hoister's own marker on the map (see
    // renderMap() in independence/index.html) — best-effort, city can be
    // missing from the geo lookup even when lat/lon are present.
    const city = typeof g.city === "string" && g.city ? g.city.slice(0, 40) : null;
    return { lat, lon, city };
  } catch (e) { return null; }
}

// Pulls the most recent hoists that carried a location and hands back a
// plain [{lat,lon}] list for the map — capped at 250 so this stays cheap
// and the map doesn't get overcrowded with dots.
async function fetchDots() {
  const res = await fbGetQuery("/independenceHoists/log", 'orderBy="ts"&limitToLast=250');
  const dots = [];
  if (res.body && typeof res.body === "object") {
    Object.values(res.body).forEach((entry) => {
      if (entry && typeof entry.lat === "number" && typeof entry.lon === "number") {
        dots.push({ lat: entry.lat, lon: entry.lon });
      }
    });
  }
  return dots;
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
    const [dayRes, allRes, dots] = await Promise.all([
      fbGet("/independenceHoists/daily/" + date + "/count"),
      fbGet("/independenceHoists/allTimeCount"),
      fetchDots(),
    ]);
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ count: dayRes.body || 0, allTimeCount: allRes.body || 0, dots }),
    };
  }

  if (event.httpMethod === "POST") {
    let from = null;
    try {
      const parsed = JSON.parse(event.body || "{}");
      if (parsed && typeof parsed.from === "string") from = parsed.from.slice(0, 60);
    } catch (e) { /* ignore malformed body, just don't log a referrer */ }

    const geo = getGeo(event);

    const [dayRes, allRes] = await Promise.all([
      fbPut("/independenceHoists/daily/" + date + "/count", { ".sv": { increment: 1 } }),
      fbPut("/independenceHoists/allTimeCount", { ".sv": { increment: 1 } }),
    ]);
    // Best-effort log, doesn't block the response either way. lat/lon are
    // simply omitted (JSON.stringify drops undefined values) when geo
    // lookup failed or fell outside India's bounding box.
    fbPost("/independenceHoists/log", {
      date, from, ts: { ".sv": "timestamp" },
      lat: geo ? geo.lat : undefined,
      lon: geo ? geo.lon : undefined,
    });

    const count = typeof dayRes.body === "number" ? dayRes.body : 1;
    const allTimeCount = typeof allRes.body === "number" ? allRes.body : count;
    // Recent dots for the map, refreshed to include this very hoist —
    // one extra query on the write path, but this endpoint is nowhere
    // near hot enough for that to matter.
    const dots = await fetchDots();
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ count, allTimeCount, rank: count, dot: geo, dots }),
    };
  }

  return { statusCode: 405, headers: CORS, body: "Method not allowed" };
};
