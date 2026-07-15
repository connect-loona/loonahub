// ============================================================================
// LOONA Hub · Culture Lottery — shared draw-generation engine
// ----------------------------------------------------------------------------
// Shared between culture-lottery-daily.js (scheduled batch, all profiles) and
// culture-lottery-generate.js (on-demand, single profile — lets anyone who's
// missing today's draw self-serve one immediately instead of waiting for the
// next scheduled run).
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

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in Claude's response");
  return JSON.parse(text.slice(start, end + 1));
}

// Summarizes the last 14 days of feedback into short signal lines for the
// prompt — real personalization input, not decoration.
function summarizeFeedback(feedbackByDate) {
  const dates = Object.keys(feedbackByDate || {}).sort().slice(-14);
  const loved = [], notForMe = [];
  dates.forEach((d) => {
    const day = feedbackByDate[d] || {};
    Object.keys(day).forEach((itemType) => {
      const f = day[itemType] || {};
      if (f.loved) loved.push(itemType);
      if (f.not_for_me) notForMe.push(itemType);
    });
  });
  return { loved, notForMe };
}

async function generateDrawFor(profile, feedbackByDate, apiKey) {
  const { loved, notForMe } = summarizeFeedback(feedbackByDate);
  const prompt = `You are the recommendation engine for "Culture Lottery" — a daily personalized book, movie, and one-word-theme draw for a creative agency team member.

Their profile:
- Interests: ${profile.interests.join(", ")}
- Difficulty preference: ${profile.difficulty} (beginner = accessible, explorer = classics + new discoveries, deepdive = challenging)
- Time commitment: ${profile.timeCommitment}
- Favorite creators/works: ${(profile.creators || []).join(", ") || "none specified"}
${loved.length ? `- Recently loved: ${loved.join(", ")}` : ""}
${notForMe.length ? `- Recently marked "not for me": ${notForMe.join(", ")} — steer away from whatever made these a miss` : ""}

Pick ONE real book, ONE real movie, and ONE single word/concept, all genuinely well-matched to this profile — not random, not generic Hollywood/bestseller picks unless that's truly what fits. Each needs a short original "why" (1 sentence, your own words) explaining the match, and a "category" tag that is ONE of exactly these interest tags: ${Object.values({
    Marketing: ['Branding', 'Advertising', 'Copywriting', 'Social Media', 'Performance Marketing', 'Consumer Psychology', 'PR', 'Strategy'],
    Design: ['Graphic Design', 'UI/UX', 'Product Design', 'Typography', 'Motion Design', 'Illustration', 'Packaging'],
    'Film & Storytelling': ['Cinema', 'Screenwriting', 'Documentaries', 'Animation', 'Photography', 'Directing', 'Editing'],
    Business: ['Entrepreneurship', 'Startups', 'Finance', 'Investing', 'Leadership', 'Negotiation', 'Sales'],
    Technology: ['AI', 'Programming', 'Product', 'Robotics', 'Future Tech'],
    Creativity: ['Architecture', 'Fashion', 'Music', 'Art', 'Writing', 'History', 'Philosophy', 'Psychology'],
    'Personal Growth': ['Productivity', 'Habits', 'Stoicism', 'Communication', 'Wellness']
  }).flat().join(", ")}.

Respond with ONLY valid JSON, no markdown fences, in this exact shape:
{"book": {"title": "...", "why": "...", "category": "..."}, "movie": {"title": "...", "why": "...", "category": "..."}, "word": {"term": "...", "meaning": "...", "category": "..."}}`;

  const resp = await req("POST", "https://api.anthropic.com/v1/messages", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  }, {
    model: "claude-sonnet-5",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }]
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error("Claude API " + resp.status + ": " + JSON.stringify(resp.body).slice(0, 500));
  }
  const text = (resp.body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return extractJson(text);
}

module.exports = { req, fbGet, fbPut, todayIST, extractJson, summarizeFeedback, generateDrawFor };
