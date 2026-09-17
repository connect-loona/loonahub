import crypto from "node:crypto";
import visualActor from "../lib/strategy/visual-actor.js";

function env(name) {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || "";
}

export function authorizeVisualRequest(request) {
  const credentials = env("BASIC_AUTH_CREDENTIALS");
  const split = credentials.indexOf(":");
  if (!credentials || split <= 0 || split === credentials.length - 1) return false;
  const expected = crypto.createHash("sha256").update(credentials).digest("hex");
  const cookie = request.headers.get("cookie") || "";
  const actual = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("loona_auth="))?.slice("loona_auth=".length);
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function authorizeVisualSession(request) {
  if (authorizeVisualRequest(request)) return true;
  return visualActor.verifyVisualSession({ headers: Object.fromEntries(request.headers.entries()) });
}

export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
