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
const { generateImages, resolveSize, listProviders, decodeDataUrl, MAX_IMAGES, MAX_REFERENCES, MAX_REFERENCE_BYTES } = require(path.join(HUB, "netlify/functions/lib/strategy/image-providers"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;
const generate = require(path.join(HUB, "netlify/functions/visual-generate.js"));
const pick = require(path.join(HUB, "netlify/functions/visual-pick.js"));

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

  // ---- Sizes are named for what they're for, not in pixels ----
  check("a named size resolves", resolveSize("portrait") === "1024x1536", resolveSize("portrait"));
  check("no size means square", resolveSize() === "1024x1024");
  check("a raw WxH is allowed through so the UI can add presets without a backend change",
    resolveSize("1200x628") === "1200x628");
  let sizeError = null;
  try { resolveSize("enormous"); } catch (e) { sizeError = e.message; }
  check("a nonsense size fails loudly instead of silently becoming a square",
    /Unknown image size/.test(sizeError || ""), sizeError);

  // ---- The provider layer ----
  const providers = listProviders();
  check("OpenAI is offered as a provider", providers.some((p) => p.key === "openai"), providers);

  // gpt-image-1 returns base64; dall-e-3 returns a URL. Both have to work — assuming one
  // shape is exactly how this breaks the first time somebody switches model.
  const b64 = await generateImages({ prompt: "a bottle on marble", count: 1 },
    { fetch: okFetch({ data: [{ b64_json: "AAAA", revised_prompt: "a glass bottle on marble" }] }) });
  check("a base64 image comes back as a usable data URL", /^data:image\/png;base64,AAAA/.test(b64.images[0].url), b64.images[0].url);
  check("the provider's revised prompt is kept", b64.images[0].revisedPrompt === "a glass bottle on marble", b64.images[0]);

  const urlShape = await generateImages({ prompt: "x", count: 1 },
    { fetch: okFetch({ data: [{ url: "https://example.com/a.png" }] }) });
  check("a URL image works too", urlShape.images[0].url === "https://example.com/a.png", urlShape.images[0]);

  let emptyError = null;
  try { await generateImages({ prompt: "x" }, { fetch: okFetch({ data: [] }) }); }
  catch (e) { emptyError = e.message; }
  check("a response with no images is an error, not an empty success", /no usable images/.test(emptyError || ""), emptyError);

  // The provider's own words have to survive. An opaque "generation failed" on a billing
  // error is precisely the failure that cost real time on the text side.
  let billingError = null;
  try {
    await generateImages({ prompt: "x" }, {
      fetch: async () => ({ ok: false, status: 400, text: async () => "billing_hard_limit_reached" }),
    });
  } catch (e) { billingError = e.message; }
  check("the provider's own error text is carried through", /billing_hard_limit_reached/.test(billingError || ""), billingError);

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
  // multipart rather than JSON.
  let editCall = null;
  const edited = await generateImages(
    { prompt: "keep the bottle, warmer table", count: 2, references: [{ dataUrl: PIXEL, role: "Product identity" }] },
    { fetch: async (url, options) => { editCall = { url, options }; return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) }; } },
  );
  check("a round with references goes to the edits endpoint", /\/images\/edits$/.test(editCall.url), editCall.url);
  check("and sends multipart form data, not JSON", editCall.options.body instanceof FormData, typeof editCall.options.body);
  check("the content-type is left to fetch so the multipart boundary is right",
    !Object.keys(editCall.options.headers).some((h) => /content-type/i.test(h)), Object.keys(editCall.options.headers));
  check("the reference is attached under image[] — how gpt-image-1 takes more than one",
    editCall.options.body.getAll("image[]").length === 1, editCall.options.body.getAll("image[]").length);
  check("the prompt travels with it", editCall.options.body.get("prompt") === "keep the bottle, warmer table", editCall.options.body.get("prompt"));
  check("an edit still returns usable images", edited.images.length === 1 && /^data:image\/png;base64,/.test(edited.images[0].url), edited.images[0].url.slice(0, 40));

  // Without references it must stay on the plain generations endpoint.
  let plainCall = null;
  await generateImages({ prompt: "a bottle", count: 1 },
    { fetch: async (url, options) => { plainCall = { url, options }; return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://x/a.png" }] }) }; } });
  check("a round with no references stays on the generations endpoint", /\/images\/generations$/.test(plainCall.url), plainCall.url);

  let tooManyRefs = null;
  try {
    await generateImages({ prompt: "x", references: new Array(MAX_REFERENCES + 1).fill({ dataUrl: PIXEL }) },
      { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
  } catch (e) { tooManyRefs = e.message; }
  check("more references than the cap is refused", new RegExp(`Up to ${MAX_REFERENCES} reference`).test(tooManyRefs || ""), tooManyRefs);

  // ---- recordGeneration: written before anybody picks ----
  const { id } = await recordGeneration("rro", {
    prompt: "Primio bottle on a marble counter, warm morning light",
    provider: "openai", model: "gpt-image-1", actor: "Anjali",
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
