// Authenticated, streaming delivery for durable Visual Studio images. The chat loads small
// records from Firebase and asks for the image only when it is actually visible.
import assets from "./_shared/visual-blob-store.mjs";
import { authorizeVisualSession, json } from "./_shared/visual-auth.mjs";

export default async function visualAsset(request) {
  if (!(await authorizeVisualSession(request))) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!key.startsWith("brands/") || key.includes("..")) return json({ error: "Invalid asset key" }, 400);
  // Resolved through visual-assets rather than calling getStore here, so there is one place
  // that decides where image bytes live — and so this endpoint can run outside Netlify, which
  // is what makes its auth, traversal and content-type behaviour testable at all.
  const store = assets.storeFor();
  const [data, result] = await Promise.all([store.get(key, { type: "stream" }), store.getMetadata(key)]);
  if (!data) return json({ error: "Image not found" }, 404);
  const metadata = (result && result.metadata) || {};
  return new Response(data, {
    headers: {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${String(metadata.filename || "visual-studio-image").replace(/["\r\n]/g, "")}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
