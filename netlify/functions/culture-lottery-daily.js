// ============================================================================
// LOONA Hub · Culture Lottery — daily personalized draw (Netlify Scheduled
// Function)
// ----------------------------------------------------------------------------
// Runs once daily (see netlify.toml). For every onboarded Culture Lottery
// profile, asks the model to generate an original book/movie/word pick tailored
// to that person's interests, difficulty, time commitment, favorite creators,
// and recent feedback (loved/interesting/not-for-me/saved/finished) — this is
// the actual personalization engine described in the product spec, done via
// the model reasoning over real signal rather than a hardcoded rules table
// (which could never cover more than a handful of interest combinations).
//
// The actual generation logic (generateDrawFor) lives in
// ./lib/culture-lottery-engine.js, shared with culture-lottery-generate.js —
// the on-demand single-profile endpoint that lets anyone missing today's
// draw (new onboard, or this batch hasn't run yet) self-serve one instantly.
//
// Manual run (for testing): GET /.netlify/functions/culture-lottery-daily
// ============================================================================

const { fbGet, fbPut, todayIST, generateDrawFor } = require("./lib/culture-lottery-engine");

exports.handler = async () => {
  try {
    const date = todayIST();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ success: false, message: "OPENAI_API_KEY not set" }) };

    const claim = await fbGet("/culture_lottery_daily_created/" + date);
    if (claim.body) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "already generated", date }) };
    await fbPut("/culture_lottery_daily_created/" + date, true);

    const [profilesResp, feedbackResp] = await Promise.all([
      fbGet("/cultureLottery/profiles"),
      fbGet("/cultureLottery/feedback")
    ]);
    const profiles = profilesResp.body || {};
    const feedback = feedbackResp.body || {};

    const memberKeys = Object.keys(profiles).filter((k) => profiles[k] && profiles[k].onboarded);
    let generated = 0, failed = 0;

    for (const key of memberKeys) {
      try {
        const draw = await generateDrawFor(profiles[key], feedback[key], apiKey);
        await fbPut("/cultureLottery/draws/" + key + "/" + date, { ...draw, generatedAt: new Date().toISOString() });
        generated++;
      } catch (e) {
        failed++;
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, date, profiles: memberKeys.length, generated, failed })
    };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
