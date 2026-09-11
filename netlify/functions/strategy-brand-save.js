// POST { brandId, config } -> validates a full BrandConfigSchema-shaped object and, if
// valid, writes it to Firebase (strategy_brands/<brandId>). Backs the Strategy OS "Manage
// brands" screen — the brief's section 13 wants brand config editable as a form instead of
// only through git, and this is the write side of that (the Hub UI reads brands straight
// off the strategy_brands Firebase collection via a live listener, same as everywhere
// else in Hub).
//
// Same auth posture as strategy-run-start.js/strategy-stage-approve.js: this can rewrite a
// client's live strategy configuration, so it verifies the Hub cookie and Firebase user rather than
// riding on basic-auth.ts's blanket function exclusion.
"use strict";
const { fbSet } = require("./lib/strategy/firebase");
const { BrandConfigSchema } = require("./lib/strategy/contracts");
const { checkAuthorization } = require("./lib/strategy/auth");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = await checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const brandId = String(body.brandId || "").trim();
  if (!/^[a-z0-9-]+$/.test(brandId)) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Brand id must be lowercase letters, numbers or hyphens." }) };
  }
  if (!body.config || typeof body.config !== "object") {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "config is required." }) };
  }
  if (body.config.id !== brandId) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `config.id ("${body.config.id}") must match brandId ("${brandId}").` }) };
  }

  // Tolerate one stale browser tab during rollout, but never persist the retired field.
  const { canva: _retiredCanva, ...currentConfig } = body.config;
  const result = BrandConfigSchema.safeParse(currentConfig);
  if (!result.success) {
    // Mirror the issues back in a form the UI can show per-field, not just a single
    // generic "invalid" message — this config has a lot of required minimum-length arrays
    // (market, voice.descriptors, audiences, visual.feel/principles/avoid, pillars) and a
    // strict shape at every level, so a vague error would be hard to act on.
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { statusCode: 422, headers: cors(), body: JSON.stringify({ error: "This brand config doesn't match the required shape.", issues }) };
  }

  try {
    await fbSet(`strategy_brands/${brandId}`, result.data);
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
