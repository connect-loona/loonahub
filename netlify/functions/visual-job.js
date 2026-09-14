"use strict";
const { checkAuthorization } = require("./lib/strategy/auth");
const { createVisualJob, getVisualJob, signVisualJob } = require("./lib/strategy/visual-jobs");
const { resolveVisualActor } = require("./lib/strategy/visual-actor");

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, value) => ({ statusCode, headers, body: JSON.stringify(value) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  const auth = checkAuthorization(event);
  if (!auth.ok) return reply(401, { error: "Unauthorized", reason: auth.reason });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  try {
    if (body.action === "create") {
      if (!String(body.request && body.request.prompt || "").trim()) return reply(400, { error: "A prompt is required." });
      const actor = await resolveVisualActor(event, body.actor || "Hub");
      const job = await createVisualJob(body.request || {}, actor);
      return reply(201, { job, workerToken: signVisualJob(job.id) });
    }
    if (body.action === "status") {
      const job = await getVisualJob(String(body.jobId || ""));
      return job ? reply(200, { job }) : reply(404, { error: "Generation job not found." });
    }
    return reply(400, { error: "Unknown action." });
  } catch (error) {
    return reply(error.notFound ? 404 : 502, { error: error.message || "Visual job failed." });
  }
};
