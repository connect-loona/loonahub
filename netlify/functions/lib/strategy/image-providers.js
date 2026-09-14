// Visual Studio's image providers, behind one interface.
//
// OpenAI is the only one wired today, because its key is already configured and working in
// Hub. Magnific is the next one in — its API is a webhook-driven async job rather than a
// request/response call, which is why this interface returns finished images rather than
// streaming, and why a provider is free to be slow. Nothing above this layer should ever need
// to know which one produced an image.
//
// What this deliberately does NOT do is host anything. Providers hand back URLs that expire
// (OpenAI's in roughly an hour); the team saves the finals they want into the brand's Drive
// folder by hand, exactly as they do today, and visual-memory.js keeps the prompt and the
// pick forever regardless of what happens to the URL.
"use strict";
const { ConfigurationError } = require("./errors");

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
// Working from a reference is a different endpoint, not a different parameter.
const OPENAI_EDIT_URL = "https://api.openai.com/v1/images/edits";
const DEFAULT_OPENAI_MODEL = "gpt-image-1";
const MAX_IMAGES = 4;
// References travel base64 through a Netlify function, which has a hard request-size ceiling
// (6MB). Capping each one well under that, and capping how many can be sent at once, keeps a
// large upload from failing as an opaque 502 halfway through instead of a readable message.
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCES = 4;

function openaiApiKey() {
  return process.env.OPENAI_API_KEY || "";
}

// Sizes the team actually needs, named for what they're for rather than in pixels — the point
// of Visual Studio is that someone making a reel cover shouldn't have to remember 1024x1536.
const SIZES = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
};

function resolveSize(size) {
  if (!size) return SIZES.square;
  if (SIZES[size]) return SIZES[size];
  // A raw "WIDTHxHEIGHT" is allowed through so the UI can grow new presets without a backend
  // change, but anything else is a mistake worth failing loudly on rather than silently
  // substituting a square for.
  if (/^\d{3,4}x\d{3,4}$/.test(size)) return size;
  throw new Error(`Unknown image size "${size}". Use one of: ${Object.keys(SIZES).join(", ")}.`);
}

// A data: URL as the browser sends it, turned into something multipart/form-data can carry.
// References arrive base64 because nothing is hosted — the bytes go straight from the person's
// machine, through this function, to the provider, and are never stored anywhere in between.
function decodeDataUrl(dataUrl, index) {
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!match) throw new Error(`Reference ${index + 1} is not a readable image.`);
  const [, mediaType, base64] = match;
  if (!/^image\//i.test(mediaType)) throw new Error(`Reference ${index + 1} is a ${mediaType}, not an image.`);
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new Error(`Reference ${index + 1} is empty.`);
  if (bytes.length > MAX_REFERENCE_BYTES) {
    throw new Error(`Reference ${index + 1} is ${Math.round(bytes.length / (1024 * 1024))}MB — the limit is ${Math.round(MAX_REFERENCE_BYTES / (1024 * 1024))}MB. Export it smaller and try again.`);
  }
  const ext = mediaType.split("/")[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
  return { bytes, mediaType, filename: `reference-${index + 1}.${ext}` };
}

// deps.fetch is injected by tests so this is exercisable without a key or a network.
async function generateWithOpenAI(request, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const apiKey = openaiApiKey();
  if (!apiKey && !deps.fetch) {
    throw new ConfigurationError("OPENAI_API_KEY is required to generate images.");
  }

  const count = Math.min(Math.max(Number(request.count) || 1, 1), MAX_IMAGES);
  const model = request.model || process.env.VISUAL_OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const references = Array.isArray(request.references) ? request.references : [];

  // WITH references this is an EDIT, not a generation — a different endpoint, and the one that
  // matters here. Working from a reference is how this team actually makes images: a base
  // scene plus the exact product, "keep the label, change the background". Text-to-image alone
  // can't do that, because it has no way to be handed the thing that must stay identical.
  if (references.length) {
    if (references.length > MAX_REFERENCES) {
      throw new Error(`Up to ${MAX_REFERENCES} reference images at a time — you sent ${references.length}.`);
    }
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", request.prompt);
    form.append("n", String(count));
    form.append("size", resolveSize(request.size));
    references.forEach((reference, i) => {
      const { bytes, mediaType, filename } = decodeDataUrl(reference && reference.dataUrl, i);
      // image[] (repeated) is how gpt-image-1 takes more than one reference.
      form.append("image[]", new Blob([bytes], { type: mediaType }), filename);
    });
    // No content-type header on purpose: fetch sets it with the multipart boundary, and
    // setting it by hand produces a body the API can't parse.
    const edited = await doFetch(OPENAI_EDIT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
    return readOpenAIImages(edited, model, "edit");
  }

  const response = await doFetch(OPENAI_IMAGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      prompt: request.prompt,
      n: count,
      size: resolveSize(request.size),
    }),
  });

  return readOpenAIImages(response, model, "generate");
}

