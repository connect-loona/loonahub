// ============================================================================
// LOONA Hub · Marketing News in 60 Seconds (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Runs once daily (see netlify.toml), asks Claude to search the web and
// summarize 5 real, current marketing/advertising/branding stories in its own
// words (not copied verbatim), and stores the result at marketingNews/<date>
// in Firebase. The Loonaverse page's "Marketing News" card (index.html)
// reads that node directly — no client-side AI call involved.
//
// Manual run (for testing): GET /.netlify/functions/marketing-news-daily
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

// Pulls the JSON array out of Claude's response text blocks. With the
// web_search tool enabled, content also includes server_tool_use /
// web_search_tool_result blocks interspersed — only the text blocks matter here.
function extractJsonArray(content) {
  const text = (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON array found in Claude's response");
  return JSON.parse(text.slice(start, end + 1));
}

exports.handler = async () => {
  try {
    const date = todayIST();

    const claim = await fbGet("/marketing_news_created/" + date);
    if (claim.body) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "already generated", date }) };

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ success: false, message: "CLAUDE_API_KEY not set" }) };

    await fbPut("/marketing_news_created/" + date, true);

    const prompt = `Search the web for what's genuinely happening in marketing, advertising, and branding today. Pick the 5 most notable, real, current stories (campaigns, platform changes, industry moves, notable creative work) — nothing older than the last couple of days.

For each one, write an ORIGINAL 1-2 sentence summary in your own words (never copy sentences from the source), plus the publication/source name and a URL.

Respond with ONLY a valid JSON array, no markdown fences, no other text, in this exact shape:
[{"title": "short headline", "blurb": "1-2 sentence original summary", "source": "Publication Name", "url": "https://..."}]`;

    const resp = await req("POST", "https://api.anthropic.com/v1/messages", {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }, {
      model: "claude-sonnet-5",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: prompt }]
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error("Claude API " + resp.status + ": " + JSON.stringify(resp.body).slice(0, 500));
    }

    const items = extractJsonArray(resp.body.content).slice(0, 5);
    await fbPut("/marketingNews/" + date, { items, generatedAt: new Date().toISOString() });

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, date, items: items.length }) };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
