// Netlify background worker. The browser receives 202 immediately and polls visual-job;
// progress and the final result survive refreshes because the job itself lives in Firebase.
"use strict";
const crypto = require("crypto");
const generation = require("./visual-generate");
const { checkAuthorization } = require("./lib/strategy/auth");
const { getVisualJob, updateVisualJob, verifyVisualJobSignature } = require("./lib/strategy/visual-jobs");

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
  await updateVisualJob(job.id, { status: "running", progress: "Generating with OpenAI" });
  try {
    const result = await generation.handler({
      httpMethod: "POST",
      headers: { cookie: internalCookie() },
      body: JSON.stringify(job.request),
    });
    const payload = JSON.parse(result.body || "{}");
    if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(payload.error || "Image generation failed.");
    await updateVisualJob(job.id, { status: "succeeded", progress: "Complete", result: payload });
  } catch (error) {
    await updateVisualJob(job.id, { status: "failed", progress: "Failed", error: error.message || "Image generation failed." });
  }
  return { statusCode: 202, body: "Accepted" };
};
