// POST { brandId, generationId, index, actor?, note? } -> { ok: true, record }
//
// Records which take a human chose. This is the single most valuable thing Visual Studio
// writes down: a prompt says what somebody asked for, but the pick says what this brand
// actually looks like once a person with taste has decided between four near-identical
// options. Only picked rounds reach the strategy agents (see visualHistoryToPromptText).
"use strict";
const { checkAuthorization } = require("../lib/strategy/auth");
const { recordPick } = require("../lib/strategy/visual-memory");
const { resolveVisualActor, verifyVisualSession } = require("../lib/strategy/visual-actor");
const { recordApiUsage } = require("../lib/strategy/api-usage");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function fail(statusCode, error) {
  return { statusCode, headers: cors(), body: JSON.stringify({ error }) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  const auth = checkAuthorization(event);
  if (!auth.ok && !(await verifyVisualSession(event))) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }

  const brandId = String(body.brandId || "").trim();
  if (!/^[a-z0-9-]+$/.test(brandId)) return fail(400, "brandId must be lowercase letters, numbers or hyphens.");

  const generationId = String(body.generationId || "").trim();
  if (!generationId) return fail(400, "A generationId is required.");

  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0) return fail(400, "index must be a non-negative integer.");

  try {
    const actor = await resolveVisualActor(event, body.actor || "Hub");
    const record = await recordPick(brandId, generationId, {
      index, actor: actor.name, note: body.note, tags: body.tags,
    });
    await recordApiUsage({ id: `pick-${generationId}`, userId: actor.id, userEmail: actor.email, userName: actor.name,
      identityVerified: actor.verified, provider: record.provider, model: record.model, feature: "visual_studio",
      operation: "pick", brandId, chatId: record.chatId, requests: 0 });
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, record }) };
  } catch (error) {
    if (/No generation/.test(error.message || "")) return fail(404, error.message);
    return fail(502, error.message || "Could not record the pick.");
  }
};
