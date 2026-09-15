// Durable binary storage for Visual Studio.
//
// Firebase RTDB remains the small, searchable ledger: prompt, model, choices, QC and asset
// keys. Image bytes belong here, in a site-scoped Netlify Blob store. This separation is what
// lets a chat grow for years without turning one Firebase read into hundreds of megabytes.
"use strict";
const crypto = require("crypto");
const { cropToShape } = require("./image-shapes");

const STORE_NAME = "loona-visual-assets";
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
let netlifyStoreFactory = null;

// Runtime V2 functions configure this from an ESM module that statically imports
// @netlify/blobs. Keeping that import at the function boundary is important: a lazy
// CommonJS require inside this shared file survives Netlify's ESM bundling as a runtime
// require(), but the package is not copied beside the function. The result is the exact
// production failure "Cannot find module '@netlify/blobs'".
function configureNetlifyStore(factory) {
  if (typeof factory !== "function") throw new TypeError("A Netlify Blobs store factory is required.");
  netlifyStoreFactory = factory;
}

function safePart(value, fallback = "unknown") {
  const clean = String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

function extensionFor(contentType) {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" })[contentType] || "bin";
}

function assetUrl(key) {
  return `/.netlify/functions/visual-asset?key=${encodeURIComponent(key)}`;
}

// A rejection the caller caused — a wrong file, not a broken service. Marked so the endpoints
// can answer 400 rather than 502: "bad gateway" for an image that is simply too small sends
// whoever is debugging it to look at Netlify and Blobs instead of at the file they picked.
function badImage(message) {
  const error = new Error(message);
  error.badRequest = true;
  return error;
}

// `minSide` and `declaredType` are the two rules that only make sense for a file a PERSON
// chose. A reference has to be big enough to hold an identity, and has to actually be the type
// it claims — lying about that is how a file gets mishandled downstream.
//
// Neither rule belongs on the provider's own output. A generated image is not somebody's
// upload: rejecting it for being small would discard work that was already paid for, and the
// wording ("This reference is only…") would be nonsense. The declared type is our own request
// for a format, not a claim about bytes we have seen, so for generated output the type is read
// from the file rather than asserted against.
function inspectImage(buffer, declaredType, { minSide = 128 } = {}) {
  let contentType = null;
  let width = null;
  let height = null;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    contentType = "image/png"; width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else if (buffer.length >= 10 && buffer.subarray(0, 3).equals(Buffer.from([255,216,255]))) {
    contentType = "image/jpeg";
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 255) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        height = buffer.readUInt16BE(offset + 5); width = buffer.readUInt16BE(offset + 7); break;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  } else if (buffer.length >= 10 && /^(GIF87a|GIF89a)$/.test(buffer.subarray(0, 6).toString("ascii"))) {
    contentType = "image/gif"; width = buffer.readUInt16LE(6); height = buffer.readUInt16LE(8);
  } else if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    contentType = "image/webp";
  }
  if (!contentType) throw badImage("The file contents are not a readable PNG, JPEG, WebP or GIF image.");
  if (declaredType && contentType !== declaredType) throw badImage(`The file is ${contentType}, but was labelled ${declaredType}.`);
  if (minSide && width && height && (width < minSide || height < minSide)) {
    throw badImage(`This reference is only ${width}×${height}px. Use an image at least ${minSide}px on each side.`);
  }
  const warnings = [];
  if (width && height && (width < 800 || height < 800)) warnings.push(`Low-resolution reference (${width}×${height}px); product details may drift.`);
  return { contentType, width, height, warnings };
}

