// Visual Studio: image generation, and the memory it leaves behind.
//
// The deliberate design decision this is written around is that Visual Studio does NOT host
// images. The team keeps saving finals into the brand's Drive folder by hand, as they do
// today. What Visual Studio captures instead is everything around the image — the prompt
// somebody actually typed, which model made it, how many takes it took, and which take they
// chose. That's the part nobody ever writes down, and the part that says how this brand is
// really being made.
//
// Two consequences drive most of the checks below. Provider URLs expire (OpenAI's in about an
// hour), so a record has to keep the prompt forever and the preview only while it lasts, and
// say which it is rather than rendering a broken image and calling it history. And only PICKED
// rounds are worth teaching an agent — feeding it every abandoned attempt would teach it the
// opposite of taste.
//
// No key, no network: fetch is injected.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const {
  recordGeneration, recordPick, loadVisualHistory, visualHistoryToPromptText,
  isPreviewLive, PREVIEW_TTL_MS,
} = require(path.join(HUB, "netlify/functions/lib/strategy/visual-memory"));
const {
  generateImages, resolveSize, resolveQuality, listProviders, decodeDataUrl, classifyOpenAIFailure, QUALITY_MODES,
  MAX_IMAGES, MAX_REFERENCES, MAX_REFERENCE_BYTES, DEFAULT_OPENAI_DRAFT_MODEL, DEFAULT_OPENAI_EDIT_MODEL,
} = require(path.join(HUB, "netlify/functions/lib/strategy/image-providers"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;
const generate = require(path.join(HUB, "netlify/functions/_legacy/visual-generate.js"));
const pick = require(path.join(HUB, "netlify/functions/_legacy/visual-pick.js"));

function call(fn, body, headers) {
  return fn.handler({
    httpMethod: "POST",
    headers: Object.assign({ cookie: authCookie, host: "127.0.0.1:9020", "x-forwarded-proto": "http" }, headers || {}),
    body: JSON.stringify(body),
  });
}

function okFetch(payload) {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_visual.json`, null);
  await req("PUT", `${RTDB_URL}/brands.json`, { rro: { brand: "RRO Foods" } });

  // ---- resolveSize returns what to GENERATE at, not the final shape ----
  // gpt-image-1 accepts exactly three sizes, so a 4:5 or 9:16 request generates at the nearest
  // one and is cropped afterwards (see image-shapes.test.js). This function is only the first
  // half of that; it answers "what do we ask OpenAI for", never "what shape comes out".
  check("a shape resolves to the nearest size OpenAI can actually produce",
    resolveSize("9x16") === "1024x1536", resolveSize("9x16"));
  check("a legacy stored key still resolves, so old chats re-render",
    resolveSize("portrait") === "1024x1536", resolveSize("portrait"));
  check("no size means the app's default shape, 4:5", resolveSize() === "1024x1536", resolveSize());
  // This used to let a raw WIDTHxHEIGHT through, on the reasoning that the UI could then add
  // presets without a backend change. It couldn't: OpenAI rejects anything outside its three
  // sizes, so that escape hatch turned a new preset into a 400 rather than a new shape.
  let rawError = null;
  try { resolveSize("1200x628"); } catch (e) { rawError = e.message; }
  check("a raw WxH is refused, because OpenAI would refuse it too", Boolean(rawError), rawError);
  let sizeError = null;
  try { resolveSize("enormous"); } catch (e) { sizeError = e.message; }
  check("a nonsense size fails loudly instead of silently becoming a square",
    /Unknown image shape/.test(sizeError || ""), sizeError);

  // ---- The provider layer ----
  const providers = listProviders();
  check("OpenAI is offered as a provider", providers.some((p) => p.key === "openai"), providers);

  // gpt-image-1 returns base64; dall-e-3 returns a URL. Both have to work — assuming one
  // shape is exactly how this breaks the first time somebody switches model.
  const b64 = await generateImages({ prompt: "a bottle on marble", count: 1 },
    { fetch: okFetch({ data: [{ b64_json: "AAAA", revised_prompt: "a glass bottle on marble" }] }) });
  check("a base64 image comes back as a usable data URL", /^data:image\/[a-z]+;base64,AAAA/.test(b64.images[0].url), b64.images[0].url);
  check("the provider's revised prompt is kept", b64.images[0].revisedPrompt === "a glass bottle on marble", b64.images[0]);

  const urlShape = await generateImages({ prompt: "x", count: 1 },
    { fetch: okFetch({ data: [{ url: "https://example.com/a.png" }] }) });
  check("a URL image works too", urlShape.images[0].url === "https://example.com/a.png", urlShape.images[0]);

  let emptyError = null;
  try { await generateImages({ prompt: "x" }, { fetch: okFetch({ data: [] }) }); }
  catch (e) { emptyError = e.message; }
  check("a response with no images is an error, not an empty success", /no usable images/.test(emptyError || ""), emptyError);

  // A recognised billing failure is translated into something a designer can act on, rather
  // than echoing "billing_hard_limit_reached" — which is precisely as useless on screen as the
  // opaque "generation failed" it replaced. The raw text still reaches the function logs.
  let billingError = null;
  try {
    await generateImages({ prompt: "x" }, {
      fetch: async () => ({ ok: false, status: 400, text: async () => "billing_hard_limit_reached" }),
      sleep: async () => {},
    });
  } catch (e) { billingError = e; }
  check("a billing failure is named as one", billingError.kind === "quota", billingError.kind);
  check("and says what actually has to happen", /top it up/.test(billingError.message), billingError.message);

  // An UNRECOGNISED failure still carries the provider's own words, because inventing advice
  // for something we haven't classified would be worse than quoting it.
  let oddError = null;
  try {
    await generateImages({ prompt: "x" }, {
      fetch: async () => ({ ok: false, status: 422, text: async () => "moderation_blocked: prompt rejected" }),
      sleep: async () => {},
    });
  } catch (e) { oddError = e.message; }
  check("an unclassified failure still carries the provider's own text",
    /moderation_blocked/.test(oddError || ""), oddError);

  let noPrompt = null;
  try { await generateImages({ prompt: "   " }, { fetch: okFetch({ data: [] }) }); } catch (e) { noPrompt = e.message; }
  check("an empty prompt is refused before any call is made", /prompt is required/.test(noPrompt || ""), noPrompt);

  // ---- References: the thing that makes this usable rather than a novelty ----
  // Every real ChatGPT thread this replaces starts by uploading a reference. Text-to-image
  // alone can't do "keep this exact label, change the background", because there's no way to
  // hand it the thing that must stay identical.
  const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const decoded = decodeDataUrl(PIXEL, 0);
  check("a data URL is decoded to real bytes", decoded.bytes.length > 0 && decoded.mediaType === "image/png", decoded.mediaType);
  check("the filename carries a sane extension", /\.png$/.test(decoded.filename), decoded.filename);
  check("a jpeg keeps a jpg extension rather than 'jpeg'",
    /\.jpg$/.test(decodeDataUrl("data:image/jpeg;base64,AAAA", 0).filename), decodeDataUrl("data:image/jpeg;base64,AAAA", 0).filename);

  let notAnImage = null;
  try { decodeDataUrl("data:application/pdf;base64,AAAA", 0); } catch (e) { notAnImage = e.message; }
  check("a non-image reference is refused with what it actually was", /not an image/.test(notAnImage || ""), notAnImage);

  let notADataUrl = null;
  try { decodeDataUrl("https://example.com/a.png", 1); } catch (e) { notADataUrl = e.message; }
  check("a bare URL is not accepted as a reference", /Reference 2 is not a readable image/.test(notADataUrl || ""), notADataUrl);

  // Caught before the upload rather than as an opaque 502 halfway through: a Netlify function
  // has a hard request ceiling, and a 10MB photo would blow straight past it.
  let tooBig = null;
  const huge = `data:image/png;base64,${"A".repeat(Math.ceil((MAX_REFERENCE_BYTES + 1024) / 3) * 4)}`;
  try { decodeDataUrl(huge, 0); } catch (e) { tooBig = e.message; }
  check("an oversized reference is refused with its real size and the limit",
    /MB — the limit is/.test(tooBig || ""), tooBig);

  // With references this must hit the EDIT endpoint, not generations — a different URL, and
  // multipart rather than JSON. Pinned to gpt-image-1 explicitly: this is testing what that
  // model needs (the edits endpoint, multipart, input_fidelity), not what the default happens
  // to be today — see the model-selection block below for that.
  let editCall = null;
  const edited = await generateImages(
    { prompt: "keep the bottle, warmer table", count: 2, model: "gpt-image-1", references: [{ dataUrl: PIXEL, role: "Product identity" }] },
    { fetch: async (url, options) => { editCall = { url, options }; return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) }; } },
  );
  check("a round with references goes to the edits endpoint", /\/images\/edits$/.test(editCall.url), editCall.url);
  check("and sends multipart form data, not JSON", editCall.options.body instanceof FormData, typeof editCall.options.body);
  check("the content-type is left to fetch so the multipart boundary is right",
    !Object.keys(editCall.options.headers).some((h) => /content-type/i.test(h)), Object.keys(editCall.options.headers));
  check("the reference is attached under image[] — how gpt-image-1 takes more than one",
    editCall.options.body.getAll("image[]").length === 1, editCall.options.body.getAll("image[]").length);
  check("reference edits use high input fidelity on gpt-image-1",
    editCall.options.body.get("input_fidelity") === "high", editCall.options.body.get("input_fidelity"));
  // The person's words lead; the shape note is appended to the prompt SENT, never to the one
  // stored. The model has to know a crop is coming or it composes into edges that get trimmed.
  check("the prompt travels with it", editCall.options.body.get("prompt").startsWith("keep the bottle, warmer table"),
    editCall.options.body.get("prompt"));
  check("and carries the crop the image will be trimmed to",
    /cropped to exactly \d+:\d+/.test(editCall.options.body.get("prompt")), editCall.options.body.get("prompt"));
  check("an edit still returns usable images", edited.images.length === 1 && /^data:image\/[a-z]+;base64,/.test(edited.images[0].url), edited.images[0].url.slice(0, 40));

  // Without references it must stay on the plain generations endpoint.
  let plainCall = null;
  await generateImages({ prompt: "a bottle", count: 1 },
    { fetch: async (url, options) => { plainCall = { url, options }; return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://x/a.png" }] }) }; } });
  check("a round with no references stays on the generations endpoint", /\/images\/generations$/.test(plainCall.url), plainCall.url);

  // ---- Which real model answers, when nothing pins one ----
  // OpenAI positions these the same way this app already splits its own endpoints: Sunburst
  // for "premium visual workflows that benefit from tighter control across edits", Flare as
  // the fast default otherwise. references.length is exactly that split already being made —
  // this just stops throwing the distinction away once it's decided.
  check("a fresh generation with no reference defaults to the fast model",
    JSON.parse(plainCall.options.body).model === DEFAULT_OPENAI_DRAFT_MODEL, JSON.parse(plainCall.options.body).model);

  let defaultEditCall = null;
  await generateImages(
    { prompt: "x", references: [{ dataUrl: PIXEL }] },
    { fetch: async (url, options) => { defaultEditCall = { url, options }; return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QQ==" }] }) }; } },
  );
  check("an edit with no pinned model defaults to the precision one",
    defaultEditCall.options.body.get("model") === DEFAULT_OPENAI_EDIT_MODEL, defaultEditCall.options.body.get("model"));
  // input_fidelity is a gpt-image-1 knob; the 2.5 line describes fidelity as built in rather
  // than a separate switch, and sending a parameter a model doesn't expect risks a 400. So the
  // new default must NOT carry it, even though the model="gpt-image-1" case above does.
  check("but does not send gpt-image-1's input_fidelity switch to it",
    defaultEditCall.options.body.get("input_fidelity") === null, defaultEditCall.options.body.get("input_fidelity"));

  // An explicit model still wins for a controlled experiment. A legacy global
  // VISUAL_OPENAI_MODEL setting must not be able to force production back to gpt-image-1.
  let pinnedCall = null;
  await generateImages({ prompt: "x", model: "gpt-image-1", references: [{ dataUrl: PIXEL }] },
    { fetch: async (url, options) => { pinnedCall = { url, options }; return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QQ==" }] }) }; } });
  check("an explicit model on an edit overrides the new default",
    pinnedCall.options.body.get("model") === "gpt-image-1", pinnedCall.options.body.get("model"));

  process.env.VISUAL_OPENAI_MODEL = "gpt-image-1";
  let legacyEnvCall = null;
  await generateImages({ prompt: "x", count: 1 },
    { fetch: async (url, options) => { legacyEnvCall = { url, options }; return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://x/a.png" }] }) }; } });
  check("a legacy global model setting cannot override the modern production default",
    JSON.parse(legacyEnvCall.options.body).model === DEFAULT_OPENAI_DRAFT_MODEL, JSON.parse(legacyEnvCall.options.body).model);
  delete process.env.VISUAL_OPENAI_MODEL;

  process.env.VISUAL_OPENAI_DRAFT_MODEL = "gpt-image-2.5-sunburst";
  let draftEnvCall = null;
  await generateImages({ prompt: "x", count: 1 },
    { fetch: async (url, options) => { draftEnvCall = { url, options }; return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://x/a.png" }] }) }; } });
  check("the draft model can be explicitly configured without a global override",
    JSON.parse(draftEnvCall.options.body).model === "gpt-image-2.5-sunburst", JSON.parse(draftEnvCall.options.body).model);
  delete process.env.VISUAL_OPENAI_DRAFT_MODEL;

  let tooManyRefs = null;
  try {
    await generateImages({ prompt: "x", references: new Array(MAX_REFERENCES + 1).fill({ dataUrl: PIXEL }) },
      { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
  } catch (e) { tooManyRefs = e.message; }
  check("more references than the cap is refused", new RegExp(`Up to ${MAX_REFERENCES} reference`).test(tooManyRefs || ""), tooManyRefs);

  // ---- Draft vs Final ----
  // Generating four takes at production quality while somebody is still deciding what they
  // want is how this becomes expensive and slow at the same time. Cost and latency both climb
  // with quality, so exploring has to be cheap by default.
  check("draft is the default, not final", resolveQuality().quality === QUALITY_MODES.draft.quality, resolveQuality());
  check("draft is cheaper and faster than final",
    QUALITY_MODES.draft.quality === "medium" && QUALITY_MODES.final.quality === "high", QUALITY_MODES);
  // Nobody colour-grades a thumbnail they're about to throw away; the one that goes into
  // Photoshop is the one that needs to be lossless.
  check("draft returns JPEG for speed, final returns PNG for the file that gets worked on",
    QUALITY_MODES.draft.output_format === "jpeg" && QUALITY_MODES.final.output_format === "png", QUALITY_MODES);

  let badQuality = null;
  try { resolveQuality("ultra"); } catch (e) { badQuality = e.message; }
  check("an unknown quality mode fails loudly rather than silently costing production rates",
    /Unknown quality mode/.test(badQuality || ""), badQuality);

  let qualityCall = null;
  await generateImages({ prompt: "x", count: 1, quality: "final" },
    { fetch: async (url, options) => { qualityCall = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) }; } });
  check("the chosen quality reaches the provider", qualityCall.quality === "high", qualityCall.quality);
  check("and so does the output format", qualityCall.output_format === "png", qualityCall.output_format);

  // A JPEG labelled as a PNG produces a data URL some browsers refuse to render.
  const draftShot = await generateImages({ prompt: "x", count: 1, quality: "draft" },
    { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) }) });
  check("a draft's data URL is labelled as the JPEG it actually is",
    draftShot.images[0].url.startsWith("data:image/jpeg;base64,"), draftShot.images[0].url.slice(0, 30));

  let editQuality = null;
  await generateImages({ prompt: "x", count: 1, quality: "final", references: [{ dataUrl: PIXEL }] },
    { fetch: async (url, options) => { editQuality = options.body; return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) }; } });
  check("quality applies to edits as well as fresh generations",
    editQuality.get("quality") === "high" && editQuality.get("output_format") === "png",
    { quality: editQuality.get("quality"), format: editQuality.get("output_format") });

  // ---- Hitting a limit: two different things wearing the same 429 ----
  // This is the question the team will actually ask, having hit ChatGPT's "come back in three
  // hours" wall. The API has no such cooldown: a 429 is either a burst (clears in seconds) or
  // an empty account (never clears). Telling them apart is the whole point.
  const burst = classifyOpenAIFailure(429, '{"error":{"message":"Rate limit reached for images per min","type":"requests"}}');
  check("a burst rate limit is marked retryable", burst.kind === "rate_limit" && burst.retryable === true, burst.kind);
  check("and says waiting is the fix", /Wait a few seconds/.test(burst.message), burst.message);
  check("and suggests the lever that actually helps — fewer takes", /fewer takes/.test(burst.message), burst.message);

  const broke = classifyOpenAIFailure(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}');
  check("running out of credit is NOT treated as retryable", broke.kind === "quota" && broke.retryable === false, broke.kind);
  // Telling somebody to wait when the account is empty sends them back in ten minutes to the
  // same wall. It has to say the opposite.
  check("and says plainly that waiting will not help", /Waiting won't help/.test(broke.message), broke.message);

  const down = classifyOpenAIFailure(503, "service unavailable");
  check("a provider outage is retryable too", down.kind === "provider_down" && down.retryable === true, down.kind);

  const badRequest = classifyOpenAIFailure(400, '{"error":{"message":"Invalid prompt"}}');
  check("an ordinary bad request is not retried", badRequest.retryable === false, badRequest.kind);
  check("and keeps the provider's own words rather than inventing advice", badRequest.message === null, badRequest.message);

  // One automatic retry on a burst, because the person already waited through attempt one.
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) return { ok: false, status: 429, text: async () => "Rate limit reached for images per min" };
    return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://x/ok.png" }] }) };
  };
  const recovered = await generateImages({ prompt: "x", count: 1 }, { fetch: flaky, sleep: async () => {} });
  check("a burst limit is absorbed by one automatic retry", attempts === 2 && recovered.images.length === 1, attempts);

  // ...but never for an empty account, where retrying only delays the bad news.
  let quotaAttempts = 0;
  let quotaError = null;
  try {
    await generateImages({ prompt: "x", count: 1 }, {
      fetch: async () => { quotaAttempts += 1; return { ok: false, status: 429, text: async () => "insufficient_quota" }; },
      sleep: async () => {},
    });
  } catch (e) { quotaError = e; }
  check("an out-of-credit failure is not retried at all", quotaAttempts === 1, quotaAttempts);
  check("and surfaces as a quota problem", quotaError && quotaError.kind === "quota", quotaError && quotaError.kind);

  // Twice in a row is not a blip — stop rather than looping on the person's time.
  let persistent = 0;
  let persistentError = null;
  try {
    await generateImages({ prompt: "x", count: 1 }, {
      fetch: async () => { persistent += 1; return { ok: false, status: 429, text: async () => "Rate limit reached" }; },
      sleep: async () => {},
    });
  } catch (e) { persistentError = e; }
  check("a rate limit that persists is retried once and then reported, not looped",
    persistent === 2 && persistentError.kind === "rate_limit", persistent);

  // ---- recordGeneration: written before anybody picks ----
  const { id } = await recordGeneration("rro", {
    prompt: "Primio bottle on a marble counter, warm morning light",
    provider: "openai", model: "gpt-image-1", actor: "Anjali", size: "9x16",
    referenceCount: 2, referenceNote: "kept the label exactly",
    images: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }],
  });
  check("a generation is recorded and gets an id", Boolean(id), id);
  const stored = await fbGet(`strategy_visual/rro/${id}`);
  check("the prompt is kept", /marble counter/.test(stored.prompt), stored.prompt);
  check("who made it is kept", stored.actor === "Anjali", stored.actor);
  check("what they started from is kept", stored.referenceCount === 2 && /kept the label/.test(stored.referenceNote), stored);
  check("an unpicked round is recorded anyway — a rejected attempt is still evidence",
    stored.pickedIndex === null, stored.pickedIndex);
  // The shape a round was made at, so a follow-up can read it back and ask for the same one —
  // never stored before this, so a designer had no way to continue in the same shape except
  // remembering to reselect it every single round.
  check("the shape it was made at is kept", stored.size === "9x16", stored.size);
  // A brand nobody else touches in this file, deliberately: "rro" is used below by tests that
  // assume its history holds exactly one record in a known order (see the preview-expiry
  // block), and a second record here would silently break that ordering rather than this check.
  const noShapeGiven = await recordGeneration("rro-shapeless-test", { prompt: "x", provider: "openai", actor: "A", images: [] });
  check("a round recorded with no shape stores null, not undefined or a guess",
    (await fbGet(`strategy_visual/rro-shapeless-test/${noShapeGiven.id}`)).size === null,
    (await fbGet(`strategy_visual/rro-shapeless-test/${noShapeGiven.id}`)).size);

  // ---- recordPick: the signal worth the most ----
  const picked = await recordPick("rro", id, { index: 1, actor: "Gokul", note: "cleaner label read" });
  check("the chosen take is recorded", picked.pickedIndex === 1, picked.pickedIndex);
  check("who chose it is recorded", picked.pickedBy === "Gokul", picked.pickedBy);
  check("why they chose it is recorded", /cleaner label read/.test(picked.pickNote), picked.pickNote);

  let missing = null;
  try { await recordPick("rro", "nope", { index: 0 }); } catch (e) { missing = e.message; }
  check("picking a generation that doesn't exist is an error", /No generation/.test(missing || ""), missing);

  // ---- Preview expiry: honesty about what's still there ----
  const now = Date.now();
  check("a fresh preview is live", isPreviewLive({ createdAt: new Date(now).toISOString() }, now));
  check("an hours-old preview is not", !isPreviewLive({ createdAt: new Date(now - PREVIEW_TTL_MS - 1000).toISOString() }, now));
  const history = await loadVisualHistory("rro", { now });
  check("history marks whether each preview is still worth rendering",
    history[0].previewExpired === false, history[0]);
  const laterHistory = await loadVisualHistory("rro", { now: now + PREVIEW_TTL_MS + 1000 });
  check("the same record later says its preview is gone — the prompt survives, the image doesn't",
    laterHistory[0].previewExpired === true && /marble counter/.test(laterHistory[0].prompt), laterHistory[0]);

  // ---- What reaches the strategy agents ----
  await recordGeneration("rro", {
    prompt: "ABANDONED: neon cyberpunk oil bottle",
    provider: "openai", actor: "Anjali", images: [{ url: "https://example.com/3.png" }],
  });
  const promptText = visualHistoryToPromptText(await loadVisualHistory("rro", { now }));
  check("a picked round reaches the agents", /marble counter/.test(promptText), promptText);
  // An abandoned attempt is worth recording and NOT worth teaching — it is the opposite of
  // what this brand looks like.
  check("an abandoned round does not", !/ABANDONED/.test(promptText), promptText);
  check("it says how many takes the pick was chosen from", /chosen from 2 takes/.test(promptText), promptText);
  check("the reason for the pick reaches the agents too", /cleaner label read/.test(promptText), promptText);
  check("it is framed as visual direction, not as copy",
    /not content to write about/.test(promptText) && /prompts are not copy/.test(promptText), promptText.slice(0, 400));
  check("a brand with no picks yields nothing rather than an empty heading",
    visualHistoryToPromptText([]) === null);

  // ---- The endpoints ----
  const noAuth = await generate.handler({ httpMethod: "POST", headers: { host: "127.0.0.1:9020" }, body: JSON.stringify({ brandId: "rro", prompt: "x" }) });
  check("generating without auth is refused — this spends real money", noAuth.statusCode === 401, noAuth.statusCode);

  const badBrand = await call(generate, { brandId: "Nope!", prompt: "x" });
  check("a malformed brandId is refused", badBrand.statusCode === 400, badBrand.body);

  const unknownBrand = await call(generate, { brandId: "not-a-brand", prompt: "x" });
  check("a brand Hub has never heard of is refused, rather than creating an orphan bucket",
    unknownBrand.statusCode === 404, unknownBrand.body);

  const noPromptCall = await call(generate, { brandId: "rro", prompt: "  " });
  check("an empty prompt is refused", noPromptCall.statusCode === 400, noPromptCall.body);

  const tooMany = await call(generate, { brandId: "rro", prompt: "x", count: MAX_IMAGES + 1 });
  check("asking for more images than allowed is refused", tooMany.statusCode === 400, tooMany.body);

  const pickNoAuth = await pick.handler({ httpMethod: "POST", headers: { host: "127.0.0.1:9020" }, body: JSON.stringify({ brandId: "rro", generationId: id, index: 0 }) });
  check("recording a pick without auth is refused", pickNoAuth.statusCode === 401, pickNoAuth.statusCode);

  const badIndex = await call(pick, { brandId: "rro", generationId: id, index: -1 });
  check("a negative index is refused", badIndex.statusCode === 400, badIndex.body);

  const pickMissing = await call(pick, { brandId: "rro", generationId: "nope", index: 0 });
  check("picking a missing generation 404s", pickMissing.statusCode === 404, pickMissing.body);

  const pickOk = await call(pick, { brandId: "rro", generationId: id, index: 0, actor: "Vishnu" });
  check("a valid pick is accepted through the endpoint", pickOk.statusCode === 200, pickOk.body);
  const repicked = await fbGet(`strategy_visual/rro/${id}`);
  check("and it overwrites the earlier pick rather than appending a second one",
    repicked.pickedIndex === 0 && repicked.pickedBy === "Vishnu", repicked);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
