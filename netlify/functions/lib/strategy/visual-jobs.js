"use strict";
const crypto = require("crypto");
const { fbGet, fbSet, fbSafeKey } = require("./firebase");
const { resolveChat } = require("./visual-chats");
const { loadVisualHistory } = require("./visual-memory");

const TERMINAL = new Set(["succeeded", "failed"]);

function signingSecret() { return process.env.VISUAL_JOB_SECRET || process.env.BASIC_AUTH_CREDENTIALS || ""; }
function signVisualJob(id) { return crypto.createHmac("sha256", signingSecret()).update(String(id)).digest("hex"); }
function verifyVisualJobSignature(id, signature) {
  const expected = Buffer.from(signVisualJob(id));
  const actual = Buffer.from(String(signature || ""));
  return Boolean(signingSecret() && actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
}

function jobPath(id) { return `visual_jobs/${fbSafeKey(id)}`; }

async function createVisualJob(request, actor) {
  const chatId = String(request.chatId || "");
  const chat = await resolveChat(chatId);
  const id = crypto.randomUUID();
  const operation = request.operation === "magnific_precision" ? "magnific_precision" : "generate";
  const references = Array.isArray(request.references) ? request.references : [];
  if (references.some((r) => !r || !r.assetKey)) {
    throw new Error("References must be uploaded before a generation job starts.");
  }
  const cleanRequest = {
    operation,
    chatId,
    prompt: String(request.prompt || "").slice(0, 2000),
    count: Number(request.count) || 1,
    size: request.size || "portrait",
    quality: request.quality === "final" ? "final" : "draft",
    provider: request.provider === "magnific" ? "magnific" : "openai",
    actor: actor && actor.name || request.actor || "Hub",
    actorId: actor && actor.id || null,
    actorEmail: actor && actor.email || null,
    actorVerified: Boolean(actor && actor.verified),
    references: references.map((r) => ({
      assetKey: r.assetKey, name: r.name || null, role: r.role || null,
      contentType: r.contentType || null,
    })),
    parentGenerationId: request.parentGenerationId || null,
    parentImageIndex: Number.isInteger(request.parentImageIndex) ? request.parentImageIndex : null,
  };
  if (operation === "magnific_precision") {
    const history = await loadVisualHistory(chat.brandId, { chatId, limit: 100 });
    const source = history.find((round) => round.id === request.sourceGenerationId);
    const imageIndex = Number(request.sourceImageIndex) || 0;
    const image = source && (source.images || [])[imageIndex];
    if (!image || !image.assetKey) throw new Error("Only permanently stored images can be enhanced.");
    cleanRequest.sourceGenerationId = source.id;
    cleanRequest.sourceImageIndex = imageIndex;
    cleanRequest.sourceAssetKey = image.assetKey;
    cleanRequest.prompt = `Magnific Precision enhancement of: ${source.prompt}`;
    cleanRequest.parentGenerationId = source.id;
    cleanRequest.parentImageIndex = imageIndex;
    cleanRequest.provider = "magnific";
    cleanRequest.references = [];
  }
  const record = {
    id, brandId: chat.brandId, chatId, status: "queued", progress: "Waiting to start",
    request: cleanRequest, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await fbSet(jobPath(id), record);
  return record;
}

async function getVisualJob(id) { return fbGet(jobPath(id)); }

async function updateVisualJob(id, patch) {
  const current = await getVisualJob(id);
  if (!current) throw new Error(`No visual job ${id}.`);
  if (TERMINAL.has(current.status) && patch.status && patch.status !== current.status) return current;
  const next = Object.assign({}, current, patch, { updatedAt: new Date().toISOString() });
  await fbSet(jobPath(id), next);
  return next;
}

module.exports = { createVisualJob, getVisualJob, updateVisualJob, signVisualJob, verifyVisualJobSignature, jobPath };
