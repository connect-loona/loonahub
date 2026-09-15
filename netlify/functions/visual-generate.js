// POST { brandId, prompt, provider?, count?, size?, actor?, referenceCount?, referenceNote? }
//   -> { id, provider, model, images: [{ url, revisedPrompt }] }
//
// Visual Studio's synchronous compatibility endpoint. The UI uses the job endpoint so long
// generations survive browser refreshes; this remains for tests and older clients.
//
// The record is written before the response goes back, and deliberately whether or not
// anybody ever picks one of the images: an abandoned round is still evidence about what this
// brand's team tried and rejected. See visual-memory.js.
"use strict";
const crypto = require("crypto");
const { checkAuthorization } = require("./lib/strategy/auth");
const { generateImages, MAX_IMAGES, MAX_REFERENCES } = require("./lib/strategy/image-providers");
const { recordGeneration } = require("./lib/strategy/visual-memory");
const { resolveChat, touchChat, titleFromPrompt } = require("./lib/strategy/visual-chats");
const { buildRulePreamble, applyRules } = require("./lib/strategy/visual-rules");
const { hubBrandExists } = require("./lib/strategy/hub-brands");
const { expandPrompt, historyForPrompt } = require("./lib/strategy/visual-prompt");
const { loadVisualHistory } = require("./lib/strategy/visual-memory");
const { loadBrain, brainToPromptText } = require("./lib/strategy/brand-brain");
const { preserveGeneratedImages } = require("./lib/strategy/visual-assets");
const { resolveVisualActor } = require("./lib/strategy/visual-actor");
const { recordApiUsage } = require("./lib/strategy/api-usage");

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
  const actor = body.actorId
    ? { id: body.actorId, email: body.actorEmail || null, name: body.actor || "Hub", verified: Boolean(body.actorVerified) }
    : await resolveVisualActor(event, body.actor || "Hub");

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return fail(400, "A prompt is required.");

  const count = Number(body.count) || 1;
  if (count < 1 || count > MAX_IMAGES) return fail(400, `count must be between 1 and ${MAX_IMAGES}.`);

  // References are the whole point of working this way: a base scene plus the exact product,
  // "keep the label, change the background". They arrive as data: URLs and are passed straight
  // through to the provider — never written anywhere, in keeping with Visual Studio not hosting
  // images. What IS remembered is that there were references and what they were for, which is
  // the part that explains a prompt later.
  const references = Array.isArray(body.references) ? body.references : [];
  if (references.length > MAX_REFERENCES) {
    return fail(400, `Up to ${MAX_REFERENCES} reference images at a time.`);
  }

  // WHICH BRAND THIS IS FOR IS DECIDED SERVER-SIDE, NOT BY THE CALLER.
  //
  // A chat records its brand once, when it's created. Every generation names only the chat,
  // and the brand is read back out of the stored chat. If the browser could say "generate into
  // chat X, and that's brand Y", one client's prompts, references and brand memory could be
  // written into another client's project by nothing more than a wrong id in a request body.
  // A brandId sent alongside a chatId is ignored on purpose rather than trusted or merged.
  let brandId;
  let chatId = null;
  if (body.chatId) {
    let chat;
    try { chat = await resolveChat(String(body.chatId)); }
    catch (error) { return fail(error.notFound ? 404 : 502, error.message); }
    brandId = chat.brandId;
    chatId = String(body.chatId);
  } else {
    // No chat: a one-off generation. Here the caller's brandId is all there is, so it's
    // validated against Hub — an unknown id would otherwise quietly create an orphan bucket
    // that nothing ever reads back.
    brandId = String(body.brandId || "").trim();
    if (!/^[a-z0-9-]+$/.test(brandId)) return fail(400, "brandId must be lowercase letters, numbers or hyphens.");
    if (!(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");
  }

  // The brand's hard rules become a real prompt preamble — see visual-rules.js for why these
  // are sentences prepended to the prompt rather than toggles that change nothing.
  let rules = { preamble: "", applied: [] };
  try { rules = await buildRulePreamble(brandId, { disabledRules: body.disabledRules }); }
  catch (error) { console.error(`Could not build rules for ${brandId}:`, error.message); }

  // THE PART THAT CLOSES THE GAP WITH CHATGPT.
  //
  // Typing "make the table warmer" into ChatGPT does not send those four words to the image
  // model: ChatGPT rewrites them, using the whole thread, into a paragraph describing the
  // entire scene with the change applied. Sending the four words raw is why a bare API call
  // produces visibly worse images than the same model does inside ChatGPT.
  //
  // So the thread and the brand's memory are gathered and the prompt is rewritten the same
  // way. Both reads are best-effort — neither is worth failing a generation over.
  let history = "";
  let brandBrain = null;
  try {
    const [rounds, brain] = await Promise.all([
      chatId ? loadVisualHistory(brandId, { chatId, limit: 12 }) : Promise.resolve([]),
      loadBrain(brandId),
    ]);
    history = historyForPrompt(rounds);
    brandBrain = brainToPromptText(brain);
  } catch (error) {
    console.error(`Could not gather context for ${brandId}:`, error.message);
  }

  const expansion = await expandPrompt({
    prompt,
    history,
    brandBrain,
    brandRules: rules.applied,
    referenceRoles: references.map((r) => (r && r.role) || ""),
  });

  // The rules still go in front of the rewritten prompt rather than being folded into it: a
  // model asked to rewrite them could soften them, and they are the part that must not move.
  const finalPrompt = applyRules(rules.preamble, expansion.prompt);

  let result;
  try {
    result = await generateImages({
      prompt: finalPrompt, provider: body.provider, count, size: body.size, model: body.model,
      quality: body.quality, references,
    });
  } catch (error) {
    // The status has to tell these apart, because what the person should DO differs. A burst
    // rate limit clears on its own; running out of credit never does. Flattening both to 502
    // (or to OpenAI's raw JSON) is the opaque-error failure we already fixed once on the text
    // side — see runtime-failover.js.
    const status = Number(error.status) || 0;
    const clientFault = (status === 400 && error.kind !== "quota")
      || /Unknown image size|A prompt is required|Unknown image provider|Up to \d+ reference|Reference \d+ is/.test(error.message || "");
    if (clientFault) return fail(400, error.message);
    if (error.kind === "rate_limit") return fail(429, error.message);
    // Out of credit is not a server error and not the caller's mistake — 402 says "this needs
    // paying for" precisely, and the UI keys off it to say so plainly.
    if (error.kind === "quota") return fail(402, error.message);
    return fail(502, error.message || "Image generation failed.");
  }

  let id = null;
  let createdAt = new Date().toISOString();
  let suggestions = [];
  try {
    const generationId = crypto.randomUUID();
    // Netlify production always gets durable URLs. Unit tests and the lightweight local
    // harness deliberately keep the provider result in memory unless explicitly opted in.
    // Production always preserves. Locally it is opt-in, and VISUAL_ASSET_LOCAL_DIR counts —
    // otherwise the browser tests would exercise a generation whose images are never stored,
    // which is not the shape that ships and would leave every asset-key path untested.
    const durable = process.env.NETLIFY === "true"
      || process.env.VISUAL_ASSET_STORE === "blobs"
      || Boolean(process.env.VISUAL_ASSET_LOCAL_DIR);
    if (durable) {
      result.images = await preserveGeneratedImages(result.images, { brandId, chatId, generationId });
    }
    suggestions = [
      "Keep everything, refine the lighting",
      references.length ? "Keep the product exact, try a closer crop" : "Add a product reference and lock its identity",
      body.size === "portrait" ? "Create a cleaner 4:5 feed variation" : "Create a portrait social variation",
    ];
    // The prompt the PERSON wrote is what gets remembered, not the rule-prefixed version sent
    // to the model — the rules are the same on every round, so storing them would bury the one
    // part of the record that actually differs. What was applied is stored separately.
    const recorded = await recordGeneration(brandId, {
      id: generationId,
      prompt,
      chatId,
      provider: result.provider,
      model: result.model,
      operation: "generate",
      providerTaskId: result.taskId || null,
      actor: actor.name,
      referenceCount: references.length,
      // What each reference was FOR ("the product", "the lighting"), joined into one note. The
      // roles are the useful half — six months on, "2 references" says nothing, but "kept the
      // product, took the lighting from the second" explains the whole round.
      referenceNote: references.map((r) => String((r && r.role) || "").trim()).filter(Boolean).join(" · ") || body.referenceNote || null,
      referenceAssets: references,
      images: result.images,
      appliedRules: rules.applied,
      // What the model was actually asked for, kept alongside what the person typed. Six
      // months on this is the only way to tell a bad image from a bad rewrite.
      expandedPrompt: expansion.expanded ? expansion.prompt : null,
      // Draft or Final. Worth keeping: a soft-looking image six months on is explained
      // instantly by "this was a draft", and otherwise looks like the model underperforming.
      quality: body.quality === "final" ? "final" : "draft",
      parentGenerationId: body.parentGenerationId || null,
      parentImageIndex: Number.isInteger(body.parentImageIndex) ? body.parentImageIndex : null,
      suggestions,
    });
    id = recorded.id;
    createdAt = recorded.record.createdAt;
    if (chatId) await touchChat(chatId, { titleIfUnset: titleFromPrompt(prompt) });
  } catch (error) {
    // Losing the memory write must not lose the images the user just paid for. Say so in the
    // response instead, so the UI can warn rather than silently dropping it from history.
    console.error(`Could not record generation for ${brandId}:`, error.message);
  }

  // This ledger is deliberately separate from brand memory. It contains operational totals
  // and identity, never prompt text or image bytes, so managers can coach usage without
  // turning the report into surveillance of creative work.
  try {
    await recordApiUsage({
      id: `visual-${id || crypto.randomUUID()}`,
      userId: actor.id, userEmail: actor.email, userName: actor.name, identityVerified: actor.verified,
      provider: result.provider, model: result.model, feature: "visual_studio", operation: "generate",
      brandId, chatId, outputCount: result.images.length,
    });
  } catch (error) {
    console.error("Could not record API usage:", error.message);
  }

  return {
    statusCode: 200,
    headers: cors(),
    body: JSON.stringify({
      id, brandId, chatId, provider: result.provider, model: result.model, createdAt,
      images: result.images,
      // So the UI can show exactly which rules shaped this image rather than asserting it.
      appliedRules: rules.applied,
      expandedPrompt: expansion.expanded ? expansion.prompt : null,
      quality: body.quality === "final" ? "final" : "draft",
      suggestions,
      recorded: Boolean(id),
    }),
  };
};
