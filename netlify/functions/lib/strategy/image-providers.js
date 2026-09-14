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

// Both endpoints answer in the same shape, so both are read the same way.
async function readOpenAIImages(response, model, mode) {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // Carry the provider's own words through. The billing case especially: an opaque "image
    // generation failed" is exactly the failure that cost us a real afternoon on the text
    // side (see runtime-failover.js's isProviderError comment).
    const error = new Error(`OpenAI image ${mode} failed (${response.status}). ${detail.slice(0, 400)}`);
    error.status = response.status;
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

async function generateImages(request, deps) {
  const provider = PROVIDERS[request.provider || "openai"];
  if (!provider) throw new Error(`Unknown image provider "${request.provider}".`);
  if (!String(request.prompt || "").trim()) throw new Error("A prompt is required.");
  return provider.generate(request, deps);
}

module.exports = {
  generateImages, listProviders, resolveSize, decodeDataUrl,
  SIZES, MAX_IMAGES, MAX_REFERENCES, MAX_REFERENCE_BYTES, PROVIDERS,
};
