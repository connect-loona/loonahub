"use strict";
const { checkAuthorization } = require("../lib/strategy/auth");
const { createVisualJob, getVisualJob, signVisualJob, activeVisualJobsForChat } = require("../lib/strategy/visual-jobs");
const { resolveVisualActor, verifyVisualSession } = require("../lib/strategy/visual-actor");

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, value) => ({ statusCode, headers, body: JSON.stringify(value) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  const auth = checkAuthorization(event);
  if (!auth.ok && !(await verifyVisualSession(event))) return reply(401, { error: "Unauthorized", reason: auth.reason });
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
    // What is still running in this chat. Asked on open, so a refresh — or a phone locking its
    // screen mid-generation — reconnects to the round instead of losing it while the worker
    // carries on and the money is spent anyway.
    if (body.action === "active") {
      const jobs = await activeVisualJobsForChat(String(body.chatId || ""));
      // Each job comes back with its worker token, because a job can be found in "queued" —
      // created, but never started, because the tab that created it went away in the moment
      // between those two calls. Whoever finds it has to be able to start it, or it sits
      // queued for ever while the person waits for a round that is never coming.
      //
      // Handing the token back is no weaker than create, which hands out the same thing to the
      // same authenticated caller, and visual-generate-background ignores a second kick on a
      // job that is already running.
      return reply(200, { jobs: jobs.map((job) => ({ ...job, workerToken: signVisualJob(job.id) })) });
    }
    return reply(400, { error: "Unknown action." });
  } catch (error) {
    return reply(error.notFound ? 404 : 502, { error: error.message || "Visual job failed." });
  }
};
