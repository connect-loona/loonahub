// POST { brandId, prompt, provider?, count?, size?, actor?, referenceCount?, referenceNote? }
//   -> { id, provider, model, images: [{ url, revisedPrompt }] }
//
// Visual Studio's one generation endpoint. Synchronous on purpose: OpenAI's image call
// returns in a few seconds, comfortably inside a normal function's budget, and a background
// function plus a Firebase listener would be a lot of machinery for a wait nobody minds.
// Magnific, when it lands, is webhook-driven and WILL need that treatment — which is why the
// provider layer (image-providers.js) already returns finished images rather than streaming,
// so adding a slow provider changes that file and this one, and nothing above them.
//
// The record is written before the response goes back, and deliberately whether or not
// anybody ever picks one of the images: an abandoned round is still evidence about what this
// brand's team tried and rejected. See visual-memory.js.
"use strict";
const { fbGet, fbSafeKey } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");
const { generateImages, MAX_IMAGES } = require("./lib/strategy/image-providers");
const { recordGeneration } = require("./lib/strategy/visual-memory");

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
  // This spends real money per call, so it is never open.
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }

  const brandId = String(body.brandId || "").trim();
  if (!/^[a-z0-9-]+$/.test(brandId)) return fail(400, "brandId must be lowercase letters, numbers or hyphens.");

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return fail(400, "A prompt is required.");

  // Visual Studio's brands come from Hub, which is the source of truth for what a brand is —
  // but the memory is written under a Strategy OS brand key, so an unknown id would quietly
  // create a new orphan bucket that nothing ever reads back.
  const brand = await fbGet(`brands/${fbSafeKey(brandId)}`);
  const strategyBrand = await fbGet(`strategy_brands/${fbSafeKey(brandId)}`);
  if (!brand && !strategyBrand) return fail(404, "Brand not found in Hub.");

  const count = Number(body.count) || 1;
  if (count < 1 || count > MAX_IMAGES) return fail(400, `count must be between 1 and ${MAX_IMAGES}.`);

  let result;
  try {
    result = await generateImages({
      prompt, provider: body.provider, count, size: body.size, model: body.model,
    });
  } catch (error) {
    // Carry the provider's own words through rather than flattening everything to "failed" —
    // the billing and quota cases are the ones people actually need to read.
    const status = Number(error.status) || 0;
    const clientFault = status === 400 || /Unknown image size|A prompt is required|Unknown image provider/.test(error.message || "");
    return fail(clientFault ? 400 : 502, error.message || "Image generation failed.");
  }

  let id = null;
  try {
    ({ id } = await recordGeneration(brandId, {
      prompt,
      provider: result.provider,
      model: result.model,
      actor: body.actor || "Hub",
      referenceCount: body.referenceCount,
      referenceNote: body.referenceNote,
      images: result.images,
    }));
  } catch (error) {
    // Losing the memory write must not lose the images the user just paid for. Say so in the
    // response instead, so the UI can warn rather than silently dropping it from history.
    console.error(`Could not record generation for ${brandId}:`, error.message);
  }

  return {
    statusCode: 200,
    headers: cors(),
    body: JSON.stringify({
      id, provider: result.provider, model: result.model, images: result.images,
      recorded: Boolean(id),
    }),
  };
};
