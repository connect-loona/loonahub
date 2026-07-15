// ============================================================================
// LOONA Hub · Marketing News in 60 Seconds (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Runs once daily (see netlify.toml), asks Claude to search the web and
// assemble a 5-story daily briefing spanning marketing, branding, social
// media, AI, business, fashion, art, design, and culture — not just ad
// industry news. Stores the result at marketingNews/<date> in Firebase. The
// Loonaverse page's "Marketing News" card (index.html) reads that node
// directly — no client-side AI call involved. Personalization (interest-based
// reordering) happens entirely client-side against this same shared list, so
// everyone still gets the same 5 stories as common cultural reference points.
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

// Must match NEWS_CATEGORIES in index.html exactly (key values, not labels).
const NEWS_CATEGORY_KEYS = ["fashion", "art", "design", "photography", "film", "branding", "social", "ai", "performance", "business", "culture", "copywriting"];

exports.handler = async () => {
  try {
    const date = todayIST();

    const claim = await fbGet("/marketing_news_created/" + date);
    if (claim.body) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "already generated", date }) };

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ success: false, message: "CLAUDE_API_KEY not set" }) };

    await fbPut("/marketing_news_created/" + date, true);

    const prompt = `You are assembling "Marketing News in 60 Seconds" — Loona's daily 5-story briefing on what's shaping creative work today. This is broader than ad-industry trade news: it covers marketing, branding, social media, AI, business, fashion, art, design, and culture. Search the web for what's genuinely happening RIGHT NOW (nothing older than the last couple of days) and pick exactly 5 real, current, verifiable stories that fit this mix:

- 2 INDUSTRY stories — pick from marketing, advertising, social media platform changes, AI, or business (these two don't have to be the same sub-topic as each other or as yesterday's edition — vary which of these four areas you draw from each day).
- 1 CREATIVE-CULTURE story — pick from fashion, art, design, film, or photography (again, vary which of these each day rather than defaulting to the same one).
- 1 CAMPAIGN OR BRAND MOVE — a specific campaign launch, rebrand, creative-director appointment, or notable brand decision.
- 1 WILDCARD — something unexpected but culturally relevant that a creative team should know about, even if it doesn't fit neatly into the above.

Do not force every category to appear — the mix should feel like a real day's news, not a checklist. Avoid stories that are just celebrity outfits or exhibition announcements with no relevance to creative work; every story should connect to why someone doing creative or marketing work would care.

SOURCING GUIDANCE:
- For fashion stories, favor Vogue Business, Business of Fashion, WWD, Hypebeast, Highsnobiety, Dazed, i-D, Fashion Network, or official fashion-house newsrooms.
- For art and creative-culture stories, favor Frieze, Artforum, Artsy, Artnet, Dezeen, It's Nice That, Creative Boom, Designboom, Wallpaper, or official museum/gallery announcements.
- For industry/business stories, favor established marketing and business trade press (e.g. Adweek, Campaign, Digiday, Marketing Dive, AdAge, TechCrunch, The Verge) as fits the topic.
- Use trade publications for business facts; use stronger editorial sources for cultural context and interpretation.

For each story, tag it with exactly ONE category from this list: ${NEWS_CATEGORY_KEYS.join(", ")} (fashion, art, design, photography, film, branding, social=Social Media, ai=AI, performance=Performance Marketing, business=Business, culture=Culture, copywriting=Copywriting — pick whichever single tag best fits).

Write each story in three parts, in your own original words (never copy sentences from the source):
- "whatHappened": 1-2 sentences, a concise factual summary of what actually happened.
- "whyItMatters": 1-2 sentences on why this matters for people doing creative or marketing work — the wider signal, not just the fact.
- "loonaTake": ONE short, sharp, quotable line (not a full sentence restating the above) — Loona's house point of view. Examples of the tone to match (do not reuse these lines verbatim, write new ones for the actual stories): "A rebrand often begins with a person before it reaches the logo." / "Campaign references usually arrive after artists have already moved on."

Respond with ONLY a valid JSON array, no markdown fences, no other text, in this exact shape:
[{"category": "one of the keys above", "title": "short headline", "whatHappened": "...", "whyItMatters": "...", "loonaTake": "...", "source": "Publication Name", "url": "https://..."}]`;

    const resp = await req("POST", "https://api.anthropic.com/v1/messages", {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }, {
      model: "claude-sonnet-5",
      max_tokens: 2200,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages: [{ role: "user", content: prompt }]
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error("Claude API " + resp.status + ": " + JSON.stringify(resp.body).slice(0, 500));
    }

    const rawItems = extractJsonArray(resp.body.content).slice(0, 5);
    const items = rawItems.map((it) => ({
      category: NEWS_CATEGORY_KEYS.includes(it.category) ? it.category : "culture",
      title: it.title || "",
      whatHappened: it.whatHappened || "",
      whyItMatters: it.whyItMatters || "",
      loonaTake: it.loonaTake || "",
      source: it.source || "",
      url: it.url || ""
    }));
    await fbPut("/marketingNews/" + date, { items, generatedAt: new Date().toISOString() });

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, date, items: items.length }) };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
