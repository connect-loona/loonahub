// Magnific (formerly Freepik) as Visual Studio's second image provider.
//
// The important difference from OpenAI is not quality — it is SHAPE. OpenAI hands back the
// finished image on the same request. Magnific is an async job API: the POST returns a
// task_id and nothing else, and the image exists somewhere between 10 and 90 seconds later
// depending on resolution. That is why image-providers.js was written to return finished
// images rather than to stream, and why a provider is allowed to be slow — this is the
// provider that needed it.
//
// WHAT THIS MEANS FOR WHERE IT CAN BE CALLED FROM, stated plainly because getting it wrong
// produces a timeout nobody can diagnose: a synchronous Netlify function has roughly ten
// seconds. Magnific's FASTEST tier does not finish in ten seconds. So this provider only
// works from somewhere with real time — a background function or job worker. Called from the
// synchronous path it will do exactly what it should: run out of budget and say so.
//
// Polling rather than webhooks, deliberately. Magnific offers a webhook_url, but a webhook
// needs a public callback endpoint and a shared signing secret to verify it — a second moving
// part, and a second secret to leak. Polling a task_id costs one cheap GET every couple of
// seconds inside a worker that is already waiting, and it needs no secret at all.
"use strict";
const { ConfigurationError } = require("./errors");

const MAGNIFIC_BASE = "https://api.magnific.com/v1/ai";
// Mystic is Magnific's text-to-image model. The upscaler and relight endpoints live beside it
// on the same async task contract, which is why the polling below is written against the
// contract rather than against this one path.
const MYSTIC_PATH = "/mystic";

// How long to keep asking. 4K legitimately takes up to about 90 seconds, so a budget much
// under two minutes would abandon jobs that were going to succeed. It is a budget, not a
// timeout on the job itself: the task keeps running at Magnific's end and its id is returned
// with the error, so a slow one can still be collected rather than silently paid for and lost.
const MAX_POLL_MS = 120000;
const POLL_INTERVAL_MS = 2000;

// Magnific counts a task as terminal in more than one way, and "we stopped early" has to stay
// distinguishable from "it failed".
const DONE = "COMPLETED";
const FAILED = new Set(["FAILED", "ERROR", "CANCELLED", "TIMEOUT"]);

function magnificApiKey() {
  return process.env.MAGNIFIC_API_KEY || "";
}

// Visual Studio names sizes for what they are for, not in pixels (see image-providers.js's
// SIZES). Magnific names them differently again, so the translation lives here rather than
// leaking Magnific's vocabulary into the composer.
//
// Only square_1_1 is confirmed against the published reference. The other two are the obvious
// spellings of the same convention, and an aspect ratio Magnific rejects comes back as a 400
// naming the value we sent — which is the right failure: loud, and pointing at the line to fix.
// It is NOT silently downgraded to a square, because a portrait asset quietly delivered square
// is the kind of thing that reaches a client before anyone notices.
const ASPECT_RATIOS = {
  square: "square_1_1",
  portrait: "social_story_9_16",
  landscape: "widescreen_16_9",
};

// Draft and Final mean the same thing here as they do for OpenAI — explore cheap, finish
// properly — but they map to resolution rather than to a quality flag. 4K is deliberately not
// wired to Final: it is the slowest tier by a wide margin and 2K is already past what any
// social asset needs.
const RESOLUTIONS = { draft: "1k", final: "2k" };

function resolveAspectRatio(size) {
  const ratio = ASPECT_RATIOS[size || "square"];
  if (!ratio) throw new Error(`Unknown size "${size}". Use one of: ${Object.keys(ASPECT_RATIOS).join(", ")}.`);
  return ratio;
}

function resolveResolution(quality) {
  return RESOLUTIONS[quality === "final" ? "final" : "draft"];
}

// The same three-way split the OpenAI side makes, for the same reason: a burst limit clears on
// its own and is worth one automatic retry, running out of credit never clears and retrying
// just delays the news, and a bad key is a configuration problem rather than a failed request.
function classifyMagnificFailure(status, detail) {
  const text = String(detail || "");
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      retryable: false,
      message: "Magnific rejected the API key. Check MAGNIFIC_API_KEY in Netlify.",
    };
  }
  if (status === 402 || /insufficient|no credits|quota|balance/i.test(text)) {
    return {
      kind: "quota",
      retryable: false,
      message: "The Magnific account is out of credits. Generating again won't help until it's topped up.",
    };
  }
  if (status === 429) {
    return { kind: "rate_limit", retryable: true, message: "Magnific is rate limiting us. Trying once more." };
  }
  if (status >= 500) {
    return { kind: "upstream", retryable: true, message: "Magnific had a problem at their end. Trying once more." };
  }
  return { kind: "request", retryable: false, message: null };
}

