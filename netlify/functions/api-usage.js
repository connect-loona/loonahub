"use strict";
const { checkAuthorization } = require("./lib/strategy/auth");
const { listApiUsage, summarizeApiUsage } = require("./lib/strategy/api-usage");

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, value) => ({ statusCode, headers, body: JSON.stringify(value) });

function monthWindow(month) {
  const match = /^\d{4}-\d{2}$/.test(String(month || "")) ? String(month) : new Date().toISOString().slice(0, 7);
  const start = new Date(`${match}-01T00:00:00Z`);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  return { month: match, start: start.toISOString(), end: end.toISOString() };
}

async function openAiOrganization(window) {
  const key = process.env.OPENAI_ADMIN_KEY || "";
  if (!key) return { connected: false, reason: "Add OPENAI_ADMIN_KEY to show organization spend." };
  const start = Math.floor(Date.parse(window.start) / 1000);
  const end = Math.floor(Date.parse(window.end) / 1000);
  const call = async (path) => {
    const response = await fetch(`https://api.openai.com/v1/${path}?start_time=${start}&end_time=${end}&bucket_width=1d&limit=31`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `OpenAI usage request failed (${response.status}).`);
    return data;
  };
  try {
    const [costs, images] = await Promise.all([call("organization/costs"), call("organization/usage/images")]);
    const spend = (costs.data || []).flatMap((bucket) => bucket.results || []).reduce((sum, row) => sum + Number(row.amount?.value || 0), 0);
    const imageCount = (images.data || []).flatMap((bucket) => bucket.results || []).reduce((sum, row) => sum + Number(row.images || 0), 0);
    const budget = Number(process.env.OPENAI_MONTHLY_BUDGET_USD || 0) || null;
    return { connected: true, spendUsd: spend, imageCount, budgetUsd: budget, remainingBudgetUsd: budget === null ? null : Math.max(0, budget - spend) };
  } catch (error) {
    return { connected: false, reason: error.message };
  }
}

async function magnificTeamUsage(window) {
  const key = process.env.MAGNIFIC_API_KEY || "";
  if (!key) return { connected: false, analyticsConnected: false, reason: "MAGNIFIC_API_KEY is not configured." };
  try {
    const inclusiveEnd = new Date(Date.parse(window.end) - 1000).toISOString().slice(0, 10);
    const response = await fetch("https://api.magnific.com/v1/analytics/team-credit-usage", {
      method: "POST",
      headers: { "x-magnific-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ granularity: "day", start_date: window.start.slice(0, 10), end_date: inclusiveEnd }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Magnific analytics request failed (${response.status}).`);
    const consumptions = (data.data || []).flatMap((bucket) => bucket.consumptions || []);
    const creditsUsed = consumptions.reduce((sum, row) => sum + Number(row.user_credits || 0), 0);
    const uses = consumptions.reduce((sum, row) => sum + Number(row.user_uses || 0), 0);
    const allowance = Number(process.env.MAGNIFIC_MONTHLY_CREDIT_ALLOWANCE || 0) || null;
    return { connected: true, analyticsConnected: true, creditsUsed, uses, allowance,
      remainingCredits: allowance === null ? null : Math.max(0, allowance - creditsUsed) };
  } catch (error) {
    return {
      connected: true, analyticsConnected: false, reason: error.message,
      note: "Magnific's team analytics endpoint is available only on Business and Enterprise plans. Hub's own operation ledger still works on other plans.",
    };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  const auth = checkAuthorization(event);
  if (!auth.ok) return reply(401, { error: "Unauthorized", reason: auth.reason });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  const window = monthWindow(body.month);
  try {
    const [events, openai, magnific] = await Promise.all([listApiUsage(window.start, window.end), openAiOrganization(window), magnificTeamUsage(window)]);
    const summary = summarizeApiUsage(events);
    return reply(200, {
      month: window.month,
      coverage: "Hub-attributed usage begins when this release is deployed; OpenAI organization spend covers the whole connected organization.",
      ...summary,
      accounts: {
        openai,
        magnific: {
          ...magnific,
          operations: summary.providers.find((x) => x.key === "magnific")?.requests || 0,
          note: magnific.note || (magnific.remainingCredits == null
            ? "Credits consumed are provider-reported. Add MAGNIFIC_MONTHLY_CREDIT_ALLOWANCE to calculate remaining monthly allowance."
            : "Remaining credits are calculated from your configured monthly allowance minus provider-reported consumption."),
        },
      },
    });
  } catch (error) {
    return reply(502, { error: error.message || "Could not load API usage." });
  }
};

module.exports.monthWindow = monthWindow;
module.exports.openAiOrganization = openAiOrganization;
module.exports.magnificTeamUsage = magnificTeamUsage;
