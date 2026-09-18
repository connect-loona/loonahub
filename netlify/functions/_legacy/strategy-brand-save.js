// POST { brandId, config } -> validates a full BrandConfigSchema-shaped object and, if
// valid, writes it to Firebase (strategy_brands/<brandId>). Backs the Strategy OS "Manage
// brands" screen — the brief's section 13 wants brand config editable as a form instead of
// only through git, and this is the write side of that (the Hub UI reads brands straight
// off the strategy_brands Firebase collection via a live listener, same as everywhere
// else in Hub).
//
// Same auth posture as strategy-run-start.js/strategy-stage-approve.js: this can rewrite a
// client's live strategy configuration, so it checks the site cookie itself rather than
// riding on basic-auth.ts's blanket function exclusion.
"use strict";
const { fbSet } = require("../lib/strategy/firebase");
const { BrandConfigSchema } = require("../lib/strategy/contracts");
const { checkAuthorization } = require("../lib/strategy/auth");
const { recordManiEventSafe } = require("../lib/strategy/mani-events");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}
function text(value, fallback) { const clean = String(value || "").trim(); return clean || fallback; }
function list(value, minimum, fallback, maximum) {
  const items = Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const result = items.length >= minimum ? items : fallback;
  return maximum ? result.slice(0, maximum) : result;
}
function normalizeConfig(raw, brandId) {
  const input = raw && typeof raw === "object" ? raw : {};
  const d = input.deliverables && typeof input.deliverables === "object" ? input.deliverables : {};
  const count = (key) => Number.isInteger(d[key]) && d[key] >= 0 ? d[key] : 0;
  const name = text(input.name, brandId);
  return {
    schemaVersion: "1.0", id: brandId, name,
    category: text(input.category, "To be defined"),
    market: list(input.market, 1, ["To be defined"]), aspirationalMarkets: list(input.aspirationalMarkets, 0, []),
    website: typeof input.website === "string" && input.website.trim() ? input.website.trim() : null,
    driveFolderUrl: text(input.driveFolderUrl, ""), oneLineTruth: text(input.oneLineTruth, `${name} — brand truth to be confirmed.`),
    deliverables: { reel: count("reel"), carousel: count("carousel"), static: count("static"), story: count("story"), confirmed: Boolean(d.confirmed) },
    voice: { descriptors: list(input.voice && input.voice.descriptors, 3, ["To be defined", "Review required", "Brand-specific"], 6), principles: list(input.voice && input.voice.principles, 1, ["Use verified brand information only."]), bannedWords: list(input.voice && input.voice.bannedWords, 0, []), bannedMoves: list(input.voice && input.voice.bannedMoves, 0, []), emojiRule: text(input.voice && input.voice.emojiRule, "To be defined"), languageRule: text(input.voice && input.voice.languageRule, "To be defined") },
    audiences: [{ id: "audience-to-define", description: "Audience to be defined", buyingSituation: "To be defined", trigger: "To be defined" }],
    visual: { feel: list(input.visual && input.visual.feel, 3, ["To be defined", "Brand-specific", "Review required"]), palette: list(input.visual && input.visual.palette, 0, []), principles: list(input.visual && input.visual.principles, 1, ["Use approved brand materials."]), avoid: list(input.visual && input.visual.avoid, 1, ["Unverified claims."]) },
    pillars: [{ id: "brand-basics", name: "Brand basics", description: "Details to be defined", targetShare: 1 }],
    competitors: list(input.competitors, 0, []), portfolios: [], claimRules: [], copyStructure: null, knownUnknowns: list(input.knownUnknowns, 0, []), sourceVectorStoreIds: [],
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = checkAuthorization(event);
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
  const config = normalizeConfig(body.config, brandId);
  const driveFolderUrl = config.driveFolderUrl;
  if (!driveFolderUrl) return { statusCode: 422, headers: cors(), body: JSON.stringify({ error: "A brand Google Drive folder link is required." }) };
  const deliverables = config.deliverables;
  if (!Object.entries(deliverables).some(([key, value]) => key !== "confirmed" && typeof value === "number" && value > 0)) {
    return { statusCode: 422, headers: cors(), body: JSON.stringify({ error: "At least one deliverable with a count above zero is required." }) };
  }

  const result = BrandConfigSchema.safeParse(config);
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
    await recordManiEventSafe({ type: "brand_strategy_updated", source: "strategy_os", brandId, actor: String(body.actor || "Hub team").slice(0, 120), entityType: "brand_config", entityId: brandId, action: "updated", summary: `Updated the Strategy OS configuration for ${result.data.name || brandId}.` });
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
