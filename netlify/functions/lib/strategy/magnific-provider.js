// Magnific's API is asynchronous: submit a paid task, then poll until the finished image URL
// exists. This module is deliberately server-only; MAGNIFIC_API_KEY must never reach React.
"use strict";
const { ConfigurationError } = require("./errors");
const { referenceForProvider } = require("./visual-assets");
const { baseRatioForMagnific, promptForShape } = require("./image-shapes");

const API = "https://api.magnific.com/v1/ai";
const POLL_MS = 4000;
const MAX_POLLS = 180; // twelve minutes, inside Netlify background-function limits.

function apiKey() { return process.env.MAGNIFIC_API_KEY || ""; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
// Which of Magnific's own aspect ratios to GENERATE at. The exact shape is reached by cropping
// afterwards, the same way it is for OpenAI, so only the three ratio names this codebase has
// actually seen Magnific accept are ever sent.
//
// This used to end `|| "square_1_1"`, which meant an unrecognised shape came back silently
// square. That is the precise failure the provider was written to avoid — a portrait asset
// delivered square reaches a client before anyone notices, because nothing errored and the
// image looks fine on its own. An unknown shape is now a loud failure at the shape table.
function aspectRatio(size) {
  return baseRatioForMagnific(size);
}

async function magnificRequest(path, options = {}, deps = {}) {
  const key = apiKey();
  if (!key && !deps.fetch) throw new ConfigurationError("MAGNIFIC_API_KEY is required to use Magnific.");
  const response = await (deps.fetch || fetch)(`${API}${path}`, {
    ...options,
    headers: { "x-magnific-api-key": key, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error && (data.error.message || data.error) || data.message || `Magnific request failed (${response.status}).`;
    const error = new Error(String(message));
    error.status = response.status;
    error.kind = response.status === 429 ? "rate_limit" : response.status === 402 ? "quota" : "request";
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return data.data || data;
}

async function waitForTask(path, taskId, deps = {}) {
  const pause = deps.sleep || sleep;
  for (let attempt = 0; attempt < (deps.maxPolls || MAX_POLLS); attempt += 1) {
    const task = await magnificRequest(`${path}/${encodeURIComponent(taskId)}`, { method: "GET" }, deps);
    const status = String(task.status || "").toUpperCase();
    if (status === "COMPLETED") {
      const images = (task.generated || []).filter(Boolean).map((url) => ({ url, revisedPrompt: null }));
      if (!images.length) throw new Error("Magnific completed the task but returned no image.");
      return { task, images };
    }
    if (["FAILED", "ERROR", "CANCELLED", "REJECTED"].includes(status)) {
      throw new Error(task.error || task.message || `Magnific task ${status.toLowerCase()}.`);
    }
    await pause(POLL_MS);
  }
  throw new Error("Magnific is still processing after twelve minutes. The task remains visible in Magnific.");
}

async function generateWithMystic(request, deps = {}) {
  if (Number(request.count || 1) !== 1) throw new Error("Magnific Mystic currently supports one take per request in Visual Studio.");
  const references = [];
  for (const reference of (request.references || []).slice(0, 2)) references.push(await referenceForProvider(reference, deps));
  const structure = references.find((r) => !/style|lighting|colour|color/i.test(r.role || "")) || references[0];
  const style = references.find((r) => /style|lighting|colour|color/i.test(r.role || "") && r !== structure);
  const body = {
    prompt: promptForShape(request.prompt, request.size),
    resolution: request.quality === "final" ? "2k" : "1k",
    aspect_ratio: aspectRatio(request.size),
    model: request.magnificModel || "realism",
    engine: "automatic",
    adherence: 65,
    hdr: 35,
    creative_detailing: 25,
    fixed_generation: Boolean(request.fixedGeneration),
    filter_nsfw: true,
  };
  if (structure && structure.data) {
    body.structure_reference = Buffer.from(structure.data).toString("base64");
    body.structure_strength = 70;
  }
  if (style && style.data) body.style_reference = Buffer.from(style.data).toString("base64");
  const created = await magnificRequest("/mystic", { method: "POST", body: JSON.stringify(body) }, deps);
  if (!created.task_id) throw new Error("Magnific did not return a task id.");
  const completed = await waitForTask("/mystic", created.task_id, deps);
  return { provider: "magnific", model: `mystic/${body.model}`, taskId: created.task_id, images: completed.images };
}

async function enhanceWithPrecision(imageBuffer, deps = {}) {
  const path = "/image-upscaler-precision-v2";
  const created = await magnificRequest(path, {
    method: "POST",
    body: JSON.stringify({
      image: Buffer.from(imageBuffer).toString("base64"),
      sharpen: 7,
      smart_grain: 7,
      ultra_detail: 30,
      flavor: "photo",
      scale_factor: 2,
      filter_nsfw: true,
    }),
  }, deps);
  if (!created.task_id) throw new Error("Magnific did not return a task id.");
  const completed = await waitForTask(path, created.task_id, deps);
  return { provider: "magnific", model: "image-upscaler-precision-v2", taskId: created.task_id, images: completed.images };
}

module.exports = { apiKey, aspectRatio, magnificRequest, waitForTask, generateWithMystic, enhanceWithPrecision, POLL_MS, MAX_POLLS };
