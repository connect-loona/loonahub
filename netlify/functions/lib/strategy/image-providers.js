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
const DEFAULT_OPENAI_MODEL = "gpt-image-1";
const MAX_IMAGES = 4;

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

// deps.fetch is injected by tests so this is exercisable without a key or a network.
async function generateWithOpenAI(request, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const apiKey = openaiApiKey();
  if (!apiKey && !deps.fetch) {
    throw new ConfigurationError("OPENAI_API_KEY is required to generate images.");
  }

  const count = Math.min(Math.max(Number(request.count) || 1, 1), MAX_IMAGES);
  const response = await doFetch(OPENAI_IMAGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: request.model || process.env.VISUAL_OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      prompt: request.prompt,
      n: count,
      size: resolveSize(request.size),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // Carry the provider's own words through. The billing case especially: an opaque "image
    // generation failed" is exactly the failure that cost us a real afternoon on the text
    // side (see runtime-failover.js's isProviderError comment).
    const error = new Error(`OpenAI image generation failed (${response.status}). ${detail.slice(0, 400)}`);
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
  return { provider: "openai", model: request.model || process.env.VISUAL_OPENAI_MODEL || DEFAULT_OPENAI_MODEL, images };
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

module.exports = { generateImages, listProviders, resolveSize, SIZES, MAX_IMAGES, PROVIDERS };
