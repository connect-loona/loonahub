// POST { brandId, month, actor, runtime?, sourceContext? } -> creates a strategy_runs
// entry and kicks off the Research stage as a Background Function (fire-and-forget —
// the Hub UI follows progress live via its Firebase listener on strategy_runs/<runId>,
// same reactive pattern the rest of Hub already uses everywhere else).
//
// Auth: this endpoint is meant to be called only from an already-logged-in Hub session.
// basic-auth.ts's edge gate lets ALL /.netlify/functions/* requests through unchecked
// (unlike most of Hub's other functions, this one shouldn't skip auth entirely — it can
// kick off billed AI runs and touch a client's live strategy), so this function checks the
// same site cookie itself — see ./lib/strategy/auth.js.
"use strict";
const { fbSet } = require("./lib/strategy/firebase");
const { loadBrandConfig, loadMonthInput } = require("./lib/strategy/store");
const { checkAuthorization } = require("./lib/strategy/auth");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function runId(brandId, month) {
  return `${brandId}_${month}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const brandId = String(body.brandId || "").trim();
  const month = String(body.month || "").trim();
  const actor = String(body.actor || "Unknown").trim();
  if (!/^[a-z0-9-]+$/.test(brandId)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "brandId must be lowercase letters, numbers or hyphens." }) };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "month must be YYYY-MM." }) };

  try {
    // Fail fast with a clear error if the brand isn't configured, rather than creating a
    // run doc that can never start.
    await loadBrandConfig(brandId);
    await loadMonthInput(brandId, month);

    const id = runId(brandId, month);
    const runtimeName = body.runtime === "fixture" ? "fixture" : "openai";
    const now = new Date().toISOString();
    await fbSet(`strategy_runs/${id}`, {
      runId: id,
      brandId,
      month,
      runtime: runtimeName,
      fixtureDir: runtimeName === "fixture" ? (body.fixtureDir || null) : null,
      sourceContext: Array.isArray(body.sourceContext) ? body.sourceContext.filter((s) => typeof s === "string") : [],
      owner: actor,
      createdAt: now,
      updatedAt: now,
      status: "draft",
      stages: { research: { status: "queued" }, strategy: { status: "locked" } },
      approvals: {},
    });

    const base = process.env.URL || process.env.DEPLOY_URL || "";
    await fetch(`${base}/.netlify/functions/strategy-research-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: id }),
    }).catch((e) => {
      // The run doc still exists in "draft"/"queued" state even if this kickoff call
      // fails to fire — surfaced to the UI as "stuck in queued", recoverable by a manual
      // retry endpoint later rather than silently losing the run.
      console.error("Failed to trigger research background function:", e);
    });

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ runId: id }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
