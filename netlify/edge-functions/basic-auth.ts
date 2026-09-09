// Gates the entire site behind a single shared username/password, checked at Netlify's edge
// before any file is served — unlike the in-app "who are you?" picker, this actually stops
// anyone without the password from ever receiving the HTML, so there's nothing to view-source.
//
// Set the credential in Netlify → Site settings → Environment variables:
//   BASIC_AUTH_CREDENTIALS = username:password
// (a single "user:pass" pair — no spaces around the colon)
//
// Missing or malformed credentials return 503 for private pages (fail closed).
// Public microsite routes stay available without dashboard credentials.
//
// This renders its own login page (styled to match the dashboard) instead of using the
// browser's native Basic Auth dialog, since that dialog can't be styled at all and also
// doesn't survive being served through a proxy/embed (e.g. a Framer page linking here).

import type { Context, Config } from "@netlify/edge-functions";

const COOKIE_NAME = "loona_auth";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });
  return out;
}

function loginPageHTML(opts: { error?: boolean; username?: string; redirectTo: string }): string {
  const { error, username = "", redirectTo } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Loona Hub — Sign In</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
    font-family:'Inter','Segoe UI',system-ui,sans-serif;
    background:radial-gradient(34% 22% at 6% 56%, rgba(255,242,216,.5) 0%, rgba(255,150,66,.26) 34%, transparent 60%), linear-gradient(178deg, #ff6d29 0%, #fb5713 16%, #db3d09 30%, #8f2605 46%, #3e0f02 64%, #150602 82%, #070301 100%);
    background-attachment:fixed;
  }
  .box{background:#161316;border:1px solid rgba(186,186,186,.14);border-radius:18px;padding:34px 32px;width:330px;max-width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .lk{font-size:38px}
  h1{color:#fff;margin:6px 0 2px;font-size:19px;font-weight:700}
  p{color:#bababa;font-size:12px;margin:0 0 20px}
  label{display:block;text-align:left;font-size:11px;color:#bababa;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.04em}
  input{width:100%;padding:11px 12px;background:#1c1714;border:2px solid rgba(186,186,186,.14);border-radius:12px;color:#fff;font-weight:600;font-size:15px;outline:none;font-family:inherit}
  input.err{border-color:#e05c5c;animation:shake .3s}
  @keyframes shake{25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
  .go{margin-top:20px;width:100%;background:linear-gradient(135deg,#ff6d29,#ff9457);color:#0d0d0d;border:none;border-radius:12px;padding:12px;font-weight:700;cursor:pointer;font-size:14px;font-family:inherit}
  .err-msg{color:#e05c5c;font-size:12px;margin-top:14px}
</style>
</head>
<body>
  <form class="box" method="POST" action="/">
    <div class="lk">🔒</div>
    <h1>Loona Hub</h1>
    <p>Sign in to continue</p>
    <input type="hidden" name="redirect_to" value="${redirectTo.replace(/"/g, "&quot;")}">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" value="${username.replace(/"/g, "&quot;")}" class="${error ? "err" : ""}" autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" class="${error ? "err" : ""}">
    <button class="go" type="submit">Sign In</button>
    ${error ? '<div class="err-msg">Wrong username or password.</div>' : ""}
  </form>
</body>
</html>`;
}

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // Apply the public-host boundary BEFORE the dashboard's function/asset exceptions.
  // The existing root rewrite in netlify.toml serves /independence/.
  if (url.hostname === "flag.loona.in") {
    const publicPage = ["/", "/independence", "/independence/", "/independence/index.html",
      "/independence/admin", "/independence/admin/", "/independence/admin/index.html"].includes(path);
    const publicAsset = path.startsWith("/assets/independence-day/");
    const publicFunction = ["/.netlify/functions/independence-hoist",
      "/.netlify/functions/independence-admin"].includes(path);
    // The admin endpoint retains its own INDEPENDENCE_ADMIN_PASSWORD check.
    if (publicFunction || ((request.method === "GET" || request.method === "HEAD") && (publicPage || publicAsset))) {
      return context.next();
    }
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Preserve existing dashboard exceptions. Sensitive server functions still need
  // their own caller authentication; that is a separate change.
  if (path.startsWith("/.netlify/functions/") ||
      ["/manifest.json", "/robots.txt", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/independence"].includes(path) ||
      path.startsWith("/icons/") || path.startsWith("/independence/") ||
      path.startsWith("/assets/independence-day/")) return context.next();

  const credentials = Netlify.env.get("BASIC_AUTH_CREDENTIALS");
  const sepIndex = credentials?.indexOf(":") ?? -1;
  if (!credentials || sepIndex <= 0 || sepIndex === credentials.length - 1) {
    return new Response("Sign-in is temporarily unavailable.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const expectedUser = credentials.slice(0, sepIndex);
  const expectedPass = credentials.slice(sepIndex + 1);
  const expectedToken = await sha256Hex(credentials);

  const cookies = parseCookies(request.headers.get("cookie") || "");

  if (cookies[COOKIE_NAME] === expectedToken) {
    return context.next();
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const username = String(form.get("username") || "");
    const password = String(form.get("password") || "");
    const redirectTo = String(form.get("redirect_to") || "/");

    if (username === expectedUser && password === expectedPass) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo || "/",
          "Set-Cookie": `${COOKIE_NAME}=${expectedToken}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    return new Response(loginPageHTML({ error: true, username, redirectTo }), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return new Response(loginPageHTML({ redirectTo: url.pathname + url.search }), {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
};

// Do not use excludedPath here: it would bypass the hostname boundary above.
export const config: Config = {
  path: "/*",
};
