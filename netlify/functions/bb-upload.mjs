import assets from "./_shared/visual-blob-store.mjs";
import { authorizeVisualSession, json } from "./_shared/visual-auth.mjs";
import brands from "./lib/strategy/hub-brands.js";

export default async function bbUpload(request) {
  if (!(await authorizeVisualSession(request))) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  const requestedBrandId = url.searchParams.get("brandId") || "";
  const scope = url.searchParams.get("scope") === "global" ? "global" : "brand";
  const brandId = scope === "global" ? "global" : requestedBrandId;
  if (scope === "brand" && (!/^[a-z0-9-]+$/.test(brandId) || !(await brands.hubBrandExists(brandId)))) return json({ error: "Brand not found in Hub." }, 404);
  const contentType = (request.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!assets.SAFE_BB_ATTACHMENT_TYPES.has(contentType)) return json({ error: "BB supports images, PDFs, TXT, Markdown, CSV and JSON files." }, 400);
  const buffer = Buffer.from(await request.arrayBuffer());
  if (!buffer.length || buffer.length > assets.MAX_BB_ATTACHMENT_BYTES) return json({ error: "Attachments must be between 1 byte and 10MB." }, 400);
  try {
    const asset = await assets.saveBBAttachment({ buffer, contentType, brandId, filename: url.searchParams.get("filename") || "attachment" });
    return json({ asset });
  } catch (error) { return json({ error: error.message || "Could not save image." }, error.badRequest ? 400 : 502); }
}