async function magnificFailure(response, what) {
  const detail = await response.text().catch(() => "");
  const verdict = classifyMagnificFailure(response.status, detail);
  // The person gets the plain-English version; the provider's own words still reach the
  // function logs, so diagnosing this later isn't limited to what we chose to paraphrase.
  console.error(`Magnific ${what} failed (${response.status}) [${verdict.kind}]:`, detail.slice(0, 600));
  const error = new Error(verdict.message || `Magnific ${what} failed (${response.status}). ${detail.slice(0, 400)}`);
  error.status = response.status;
  error.kind = verdict.kind;
  error.retryable = verdict.retryable;
  return error;
}

function headers() {
  return { "x-magnific-api-key": magnificApiKey(), "Content-Type": "application/json" };
}

// Magnific wraps everything in `data`. Reading it in one place means a response shape that
// drifts breaks here, once, rather than in three call sites.
function unwrap(payload) {
  return (payload && payload.data) || payload || {};
}

async function submitTask(request, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const response = await doFetch(`${MAGNIFIC_BASE}${MYSTIC_PATH}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      prompt: request.prompt,
      aspect_ratio: resolveAspectRatio(request.size),
      resolution: resolveResolution(request.quality),
      // Off by default: Magnific's own detailing is an opinion applied on top of the prompt,
      // and Visual Studio already spends a rewrite making the prompt say what it means.
      creative_detailing: Number.isFinite(request.creativeDetailing) ? request.creativeDetailing : 0,
      filter_nsfw: true,
    }),
  });
  if (!response.ok) throw await magnificFailure(response, "generation");
  const data = unwrap(await response.json());
  if (!data.task_id) throw new Error("Magnific accepted the request but returned no task id.");
  return { taskId: data.task_id, status: data.status || "IN_PROGRESS" };
}

async function readTask(taskId, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const response = await doFetch(`${MAGNIFIC_BASE}${MYSTIC_PATH}/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: headers(),
  });
  if (!response.ok) throw await magnificFailure(response, "status check");
  return unwrap(await response.json());
}

// Waits for one task to finish. deps.sleep and deps.now are injected by tests so the whole
// wait is exercisable in milliseconds without a network or a key.
async function awaitTask(taskId, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());
  const deadline = now() + (deps.maxPollMs || MAX_POLL_MS);

  for (;;) {
    const task = await readTask(taskId, deps);
    const status = String(task.status || "").toUpperCase();
    if (status === DONE) return task;
    if (FAILED.has(status)) {
      const error = new Error(`Magnific could not finish this image (${status.toLowerCase()}).`);
      error.kind = "provider";
      error.retryable = false;
      throw error;
    }
    if (now() >= deadline) {
      // The task id travels with the error on purpose. The job is still running and still
      // being paid for; losing its id is what turns a slow generation into a wasted one.
      const error = new Error(
        `Magnific is still working after ${Math.round((deps.maxPollMs || MAX_POLL_MS) / 1000)}s. `
        + `The job (${taskId}) is still running at their end.`,
      );
      error.kind = "timeout";
      error.retryable = false;
      error.taskId = taskId;
      throw error;
    }
    await sleep(deps.pollIntervalMs || POLL_INTERVAL_MS);
  }
}

async function generateWithMagnific(request, deps = {}) {
  if (!magnificApiKey()) {
    throw new ConfigurationError("MAGNIFIC_API_KEY is not set. Add it in Netlify to generate with Magnific.");
  }
  // Magnific's Mystic endpoint makes one image per task. Asking for four takes means four
  // tasks, run together rather than in sequence — otherwise four 20-second jobs become an
  // 80-second wait for something a person is about to reject three quarters of.
  const count = Math.min(Math.max(Number(request.count) || 1, 1), 4);
  const tasks = await Promise.all(
    Array.from({ length: count }, () => submitTask(request, deps).then(({ taskId }) => awaitTask(taskId, deps))),
  );

  const images = [];
  for (const task of tasks) {
    const urls = Array.isArray(task.generated) ? task.generated : [];
    const flags = Array.isArray(task.has_nsfw) ? task.has_nsfw : [];
    urls.forEach((url, index) => {
      if (!url) return;
      // Magnific filters at their end; this is the second line. A flagged image is dropped
      // rather than shown with a warning, because there is no version of a client brand chat
      // where rendering it and captioning it is the better outcome.
      if (flags[index] === true) return;
      images.push({ url, revisedPrompt: null });
    });
  }

  if (!images.length) throw new Error("Magnific returned no usable images.");
  return { provider: "magnific", model: "mystic", images };
}

module.exports = {
  generateWithMagnific, submitTask, readTask, awaitTask, classifyMagnificFailure,
  resolveAspectRatio, resolveResolution, magnificApiKey,
  MAGNIFIC_BASE, MYSTIC_PATH, ASPECT_RATIOS, RESOLUTIONS, MAX_POLL_MS, POLL_INTERVAL_MS,
};
