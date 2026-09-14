// Netlify background worker. The browser receives 202 immediately and polls visual-job;
// progress and the final result survive refreshes because the job itself lives in Firebase.
"use strict";
const crypto = require("crypto");
const generation = require("./visual-generate");
const { checkAuthorization } = require("./lib/strategy/auth");
const { getVisualJob, updateVisualJob, verifyVisualJobSignature } = require("./lib/strategy/visual-jobs");
const { loadAsset, preserveGeneratedImages } = require("./lib/strategy/visual-assets");
const { enhanceWithPrecision } = require("./lib/strategy/magnific-provider");
const { recordGeneration } = require("./lib/strategy/visual-memory");
const { touchChat } = require("./lib/strategy/visual-chats");
const { recordApiUsage } = require("./lib/strategy/api-usage");

function internalCookie() {
  const credentials = process.env.BASIC_AUTH_CREDENTIALS || "";
  return `loona_auth=${crypto.createHash("sha256").update(credentials).digest("hex")}`;
}

exports.handler = async (event) => {
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, body: "Unauthorized" };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  if (!verifyVisualJobSignature(body.jobId, body.workerToken)) return { statusCode: 403, body: "Invalid job signature" };
  const job = await getVisualJob(String(body.jobId || ""));
  if (!job) return { statusCode: 404, body: "Generation job not found" };
  if (job.status !== "queued") return { statusCode: 202, body: "Already started" };
  const enhancing = job.request.operation === "magnific_precision";
  await updateVisualJob(job.id, { status: "running", progress: enhancing ? "Enhancing with Magnific" : `Generating with ${job.request.provider === "magnific" ? "Magnific" : "OpenAI"}` });
  try {
    let payload;
    if (enhancing) {
      const source = await loadAsset(job.request.sourceAssetKey);
      if (!source) throw new Error("The source image is no longer available.");
      const result = await enhanceWithPrecision(source.data);
      const images = await preserveGeneratedImages(result.images, {
        brandId: job.brandId, chatId: job.chatId, generationId: job.id,
      });
      const recorded = await recordGeneration(job.brandId, {
        id: job.id,
        chatId: job.chatId,
        prompt: job.request.prompt,
        provider: result.provider,
        model: result.model,
        operation: "magnific_precision",
        providerTaskId: result.taskId,
        actor: job.request.actor,
        actorId: job.request.actorId,
        actorEmail: job.request.actorEmail,
        actorVerified: job.request.actorVerified,
        images,
        quality: "final",
        parentGenerationId: job.request.sourceGenerationId,
        parentImageIndex: job.request.sourceImageIndex,
        suggestions: ["Compare this with the original at 100%", "Run the brand quality review", "Build a final social crop from this"],
      });
      await touchChat(job.chatId);
      payload = {
        id: recorded.id, brandId: job.brandId, chatId: job.chatId,
        prompt: job.request.prompt, provider: result.provider, model: result.model,
        operation: "magnific_precision", providerTaskId: result.taskId,
        actor: job.request.actor, images, quality: "final", createdAt: recorded.record.createdAt,
        parentGenerationId: job.request.sourceGenerationId,
        parentImageIndex: job.request.sourceImageIndex,
        suggestions: recorded.record.suggestions, pickedIndex: null, recorded: true,
      };
      await recordApiUsage({
        id: `visual-${job.id}`,
        userId: job.request.actorId, userEmail: job.request.actorEmail,
        userName: job.request.actor, identityVerified: job.request.actorVerified,
        provider: result.provider, model: result.model, feature: "visual_studio",
        operation: "magnific_precision", brandId: job.brandId, chatId: job.chatId,
        jobId: job.id, outputCount: images.length,
      });
    } else {
      const response = await generation.handler({
        httpMethod: "POST",
        headers: { cookie: internalCookie() },
        body: JSON.stringify(job.request),
      });
      payload = JSON.parse(response.body || "{}");
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(payload.error || "Image generation failed.");
    }
    await updateVisualJob(job.id, { status: "succeeded", progress: "Complete", result: payload });
  } catch (error) {
    await updateVisualJob(job.id, { status: "failed", progress: "Failed", error: error.message || "Image generation failed." });
    try {
      await recordApiUsage({
        id: `visual-${job.id}`, userId: job.request.actorId, userEmail: job.request.actorEmail,
        userName: job.request.actor, identityVerified: job.request.actorVerified,
        provider: job.request.provider, feature: "visual_studio", operation: job.request.operation,
        brandId: job.brandId, chatId: job.chatId, jobId: job.id, status: "failed", outputCount: 0,
      });
    } catch (usageError) { console.error("Could not record failed API usage:", usageError.message); }
  }
  return { statusCode: 202, body: "Accepted" };
};
