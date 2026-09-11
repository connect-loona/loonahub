// POST { brandId, actor } — kicks off a Drive re-index for one brand, without starting a
// billed strategy run.
//
// Why this exists separately from the pipeline: a brand's Drive library is only read as a
// side effect of running a stage (loadBrandLibrary in pipeline.js), so before this the only
// way to get new folder content into the agents' memory was to start a whole strategy run.
// That's backwards when someone has just uploaded a re-exported deck and wants to know
// whether it's readable now. Scanning is also the expensive part — every new or changed PDF
// costs a model call — so it's worth being able to do it once, deliberately, and have every
// later run reuse the memory (see brand-library-memory.js).
//
// The work itself runs in strategy-brand-library-scan-background.js because reading a
// folder's worth of PDFs takes far longer than a synchronous function's 10-second budget.
// This endpoint just marks the brand as scanning and hands off; the app follows progress on
// its existing strategy_brand_library/<brandId> listener.
"use strict";
const { fbGet, fbSet, fbSafeKey } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");
const { siteBaseUrl } = require("./lib/site-base-url");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
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
  if (!/^[a-z0-9-]+$/.test(brandId)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "brandId must be lowercase letters, numbers or hyphens." }) };

  const brand = await fbGet(`strategy_brands/${fbSafeKey(brandId)}`);
  if (!brand) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Brand not found." }) };

  // Don't stack scans: a second one would re-read the same files the first is already
  // paying for. A scan older than 20 minutes is treated as dead rather than in progress,
  // so a crashed background function can't wedge the button forever.
  const existing = await fbGet(`strategy_brand_library/${fbSafeKey(brandId)}`);
  if (existing && existing.scanning && existing.scanStartedAt && Date.now() - Date.parse(existing.scanStartedAt) < 20 * 60 * 1000) {
    return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: "A scan is already running for this brand." }) };
  }

  await fbSet(`strategy_brand_library/${fbSafeKey(brandId)}`, Object.assign({}, existing || { brandId }, {
    scanning: true,
    scanStartedAt: new Date().toISOString(),
    scanError: null,
  }));

  try {
    await fetch(`${siteBaseUrl(event)}/.netlify/functions/strategy-brand-library-scan-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandId, actor: String(body.actor || "Unknown").trim() }),
    });
  } catch (error) {
    // Same reasoning as strategy-run-start.js: record the failure where the UI can see it
    // rather than leaving the brand stuck showing "scanning" with nothing running.
    await fbSet(`strategy_brand_library/${fbSafeKey(brandId)}/scanning`, false);
    await fbSet(`strategy_brand_library/${fbSafeKey(brandId)}/scanError`, `Could not start the scan: ${error.message || error}`);
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: `Could not start the scan: ${error.message || error}` }) };
  }

  return { statusCode: 202, headers: cors(), body: JSON.stringify({ ok: true, brandId }) };
};
