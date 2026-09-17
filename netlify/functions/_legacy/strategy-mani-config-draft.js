"use strict";
const { fbGet, fbSet, fbSafeKey } = require("../lib/strategy/firebase");
const { checkAuthorization } = require("../lib/strategy/auth");
const { hubBrandExists } = require("../lib/strategy/hub-brands");
const { siteBaseUrl } = require("../lib/site-base-url");
const { signedBackgroundHeaders } = require("../lib/strategy/background-auth");
function headers() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" }; }
function fail(statusCode, error) { return { statusCode, headers: headers(), body: JSON.stringify({ error }) }; }
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  const auth = checkAuthorization(event); if (!auth.ok) return fail(401, `Unauthorized — ${auth.reason}`);
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }
  const brandId = String(body.brandId || "").trim(); const name = String(body.name || "").trim();
  if (!/^[a-z0-9-]+$/.test(brandId) || !name) return fail(400, "Choose a valid brand first.");
  if (!(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");
  const notes = await fbGet(`mani_brand_notes/${fbSafeKey(brandId)}`);
  if (!notes || !Object.keys(notes).length) return fail(400, "Paste brand context into Mani memory before drafting the configuration.");
  const path = `strategy_brand_drafts/${fbSafeKey(brandId)}`;
  await fbSet(path, { brandId, name, source: "mani_memory", status: "drafting", startedAt: new Date().toISOString(), draft: null, error: null });
  try {
    const backgroundBody = JSON.stringify({ brandId, name });
    await fetch(`${siteBaseUrl(event)}/.netlify/functions/strategy-mani-config-draft-background`, { method: "POST", headers: signedBackgroundHeaders("strategy-mani-config-draft-background", backgroundBody), body: backgroundBody });
    return { statusCode: 202, headers: headers(), body: JSON.stringify({ ok: true, brandId }) };
  } catch (error) { await fbSet(path, { brandId, name, status: "failed", draft: null, error: error.message || String(error) }); return fail(502, "Could not start the configuration draft."); }
};