// A 429 from OpenAI means two completely different things, and conflating them is useless to
// whoever is standing in front of the screen.
//
//   A RATE limit is a burst: too many images in the same minute, usually because a few people
//   asked for four takes at once. It clears on its own in seconds, so the right advice is
//   "try again in a moment" — and it's worth one automatic retry before bothering anyone.
//
//   A QUOTA problem is money: prepaid credit exhausted, or the monthly budget cap hit. Waiting
//   does nothing at all, and retrying just burns time. Somebody has to go and top it up.
//
// Unlike ChatGPT's subscription caps there is no multi-hour cooldown here, so "you've hit your
// limit, come back later" would be actively wrong advice in both cases.
function classifyOpenAIFailure(status, detail) {
  const text = String(detail || "").toLowerCase();
  if (/insufficient_quota|exceeded your current quota|billing|credit balance|payment|hard limit/.test(text)) {
    return {
      kind: "quota",
      retryable: false,
      message: "OpenAI has stopped accepting requests — the account is out of credit or has hit its monthly budget cap. Waiting won't help; someone needs to top it up in the OpenAI dashboard.",
    };
  }
  if (status === 429 || /rate limit|too many requests/.test(text)) {
    return {
      kind: "rate_limit",
      retryable: true,
      message: "OpenAI is briefly rate-limiting us — too many images at once. Wait a few seconds and try again, or ask for fewer takes.",
    };
  }
  if (status >= 500) {
    return { kind: "provider_down", retryable: true, message: `OpenAI had a problem on their end (${status}). Worth trying again in a moment.` };
  }
  return { kind: "request", retryable: false, message: null };
}

// Both endpoints answer in the same shape, so both are read the same way.
async function readOpenAIImages(response, model, mode) {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const verdict = classifyOpenAIFailure(response.status, detail);
    // The person gets the plain-English version; the raw response still goes to the function
    // logs, so a diagnosis later isn't limited to whatever we decided to paraphrase today.
    console.error(`OpenAI image ${mode} failed (${response.status}) [${verdict.kind}]:`, String(detail).slice(0, 600));
    // Carry the provider's own words through when we have nothing better to say. The billing
    // case especially: an opaque "image generation failed" is exactly the failure that cost us
    // a real afternoon on the text side (see runtime-failover.js's isProviderError comment).
    const error = new Error(verdict.message || `OpenAI image ${mode} failed (${response.status}). ${detail.slice(0, 400)}`);
    error.status = response.status;
    error.kind = verdict.kind;
    error.retryable = verdict.retryable;
    throw error;
  }

  const data = await response.json();
  const images = (data.data || []).map((item) => ({
    // gpt-image-1 returns base64 by default, dall-e-3 returns a URL. Take whichever came
    // back rather than assuming, and let the caller deal with the difference.
    url: item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : null),
    revisedPrompt: item.revised_prompt || null,
  })).filter((image) => image.url);

  if (!images.length) throw new Error("OpenAI returned no usable images.");
  return { provider: "openai", model, images };
}

const PROVIDERS = {
  openai: { label: "ChatGPT (OpenAI)", generate: generateWithOpenAI, configured: () => Boolean(openaiApiKey()) },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([key, provider]) => ({
    key, label: provider.label, configured: provider.configured(),
  }));
}

// One automatic retry, and only for a genuine burst limit.
//
// A rate limit clears in seconds, and the person has already waited through the first attempt
// — making them press the button again to ride out a two-second window is a worse experience
// than absorbing it here. A quota problem is never retried: waiting does nothing, so a retry
// just doubles the time before they learn they need to top up the account.
//
// Deliberately once, not a loop: if a second attempt also fails, the limit is not a blip and
// the right move is to tell them rather than keep spending their time on it.
const RETRY_DELAY_MS = 2500;

async function generateImages(request, deps = {}) {
  const provider = PROVIDERS[request.provider || "openai"];
  if (!provider) throw new Error(`Unknown image provider "${request.provider}".`);
  if (!String(request.prompt || "").trim()) throw new Error("A prompt is required.");

  try {
    return await provider.generate(request, deps);
  } catch (error) {
    if (!error || !error.retryable) throw error;
    // deps.sleep is injected by tests so this doesn't actually wait two and a half seconds.
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    await sleep(RETRY_DELAY_MS);
    return provider.generate(request, deps);
  }
}

module.exports = {
  generateImages, listProviders, resolveSize, decodeDataUrl, classifyOpenAIFailure,
  SIZES, MAX_IMAGES, MAX_REFERENCES, MAX_REFERENCE_BYTES, RETRY_DELAY_MS, PROVIDERS,
};