// A filesystem stand-in for Netlify Blobs, used only when VISUAL_ASSET_LOCAL_DIR is set.
//
// Without it the two endpoints that serve client images cannot run outside Netlify at all, so
// nothing could test that an upload is rejected for the right reason, that a traversal key is
// refused, or that a stored image comes back with the right content type. Those are exactly
// the checks worth having, and they were unreachable.
//
// Deliberately env-gated rather than a silent fallback: production must fail loudly if Blobs
// is unavailable rather than quietly writing client images to a container's disk, where they
// would vanish with the container and look like data loss.
function localStore(root) {
  const fsp = require("fs").promises;
  const nodePath = require("path");
  const fileFor = (key) => nodePath.join(root, `${Buffer.from(String(key)).toString("hex")}.bin`);
  const metaFor = (key) => `${fileFor(key)}.json`;
  return {
    async set(key, value, options) {
      await fsp.mkdir(root, { recursive: true });
      await fsp.writeFile(fileFor(key), Buffer.from(value));
      await fsp.writeFile(metaFor(key), JSON.stringify((options && options.metadata) || {}));
    },
    async get(key, options) {
      try {
        const data = await fsp.readFile(fileFor(key));
        if (options && options.type === "arrayBuffer") return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        if (options && options.type === "stream") return data;
        return data;
      } catch { return null; }
    },
    async getMetadata(key) {
      try { return { metadata: JSON.parse(await fsp.readFile(metaFor(key), "utf8")) }; }
      catch { return null; }
    },
  };
}

function storeFor(deps = {}) {
  if (deps.store) return deps.store;
  const local = process.env.VISUAL_ASSET_LOCAL_DIR;
  if (local) return localStore(local);
  const factory = deps.getStore || netlifyStoreFactory;
  if (!factory) {
    throw new Error("Netlify Blobs was not configured for this Visual Studio function.");
  }
  return factory({ name: STORE_NAME, consistency: "strong" });
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!match) throw new Error("The image provider returned an unreadable image.");
  const contentType = match[1].toLowerCase();
  if (!SAFE_IMAGE_TYPES.has(contentType)) throw new Error(`Unsupported image type ${contentType}.`);
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new Error("The image provider returned an empty image.");
  if (buffer.length > MAX_ASSET_BYTES) throw new Error(`Image is larger than the ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB Visual Studio limit.`);
  return { buffer, contentType };
}

