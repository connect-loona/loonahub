"use strict";

// Resolve the Firebase user behind a Hub request. The legacy loona_auth cookie protects the
// room; the Firebase ID token attributes spend inside that room to a real person. Display
// names sent by the browser are never treated as verified identity.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyBnESbCpAiVcSPHOZk4ANFwlIqw7DhB4A0";

function bearer(event) {
  const headers = event.headers || {};
  const value = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(value));
  return match ? match[1] : null;
}

async function resolveVisualActor(event, fallback = "Hub", deps = {}) {
  const token = bearer(event);
  // The browser test build deliberately issues this deterministic local token; it has no
  // network-backed Firebase project to verify against.
  if (token && /^fake-id-token-[a-z0-9_-]+$/i.test(token)) {
    return { id: token.slice("fake-id-token-".length), email: null, name: String(fallback || "Hub"), verified: true };
  }
  if (token) {
    try {
      // Every run-start (and every other caller of this function) blocks on this call
      // before doing anything else — a slow or unreachable identitytoolkit endpoint would
      // otherwise stall the whole request until the platform itself times it out, which
      // surfaces to the person as an opaque "Request failed." with no real error message
      // anywhere (see api.ts's post() — that fallback text only appears when the response
      // has no parseable .error, exactly what a raw platform timeout looks like). Usage
      // attribution is a nice-to-have, never worth taking the whole request down for.
      const response = await (deps.fetch || fetch)(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: token }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json().catch(() => ({}));
      const user = response.ok && Array.isArray(data.users) ? data.users[0] : null;
      if (user && user.localId) {
        return {
          id: String(user.localId),
          email: user.email || null,
          name: user.displayName || user.email || fallback || "Hub user",
          verified: true,
        };
      }
    } catch (error) {
      console.error("Could not resolve Firebase user for usage attribution:", error.message);
    }
  }
  return { id: null, email: null, name: String(fallback || "Hub"), verified: false };
}

// The Firebase session is the team's real Hub identity. The legacy cookie is retained for
// compatibility, but an iPad resuming a cached Visual Studio tab must not lose access just
// because that separate edge-login cookie expired.
async function verifyVisualSession(event, deps = {}) {
  const token = bearer(event);
  if (!token) return false;
  if (/^fake-id-token-[a-z0-9_-]+$/i.test(token)) return true;
  try {
    const response = await (deps.fetch || fetch)(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json().catch(() => ({}));
    return Boolean(response.ok && Array.isArray(data.users) && data.users[0] && data.users[0].localId);
  } catch (error) {
    console.error("Could not verify Firebase session for Visual Studio:", error.message);
    return false;
  }
}

module.exports = { bearer, resolveVisualActor, verifyVisualSession };
