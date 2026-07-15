// ============================================================================
// LOONA Hub · Culture Lottery — weekly taste evolution (Netlify Scheduled
// Function)
// ----------------------------------------------------------------------------
// Runs every Sunday (see netlify.toml). For each onboarded profile, compares
// this week's positive engagement (loved + saved) per interest category
// against the previous week's, and stores the real percentage movers under
// cultureLottery/tasteHistory/{member}/{weekStart}. The Loonaverse client
// reads this to render "Your taste evolved this week."
//
// Manual run (for testing): GET /.netlify/functions/culture-lottery-weekly
// ============================================================================

const https = require("https");
const { URL } = require("url");

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

function todayIST() {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}

function daysAgoIST(dateStr, n) {
  return new Date(Date.parse(dateStr + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10);
}

// Positive-engagement counts per category across a [start, end) date window,
// using each day's draw to know which category each item belonged to.
function countByCategory(drawsByDate, feedbackByDate, startDate, endDate) {
  const counts = {};
  Object.keys(drawsByDate || {}).forEach((date) => {
    if (date < startDate || date >= endDate) return;
    const draw = drawsByDate[date] || {};
    const dayFeedback = (feedbackByDate || {})[date] || {};
    ["book", "movie", "word"].forEach((itemType) => {
      const item = draw[itemType];
      const fb = dayFeedback[itemType];
      if (!item || !item.category || !fb) return;
      if (fb.loved || fb.saved) counts[item.category] = (counts[item.category] || 0) + 1;
    });
  });
  return counts;
}

function computeMovers(thisWeek, lastWeek) {
  const categories = new Set([...Object.keys(thisWeek), ...Object.keys(lastWeek)]);
  const movers = [];
  categories.forEach((cat) => {
    const cur = thisWeek[cat] || 0;
    const prev = lastWeek[cat] || 0;
    if (prev === 0 && cur === 0) return;
    const delta = prev === 0 ? 100 : Math.round(((cur - prev) / prev) * 100);
    if (delta !== 0) movers.push({ category: cat, delta });
  });
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return movers.slice(0, 4);
}

exports.handler = async () => {
  try {
    const date = todayIST();
    const weekStart = daysAgoIST(date, 7);
    const twoWeeksStart = daysAgoIST(date, 14);

    const claim = await fbGet("/culture_lottery_weekly_created/" + weekStart);
    if (claim.body) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "already generated", weekStart }) };
    await fbPut("/culture_lottery_weekly_created/" + weekStart, true);

    const [profilesResp, drawsResp, feedbackResp] = await Promise.all([
      fbGet("/cultureLottery/profiles"),
      fbGet("/cultureLottery/draws"),
      fbGet("/cultureLottery/feedback")
    ]);
    const profiles = profilesResp.body || {};
    const allDraws = drawsResp.body || {};
    const allFeedback = feedbackResp.body || {};

    const memberKeys = Object.keys(profiles).filter((k) => profiles[k] && profiles[k].onboarded);
    let written = 0;

    for (const key of memberKeys) {
      const thisWeek = countByCategory(allDraws[key], allFeedback[key], weekStart, date);
      const lastWeek = countByCategory(allDraws[key], allFeedback[key], twoWeeksStart, weekStart);
      const movers = computeMovers(thisWeek, lastWeek);
      if (!movers.length) continue;

      const up = movers.filter((m) => m.delta > 0);
      const summary = up.length
        ? `You leaned more towards ${up[0].category}${up[1] ? " and " + up[1].category : ""} this week.`
        : "Your engagement shifted this week.";

      await fbPut("/cultureLottery/tasteHistory/" + key + "/" + weekStart, { movers, summary, generatedAt: new Date().toISOString() });
      written++;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, weekStart, profiles: memberKeys.length, written })
    };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
