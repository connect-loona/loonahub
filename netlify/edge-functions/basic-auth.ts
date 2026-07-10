// Gates the entire site behind a single shared username/password, checked at Netlify's edge
// before any file is served — unlike the in-app "who are you?" picker, this actually stops
// anyone without the password from ever receiving the HTML, so there's nothing to view-source.
//
// Set the credential in Netlify → Site settings → Environment variables:
//   BASIC_AUTH_CREDENTIALS = username:password
// (a single "user:pass" pair — no spaces around the colon)
//
// If that variable isn't set, this function lets every request through unauthenticated,
// so a misconfigured env var fails safe-for-deploys but does NOT silently protect the site —
// check Netlify's deploy log / the site directly after setting it to confirm the prompt appears.

import type { Context, Config } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  const credentials = Netlify.env.get("BASIC_AUTH_CREDENTIALS");
  if (!credentials) return context.next();

  const [expectedUser, expectedPass] = credentials.split(":");

  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Basic\s+(.+)$/i);

  if (match) {
    try {
      const decoded = atob(match[1]);
      const sepIndex = decoded.indexOf(":");
      const user = decoded.slice(0, sepIndex);
      const pass = decoded.slice(sepIndex + 1);
      if (user === expectedUser && pass === expectedPass) {
        return context.next();
      }
    } catch (_e) {
      // fall through to the 401 below
    }
  }

  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Loona Hub", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
};

export const config: Config = {
  path: "/*",
  // Leave the API functions reachable directly: the scheduled ones (petpooja-sync,
  // brand-of-day) are invoked by Netlify's own cron trigger, not a browser, so they'd
  // never present Basic Auth credentials and would silently stop running if gated here.
  excludedPath: "/.netlify/functions/*",
};
