// ============================================================================
// LOONA Hub · Loona Brain Check — daily winner (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Runs once daily at 12:00 IST (see netlify.toml) — the fixed cut-off after
// which today's Brain Check winner is locked in. Reads everyone's results for
// today (written client-side by bcSubmitResult() in index.html), picks the
// winner (highest score, fastest completion time breaks a tie), writes
// brainCheck/winner/<date> so every client's dashboard card + leaderboard
// switches from "current leader" to "today's winner", and posts one shared
// Loona Board announcement (rotated daily) with an action button that opens
// the Brain Check leaderboard (wired client-side in renderLoonaBoard).
//
// Manual run (for testing): GET /.netlify/functions/brain-check-winner
// ============================================================================

const https = require("https");
const { URL } = require("url");
const { sendPushBroadcast } = require("./lib/push-send");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

function req(method, urlStr, headers, bodyObj) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const data = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const h = Object.assign({ Accept: "application/json" }, headers || {});
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
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}

function daysSinceEpoch(dateStr) { return Math.floor(Date.parse(dateStr + "T00:00:00Z") / 86400000); }

// Mirrors the BC_WINNER_BROADCASTS rotation in index.html — kept in sync by
// hand since this function has no access to the client's JS module.
const WINNER_BROADCASTS = [
  (n, s) => ({ text: `Today's smartest Loonatic\n\n${n} scored ${s}/10.\n\nNo guesses. No mercy. No pretending.`, actionLabel: "See Everyone's Scores" }),
  (n, s) => ({ text: `We have a winner\n\n${n} completed today's Brain Check with ${s}/10.\n\nEveryone else may now quietly review their answers.`, actionLabel: "Open Leaderboard" }),
  (n, s) => ({ text: `Today's crown goes to ${n}\n\n10 questions. ${s} correct answers.\n\nThis level of competence was not requested.`, actionLabel: "View Results" }),
  (n, s) => ({ text: `The leaderboard has spoken\n\n${n} takes today's win with ${s}/10.\n\nPlease direct all unnecessary questions accordingly.`, actionLabel: "See Leaderboard" })
];

exports.handler = async () => {
  try {
    const date = todayIST();

    // Dedup — also guards a manual re-run/retry from double-deciding today.
    const existing = await fbGet("/brainCheck/winner/" + date);
    if (existing.body) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "winner already decided", date }) };

    const resultsResp = await fbGet("/brainCheck/results/" + date);
    const results = Object.values(resultsResp.body || {});
    if (!results.length) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "no attempts today", date }) };

    const ranked = results.slice().sort((a, b) => (b.score - a.score) || ((a.durationMs || Infinity) - (b.durationMs || Infinity)));
    const winner = ranked[0];
    const winnerDoc = { name: winner.name, score: winner.score, durationMs: winner.durationMs || 0, decidedAt: Date.now() };

    await fbPut("/brainCheck/winner/" + date, winnerDoc);

    const variant = WINNER_BROADCASTS[daysSinceEpoch(date) % WINNER_BROADCASTS.length](winner.name, winner.score);
    const post = {
      id: Date.now(),
      text: variant.text,
      author: "Loona Brain Check",
      emoji: "🧠",
      timestamp: new Date().toISOString(),
      action: "braincheck",
      actionLabel: variant.actionLabel
    };
    const posted = await fbPost("/announcements", post);
    await sendPushBroadcast(post).catch(() => {});

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, date, winner: winnerDoc, announced: posted.status >= 200 && posted.status < 300 })
    };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
