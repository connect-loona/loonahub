// ============================================================================
// LOONA Hub · Daily Oracle + Co-Star broadcast (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Runs once daily at 10:00 IST (see netlify.toml) and posts two Loona Board
// announcements, visible to the whole team:
//   1. A nudge to check today's Loona Oracle card
//   2. A nudge to find today's Co-Star
// Each carries an action button (wired client-side in renderLoonaBoard, see
// index.html) that opens openLoonaOracle()/openCostarModal() for whoever
// clicks it — those already pick a different card/match per person per day
// (tarotForToday/workBuddyForToday), so this is one shared post, not one per
// person; only the reveal itself is personal.
//
// Manual run (for testing): GET /.netlify/functions/loona-daily-broadcast
// ============================================================================

const https = require("https");
const { URL } = require("url");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

function req(method, urlStr, headers, bodyObj) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const data = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const h = Object.assign({ "Accept": "application/json" }, headers || {});
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

function fbGet(path) { return req("GET", FB + path + ".json", null, null); }
function fbPut(path, val) { return req("PUT", FB + path + ".json", null, val); }
function fbPost(path, val) { return req("POST", FB + path + ".json", null, val); }

function todayIST() {
  // IST = UTC+5:30
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}

exports.handler = async () => {
  try {
    const date = todayIST();

    // Dedup ledger — also guards a manual re-run/retry from double-posting today.
    const claim = await fbGet("/loona_daily_broadcast_created/" + date);
    if (claim.body) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "already posted", date }) };
    await fbPut("/loona_daily_broadcast_created/" + date, true);

    const base = Date.now();
    const posts = [
      {
        id: base,
        text: "Have you checked your Loona Oracle today?\n\nToday's card is waiting.\nIt might call you out… or call you in.",
        author: "Loona Oracle",
        emoji: "🔮",
        timestamp: new Date().toISOString(),
        action: "oracle",
        actionLabel: "Read Today's Oracle"
      },
      {
        id: base + 1,
        text: "Every orbit has another moon.\n\nFind the person who matches your energy today.",
        author: "Find Your Co-Star",
        emoji: "🎬",
        timestamp: new Date().toISOString(),
        action: "costar",
        actionLabel: "Find Your Co-Star"
      }
    ];
    const results = await Promise.all(posts.map((p) => fbPost("/announcements", p)));
    const failed = results.filter((r) => r.status < 200 || r.status >= 300).length;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, date, posted: posts.length - failed, failed })
    };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
