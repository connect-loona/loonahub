// One reference per request. Uploading separately keeps a four-reference generation request
// below Netlify's buffered payload ceiling and gives the image a durable identity before the
// expensive model call starts.
import crypto from "node:crypto";
import chats from "./lib/strategy/visual-chats.js";
import assets from "./lib/strategy/visual-assets.js";
import { authorizeVisualRequest, json } from "./_shared/visual-auth.mjs";

export default async function uploadReference(request) {
  if (!authorizeVisualRequest(request)) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  const chatId = url.searchParams.get("chatId") || "";
  let chat;
  try { chat = await chats.resolveChat(chatId); }
  catch (error) { return json({ error: error.message }, error.notFound ? 404 : 502); }
  const contentType = (request.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!assets.SAFE_IMAGE_TYPES.has(contentType)) return json({ error: "Upload a PNG, JPEG, WebP or GIF image." }, 400);
  const buffer = Buffer.from(await request.arrayBuffer());
  if (!buffer.length) return json({ error: "The uploaded image was empty." }, 400);
  if (buffer.length > assets.MAX_ASSET_BYTES) return json({ error: "Reference images must be 5MB or smaller." }, 413);
  try {
    const saved = await assets.saveBuffer({
      buffer, contentType, brandId: chat.brandId, chatId,
      generationId: `upload-${crypto.randomUUID()}`, kind: "references", index: 0,
      filename: url.searchParams.get("filename") || "reference",
      role: url.searchParams.get("role") || "",
    });
    return json({ asset: saved });
  } catch (error) {
    // A file the person picked being wrong is a 400. Only an actual storage failure is a 502.
    if (error && error.badRequest) return json({ error: error.message }, 400);
    console.error("Visual reference upload failed:", error);
    return json({ error: error.message || "Could not store the reference." }, 502);
  }
}
