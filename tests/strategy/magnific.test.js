// Magnific as the second image provider.
//
// Everything here runs against an injected fetch: no key, no network, no credits spent. The
// thing being tested is the SHAPE — Magnific is an async job API, and every interesting
// failure in this integration is a timing or honesty failure rather than a wrong pixel.
//
// The one that matters most is the aspect ratio. A portrait asset quietly delivered as a
// square is the kind of mistake that reaches a client before anybody notices, so an unknown
// ratio has to fail loudly rather than fall back to something safe-looking.
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const {
  generateWithMagnific, submitTask, awaitTask, classifyMagnificFailure,
  resolveAspectRatio, resolveResolution, MAGNIFIC_BASE,
} = require(path.join(HUB, "netlify/functions/lib/strategy/magnific"));
const { listProviders, PROVIDERS } = require(path.join(HUB, "netlify/functions/lib/strategy/image-providers"));

function ok(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function bad(status, body) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// A fake Magnific: one POST creates a task, and the task reports IN_PROGRESS for a while
// before completing — which is the whole point of this provider.
function fakeMagnific({ pollsBeforeDone = 2, generated = ["https://cdn.magnific.test/a.png"], hasNsfw = [] } = {}) {
  const calls = { posts: [], gets: 0 };
  let polls = 0;
  return {
    calls,
    fetch: async (url, options = {}) => {
      if ((options.method || "GET") === "POST") {
        calls.posts.push({ url, headers: options.headers, body: JSON.parse(options.body) });
        return ok({ data: { task_id: `task-${calls.posts.length}`, status: "IN_PROGRESS" } });
      }
      calls.gets += 1;
      polls += 1;
      if (polls <= pollsBeforeDone) return ok({ data: { task_id: "task-1", status: "IN_PROGRESS" } });
      return ok({ data: { task_id: "task-1", status: "COMPLETED", generated, has_nsfw: hasNsfw } });
    },
  };
}

// Time is injected so a two-minute budget is exercised in microseconds.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

(async () => {
  process.env.MAGNIFIC_API_KEY = "test-key-not-real";

  // ---- It is a registered provider, not a special case bolted onto the endpoint ----
  check("Magnific is registered behind the same provider interface as OpenAI",
    Boolean(PROVIDERS.magnific && typeof PROVIDERS.magnific.generate === "function"), Object.keys(PROVIDERS));
  const listed = listProviders();
  check("and is listed as configured once the key is set",
    listed.some((p) => p.key === "magnific" && p.configured === true), listed);
  // Nothing above the provider layer should have to know one of them is slow — but the fact
  // that it IS has to be recorded somewhere a caller can check before calling it from a
  // request that has ten seconds to live.
  check("and is marked async, because it cannot be called from a synchronous request",
    PROVIDERS.magnific.async === true, PROVIDERS.magnific.async);

  // ---- The request Magnific actually receives ----
  const m = fakeMagnific();
  const clock = fakeClock();
  const result = await generateWithMagnific(
    { prompt: "Primio bottle on warm marble", size: "portrait", quality: "final", count: 1 },
    { fetch: m.fetch, ...clock },
  );
  const sent = m.calls.posts[0];
  check("the task goes to Mystic", sent.url === `${MAGNIFIC_BASE}/mystic`, sent.url);
  check("authenticated with Magnific's own header, not a bearer token",
    sent.headers["x-magnific-api-key"] === "test-key-not-real", Object.keys(sent.headers));
  check("the prompt is sent as typed", sent.body.prompt === "Primio bottle on warm marble", sent.body.prompt);
  check("Final maps to a higher resolution, not to a quality flag", sent.body.resolution === "2k", sent.body.resolution);
  check("Draft stays at the cheap tier", resolveResolution("draft") === "1k", resolveResolution("draft"));
  // Magnific's detailing is an opinion layered on top of the prompt, and Visual Studio already
  // spends a rewrite making the prompt say what it means.
  check("Magnific's own creative detailing is off unless asked for", sent.body.creative_detailing === 0, sent.body.creative_detailing);
  check("NSFW filtering is on at their end too", sent.body.filter_nsfw === true, sent.body.filter_nsfw);

  // ---- Waiting, which is the whole difference from OpenAI ----
  check("it polls until the task is finished rather than reading the first response", m.calls.gets === 3, m.calls.gets);
  check("and returns finished images in the shape every provider returns",
    result.provider === "magnific" && result.images.length === 1 && result.images[0].url === "https://cdn.magnific.test/a.png",
    result);

  // ---- Sizes: the failure that must never be quiet ----
  check("square maps to Magnific's own vocabulary", resolveAspectRatio("square") === "square_1_1", resolveAspectRatio("square"));
  let badRatio = null;
  try { resolveAspectRatio("banner"); } catch (e) { badRatio = e.message; }
  check("an unknown size is refused, never quietly delivered as a square",
    /Unknown size "banner"/.test(badRatio || ""), badRatio);

  // ---- Four takes are four tasks, run together ----
  const many = fakeMagnific({ pollsBeforeDone: 0 });
  await generateWithMagnific(
    { prompt: "four takes", size: "square", quality: "draft", count: 4 },
    { fetch: many.fetch, ...fakeClock() },
  );
  check("asking for four takes submits four tasks", many.calls.posts.length === 4, many.calls.posts.length);

  // ---- A task that never finishes ----
  // The job keeps running and keeps being paid for, so abandoning it without its id is what
  // turns a slow generation into a wasted one.
  const stuck = {
    fetch: async (url, options = {}) => ((options.method || "GET") === "POST"
      ? ok({ data: { task_id: "task-stuck", status: "IN_PROGRESS" } })
      : ok({ data: { task_id: "task-stuck", status: "IN_PROGRESS" } })),
  };
  let timedOut = null;
  try {
    await generateWithMagnific({ prompt: "slow", size: "square", quality: "draft", count: 1 },
      { fetch: stuck.fetch, ...fakeClock(), maxPollMs: 10000 });
  } catch (e) { timedOut = e; }
  check("giving up on a slow task is reported as still running, not as a failure",
    timedOut && timedOut.kind === "timeout", timedOut && timedOut.kind);
  check("and hands back the task id so the job isn't simply lost",
    timedOut && timedOut.taskId === "task-stuck", timedOut && timedOut.taskId);

  // ---- A task Magnific itself gave up on ----
  const failed = {
    fetch: async (url, options = {}) => ((options.method || "GET") === "POST"
      ? ok({ data: { task_id: "task-bad", status: "IN_PROGRESS" } })
      : ok({ data: { task_id: "task-bad", status: "FAILED" } })),
  };
  let providerFailed = null;
  try { await awaitTask("task-bad", { fetch: failed.fetch, ...fakeClock() }); } catch (e) { providerFailed = e; }
  check("a failed task stops immediately rather than polling out the whole budget",
    providerFailed && /could not finish/.test(providerFailed.message), providerFailed && providerFailed.message);
  check("and is not retried, because it already ran", providerFailed && providerFailed.retryable === false,
    providerFailed && providerFailed.retryable);

  // ---- NSFW ----
  const flagged = fakeMagnific({ pollsBeforeDone: 0, generated: ["https://cdn.magnific.test/x.png"], hasNsfw: [true] });
  let nothingUsable = null;
  try {
    await generateWithMagnific({ prompt: "x", size: "square", quality: "draft", count: 1 },
      { fetch: flagged.fetch, ...fakeClock() });
  } catch (e) { nothingUsable = e.message; }
  // There is no version of a client brand chat where rendering it with a warning is better.
  check("a flagged image is dropped rather than shown with a caveat",
    /no usable images/.test(nothingUsable || ""), nothingUsable);

  // ---- Failures, told apart ----
  // The same three-way split the OpenAI side makes: a burst limit is worth one retry, running
  // out of credit never is, and a bad key is a configuration problem rather than a bad request.
  check("a rejected key is named as a key problem, with where to fix it",
    classifyMagnificFailure(401, "").kind === "auth" && /MAGNIFIC_API_KEY/.test(classifyMagnificFailure(401, "").message),
    classifyMagnificFailure(401, ""));
  check("running out of credit is never retried", classifyMagnificFailure(402, "").retryable === false,
    classifyMagnificFailure(402, ""));
  check("and says plainly that waiting won't help",
    /top(ped)? up/.test(classifyMagnificFailure(402, "").message), classifyMagnificFailure(402, "").message);
  check("a burst limit is retryable", classifyMagnificFailure(429, "").retryable === true, classifyMagnificFailure(429, ""));
  check("so is a problem at their end", classifyMagnificFailure(503, "").retryable === true, classifyMagnificFailure(503, ""));

  let rejected = null;
  try { await submitTask({ prompt: "x", size: "square", quality: "draft" }, { fetch: async () => bad(401, { message: "bad key" }) }); }
  catch (e) { rejected = e; }
  check("and a rejected submission carries that verdict out of the provider",
    rejected && rejected.kind === "auth" && rejected.retryable === false, rejected && rejected.kind);

  // ---- No key ----
  delete process.env.MAGNIFIC_API_KEY;
  let noKey = null;
  try { await generateWithMagnific({ prompt: "x", size: "square", quality: "draft" }, { fetch: async () => ok({}) }); }
  catch (e) { noKey = e.message; }
  check("with no key it says which variable is missing and where it goes",
    /MAGNIFIC_API_KEY/.test(noKey || "") && /Netlify/.test(noKey || ""), noKey);
  check("and Magnific is not offered as configured",
    listProviders().some((p) => p.key === "magnific" && p.configured === false), listProviders());

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
