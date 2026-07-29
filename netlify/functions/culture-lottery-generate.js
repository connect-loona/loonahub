// ============================================================================
// LOONA Hub · Culture Lottery — on-demand single-profile draw generation
// ----------------------------------------------------------------------------
// The scheduled culture-lottery-daily.js batch only covers people who were
// already onboarded before it last ran, and only runs once a day — so anyone
// who onboards afterward, or whose batch run failed, would otherwise be stuck
// staring at "today's draw hasn't landed yet" with no way to get one. This
// endpoint generates (or returns an already-generated) draw for exactly one
// member, on request — called right after onboarding finishes, and from a
// "Get Today's Draw" button on the empty state.
//
// POST body: { "key": "<fbMemberKey>" }
// Manual test: curl -X POST -d '{"key":"gokul"}' /.netlify/functions/culture-lottery-generate
// ============================================================================

const { fbGet, fbPut, todayIST, generateDrawFor } = require("./lib/culture-lottery-engine");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ success: false, message: "POST only" }) };

    let key;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "{}");
      key = (JSON.parse(raw) || {}).key;
    } catch (e) { key = null; }
    if (!key) return { statusCode: 400, body: JSON.stringify({ success: false, message: "Missing key" }) };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ success: false, message: "OPENAI_API_KEY not set" }) };

    const date = todayIST();

    const existing = await fbGet("/cultureLottery/draws/" + key + "/" + date);
    if (existing.status < 200 || existing.status >= 300) return { statusCode: 502, body: JSON.stringify({ success: false, message: "Firebase read failed: " + JSON.stringify(existing.body).slice(0, 300) }) };
    if (existing.body) return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, date, draw: existing.body, skipped: "already generated" }) };

    const [profileResp, feedbackResp] = await Promise.all([
      fbGet("/cultureLottery/profiles/" + key),
      fbGet("/cultureLottery/feedback/" + key)
    ]);
    if (profileResp.status < 200 || profileResp.status >= 300) return { statusCode: 502, body: JSON.stringify({ success: false, message: "Firebase read failed: " + JSON.stringify(profileResp.body).slice(0, 300) }) };
    const profile = profileResp.body;
    if (!profile || !profile.onboarded) return { statusCode: 400, body: JSON.stringify({ success: false, message: "No onboarded profile for this member" }) };

    const draw = await generateDrawFor(profile, feedbackResp.body, apiKey);
    const doc = { ...draw, generatedAt: new Date().toISOString() };
    await fbPut("/cultureLottery/draws/" + key + "/" + date, doc);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, date, draw: doc }) };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
