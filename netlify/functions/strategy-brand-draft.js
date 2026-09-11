// POST { folderId, name, brandId } — reads a Drive brand folder and drafts a brand config
// from it, for a human to correct and save. See lib/strategy/brand-draft.js for why this
// only ever produces a draft.
//
// Handed off to a background function: a folder that has never been indexed has to be read
// in full first, which is minutes of work, not seconds.
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
  const name = String(body.name || "").trim();
  const folderId = String(body.folderId || "").trim();
  if (!/^[a-z0-9-]+$/.test(brandId)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "brandId must be lowercase letters, numbers or hyphens." }) };
  if (!name) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "name is required." }) };
  if (!/^[a-zA-Z0-9_-]+$/.test(folderId)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "folderId is required." }) };

  // Drafting over a brand that already exists would invite overwriting a config someone
  // built by hand. Editing an existing brand is what the normal form is for.
  const existing = await fbGet(`strategy_brands/${fbSafeKey(brandId)}`);
  if (existing) return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: `${name} is already set up. Edit it in Manage brands instead.` }) };

  const draftPath = `strategy_brand_drafts/${fbSafeKey(brandId)}`;
  const current = await fbGet(draftPath);
  if (current && current.status === "drafting" && current.startedAt && Date.now() - Date.parse(current.startedAt) < 20 * 60 * 1000) {
    return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: "A draft is already being prepared for this brand." }) };
  }

  await fbSet(draftPath, { brandId, name, folderId, status: "drafting", startedAt: new Date().toISOString(), error: null, draft: null });

  try {
    await fetch(`${siteBaseUrl(event)}/.netlify/functions/strategy-brand-draft-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandId, name, folderId }),
    });
  } catch (error) {
    await fbSet(draftPath, { brandId, name, folderId, status: "failed", error: `Could not start drafting: ${error.message || error}`, draft: null });
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: `Could not start drafting: ${error.message || error}` }) };
  }

  return { statusCode: 202, headers: cors(), body: JSON.stringify({ ok: true, brandId }) };
};
