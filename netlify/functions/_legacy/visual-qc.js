// Evidence-based visual review. It never turns an uncheckable claim into a green tick: when
// the necessary reference is missing the schema requires `not_checked`.
"use strict";
const { checkAuthorization } = require("../lib/strategy/auth");
const { resolveChat } = require("../lib/strategy/visual-chats");
const { loadVisualHistory, recordQc } = require("../lib/strategy/visual-memory");
const { loadAsset } = require("../lib/strategy/visual-assets");
const { resolveVisualActor } = require("../lib/strategy/visual-actor");
const { recordApiUsage } = require("../lib/strategy/api-usage");

const reply = (statusCode, value) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
const CHECKS = ["prompt_match", "product_identity", "text_and_logo", "brand_style", "visual_integrity", "production_readiness"];
const STATUSES = new Set(["pass", "warn", "fail", "not_checked"]);

// Caps on what a model is allowed to put on screen and into a brand's permanent memory.
// A structured-output schema is a request, not a guarantee: the model can still return a
// missing check, an invented status, or a thousand-word summary, and every other writer in
// this codebase caps what it stores. This one was spreading the parsed object straight into
// Firebase, so whatever came back became part of the record.
const MAX_SUMMARY_CHARS = 500;
const MAX_ISSUE_CHARS = 300;
const MAX_ISSUES = 3;
// Truncating JSON produces unparseable JSON, so an oversized body is refused rather than cut.
const MAX_RAW_OUTPUT_CHARS = 20000;

function cap(value, limit) {
  return String(value == null ? "" : value).trim().slice(0, limit);
}

// Rebuilt key by key rather than spread: an unexpected field cannot reach the response or the
// database, and every one of the six checks is present afterwards whatever the model returned.
// A check the model omitted is "not_checked" — which is the honest reading, and the one status
// this feature exists to keep meaningful.
function sanitizeQc(parsed, meta = {}) {
  const source = (parsed && typeof parsed === "object") ? parsed : {};
  const sourceChecks = (source.checks && typeof source.checks === "object") ? source.checks : {};
  const checks = {};
  for (const name of CHECKS) {
    const raw = sourceChecks[name];
    const status = raw && STATUSES.has(raw.status) ? raw.status : "not_checked";
    const issues = Array.isArray(raw && raw.issues)
      ? raw.issues.map((issue) => cap(issue, MAX_ISSUE_CHARS)).filter(Boolean).slice(0, MAX_ISSUES)
      : [];
    checks[name] = { status, issues };
  }
  return {
    summary: cap(source.summary, MAX_SUMMARY_CHARS),
    checks,
    checkedAt: meta.checkedAt || new Date().toISOString(),
    checkedByModel: cap(meta.model, 100),
    imageIndex: Number.isInteger(meta.imageIndex) ? meta.imageIndex : 0,
  };
}

async function imagePart(assetKey) {
  const asset = await loadAsset(assetKey);
  if (!asset) return null;
  return { type: "input_image", image_url: `data:${asset.metadata.contentType || "image/png"};base64,${asset.data.toString("base64")}` };
}

function outputText(data) {
  if (data.output_text) return data.output_text;
  return (data.output || []).flatMap((item) => item.content || []).filter((part) => part.type === "output_text").map((part) => part.text).join("\n");
}

exports.handler = async (event) => {
  const auth = checkAuthorization(event);
  if (!auth.ok) return reply(401, { error: "Unauthorized" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  try {
    const actor = await resolveVisualActor(event, "Hub");
    const chat = await resolveChat(String(body.chatId || ""));
    const history = await loadVisualHistory(chat.brandId, { chatId: body.chatId, limit: 100 });
    const generation = history.find((g) => g.id === body.generationId);
    if (!generation) return reply(404, { error: "Generation not found in this chat." });
    const image = (generation.images || [])[Number(body.imageIndex) || 0];
    if (!image || !image.assetKey) return reply(400, { error: "Only permanently stored images can be reviewed." });
    const content = [{
      type: "input_text",
      text: [
        `Review this generated agency image against the evidence supplied. Original request: ${generation.prompt}`,
        `Applied rules: ${(generation.appliedRules || []).map((r) => r.label).join("; ") || "none recorded"}`,
        "Image 1 is the generated output. Later images, if present, are references.",
        "For product identity, text/logo or brand style, use not_checked when no reference makes a reliable comparison possible.",
        "Be strict, specific, and concise. Do not claim pixel-perfect identity from visual inspection.",
      ].join("\n"),
    }, await imagePart(image.assetKey)];
    for (const ref of (generation.referenceAssets || []).slice(0, 2)) {
      const part = await imagePart(ref.assetKey);
      if (part) content.push(part);
    }
    const schemaChecks = Object.fromEntries(CHECKS.map((name) => [name, {
      type: "object", additionalProperties: false,
      properties: { status: { type: "string", enum: ["pass", "warn", "fail", "not_checked"] }, issues: { type: "array", items: { type: "string" }, maxItems: 3 } },
      required: ["status", "issues"],
    }]));
    const model = process.env.VISUAL_QC_MODEL || "gpt-4.1";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: content.filter(Boolean) }],
        text: { format: { type: "json_schema", name: "visual_qc", strict: true, schema: {
          type: "object", additionalProperties: false,
          properties: { summary: { type: "string" }, checks: { type: "object", additionalProperties: false, properties: schemaChecks, required: CHECKS } },
          required: ["summary", "checks"],
        } } },
      }),
    });
    const raw = await response.json();
    if (!response.ok) throw new Error(raw.error && raw.error.message || "OpenAI could not review this image.");
    const text = outputText(raw);
    if (text.length > MAX_RAW_OUTPUT_CHARS) throw new Error("The review came back unreasonably long and was discarded.");
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("The review did not come back as readable JSON."); }
    // Sanitised once, then used for BOTH the response and the permanent record — so what the
    // screen shows and what the brand's memory keeps cannot drift apart.
    const qc = sanitizeQc(parsed, { model, imageIndex: Number(body.imageIndex) || 0 });
    await recordQc(chat.brandId, generation.id, qc);
    try {
      await recordApiUsage({ id: `qc-${generation.id}-${Date.now()}`, userId: actor.id, userEmail: actor.email,
        userName: actor.name, identityVerified: actor.verified, provider: "openai", model,
        feature: "visual_studio", operation: "quality_review", brandId: chat.brandId,
        chatId: body.chatId, outputCount: 0 });
    } catch (usageError) { console.error("Could not record review usage:", usageError.message); }
    return reply(200, { qc });
  } catch (error) {
    return reply(502, { error: error.message || "Visual review failed." });
  }
};

// Exported for tests: the sanitiser is the part that has to hold regardless of what a model
// returns, so it is exercised directly rather than only through a mocked HTTP round trip.
exports.sanitizeQc = sanitizeQc;
exports.CHECKS = CHECKS;
exports.MAX_SUMMARY_CHARS = MAX_SUMMARY_CHARS;
exports.MAX_ISSUE_CHARS = MAX_ISSUE_CHARS;
exports.MAX_ISSUES = MAX_ISSUES;