async function bytesForImage(image, deps = {}) {
  if (image && image.data) {
    const buffer = Buffer.isBuffer(image.data) ? image.data : Buffer.from(image.data);
    return { buffer, contentType: image.contentType || "image/png" };
  }
  if (image && /^data:/i.test(image.url || "")) return decodeDataUrl(image.url);
  if (image && /^https:\/\//i.test(image.url || "")) {
    const doFetch = deps.fetch || fetch;
    const response = await doFetch(image.url);
    if (!response.ok) throw new Error(`Could not preserve generated image (${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = String(response.headers && response.headers.get ? response.headers.get("content-type") : "image/png").split(";")[0].toLowerCase();
    if (!SAFE_IMAGE_TYPES.has(contentType)) throw new Error(`Generated file was ${contentType}, not an image.`);
    if (buffer.length > MAX_ASSET_BYTES) throw new Error(`Generated image is larger than the ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB Visual Studio limit.`);
    return { buffer, contentType };
  }
  throw new Error("The image provider returned no image bytes to preserve.");
}

async function saveBuffer({ buffer, contentType, brandId, chatId, generationId, kind, index, filename, role }, deps = {}) {
  if (!SAFE_IMAGE_TYPES.has(contentType)) throw badImage(`Unsupported image type ${contentType}.`);
  if (!buffer || !buffer.length) throw badImage("Cannot save an empty image.");
  if (buffer.length > MAX_ASSET_BYTES) throw new Error(`Image is larger than the ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB Visual Studio limit.`);
  // Only a person's upload is held to the reference rules. See inspectImage for why applying
  // them to the provider's own output would throw away a generation somebody already paid for.
  const isReference = kind === "references";
  const inspected = inspectImage(buffer, isReference ? contentType : null, { minSide: isReference ? 128 : 0 });
  // For generated output the type is whatever the bytes actually are, not the format we asked
  // the provider for — labelling a PNG as a JPEG produces a data URL some browsers refuse.
  if (!isReference) contentType = inspected.contentType;
  const digest = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const key = [
    "brands", safePart(brandId), "chats", safePart(chatId, "one-off"),
    safePart(kind, "asset"), safePart(generationId, "pending"),
    `${String(index || 0).padStart(2, "0")}-${digest}.${extensionFor(contentType)}`,
  ].join("/");
  await storeFor(deps).set(key, buffer, {
    metadata: {
      contentType, brandId, chatId: chatId || null, generationId: generationId || null,
      kind: kind || "asset", filename: filename || null, role: role || null,
      byteLength: buffer.length, width: inspected.width, height: inspected.height, createdAt: new Date().toISOString(),
    },
  });
  return {
    assetKey: key,
    url: assetUrl(key),
    contentType,
    byteLength: buffer.length,
    filename: filename || null,
    role: role || null,
    durable: true,
    width: inspected.width,
    height: inspected.height,
    warnings: inspected.warnings,
  };
}

// Both providers land here, which is why the crop to the exact requested shape happens here
// rather than inside either one. Neither OpenAI nor Magnific can be asked for 4:5 or 9:16
// directly (see image-shapes.js), so the image arrives at the nearest ratio they do offer and
// is trimmed to the real one before it is stored — the asset, its recorded dimensions and
// anything read back later are all the final shape, with no second version to keep straight.
//
// context.shape is what was asked for. Its absence means a caller that predates shapes, so the
// bytes pass through untouched rather than being cropped to a guess.
async function preserveGeneratedImages(images, context, deps = {}) {
  const saved = [];
  for (let index = 0; index < (images || []).length; index += 1) {
    const source = images[index];
    let { buffer, contentType } = await bytesForImage(source, deps);
    let cropped = false;
    let cropReason = null;
    if (context && context.shape) {
      // THE IMAGE ALWAYS SURVIVES THE CROP. cropToShape is written not to throw, and this
      // catch is the second lock on the same door: by this point the generation has been
      // waited on for up to ninety seconds and billed, and anything thrown here would escape
      // into the background worker's own catch, mark the whole job failed, and discard the one
      // copy of the image. A wrong-shaped image is a complaint; a lost one is unrecoverable.
      try {
        const result = await cropToShape(buffer, contentType, context.shape, deps);
        buffer = result.buffer;
        contentType = result.contentType;
        cropped = result.cropped;
        cropReason = result.reason || null;
      } catch (error) {
        cropReason = `Kept the original frame — cropping failed: ${error.message}`;
      }
    }
    const asset = await saveBuffer({ ...context, buffer, contentType, kind: "generations", index }, deps);
    // A crop that couldn't happen rides along as a warning next to the image rather than
    // disappearing: the image is still worth having, and whoever is looking at it should know
    // it isn't the shape they asked for.
    const warnings = cropReason ? [...(asset.warnings || []), cropReason] : asset.warnings;
    saved.push({ ...asset, warnings, revisedPrompt: source.revisedPrompt || null, cropped });
  }
  return saved;
}

async function loadAsset(key, deps = {}) {
  if (!key || !String(key).startsWith("brands/")) throw new Error("Invalid visual asset key.");
  const store = storeFor(deps);
  const [data, result] = await Promise.all([
    store.get(String(key), { type: "arrayBuffer" }),
    store.getMetadata(String(key)),
  ]);
  if (!data) return null;
  return { data: Buffer.from(data), metadata: (result && result.metadata) || {} };
}

async function referenceForProvider(reference, deps = {}) {
  if (reference && reference.assetKey) {
    const stored = await loadAsset(reference.assetKey, deps);
    if (!stored) throw new Error(`Reference ${reference.name || reference.assetKey} no longer exists.`);
    return {
      data: stored.data,
      contentType: stored.metadata.contentType || reference.contentType || "image/png",
      filename: reference.name || stored.metadata.filename || "reference.png",
      role: reference.role || stored.metadata.role || "",
      assetKey: reference.assetKey,
    };
  }
  return reference;
}

module.exports = {
  badImage, STORE_NAME, MAX_ASSET_BYTES, SAFE_IMAGE_TYPES, assetUrl, decodeDataUrl, inspectImage,
  bytesForImage, saveBuffer, preserveGeneratedImages, loadAsset, referenceForProvider, storeFor,
  configureNetlifyStore,
};
