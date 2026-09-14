// Durable binary storage for Visual Studio.
//
// Firebase RTDB remains the small, searchable ledger: prompt, model, choices, QC and asset
// keys. Image bytes belong here, in a site-scoped Netlify Blob store. This separation is what
// lets a chat grow for years without turning one Firebase read into hundreds of megabytes.
"use strict";
const crypto = require("crypto");

const STORE_NAME = "loona-visual-assets";
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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

function inspectImage(buffer, declaredType) {
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
  if (!contentType) throw new Error("The file contents are not a readable PNG, JPEG, WebP or GIF image.");
  if (declaredType && contentType !== declaredType) throw new Error(`The file is ${contentType}, but was labelled ${declaredType}.`);
  if (width && height && (width < 128 || height < 128)) throw new Error(`This reference is only ${width}×${height}px. Use an image at least 128px on each side.`);
  const warnings = [];
  if (width && height && (width < 800 || height < 800)) warnings.push(`Low-resolution reference (${width}×${height}px); product details may drift.`);
  return { contentType, width, height, warnings };
}

function storeFor(deps = {}) {
  if (deps.store) return deps.store;
  // Required lazily so the pure helpers and existing unit tests remain usable outside a
  // Netlify runtime. A real write still fails loudly if Blobs itself is unavailable.
  const { getStore } = require("@netlify/blobs");
  return getStore({ name: STORE_NAME, consistency: "strong" });
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
  if (!SAFE_IMAGE_TYPES.has(contentType)) throw new Error(`Unsupported image type ${contentType}.`);
  if (!buffer || !buffer.length) throw new Error("Cannot save an empty image.");
  if (buffer.length > MAX_ASSET_BYTES) throw new Error(`Image is larger than the ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB Visual Studio limit.`);
  const inspected = inspectImage(buffer, contentType);
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

async function preserveGeneratedImages(images, context, deps = {}) {
  const saved = [];
  for (let index = 0; index < (images || []).length; index += 1) {
    const source = images[index];
    const { buffer, contentType } = await bytesForImage(source, deps);
    const asset = await saveBuffer({ ...context, buffer, contentType, kind: "generations", index }, deps);
    saved.push({ ...asset, revisedPrompt: source.revisedPrompt || null });
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
  STORE_NAME, MAX_ASSET_BYTES, SAFE_IMAGE_TYPES, assetUrl, decodeDataUrl, inspectImage,
  bytesForImage, saveBuffer, preserveGeneratedImages, loadAsset, referenceForProvider, storeFor,
};
