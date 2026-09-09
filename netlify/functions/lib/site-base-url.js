// Derives the origin (scheme + host) Hub is actually being reached at, from the incoming
// request's own headers — used anywhere a function needs to build an absolute URL back to
// the dashboard (an email link, a fetch to another one of this site's own functions).
//
// process.env.URL / DEPLOY_URL are documented as build-time environment variables — their
// availability inside a Function's own runtime process.env isn't guaranteed, and appears
// not to hold live (confirmed: a run stuck in "queued" forever with nothing logged past a
// silently-caught fetch failure). The incoming request's own Host header is always
// present, so build the base URL from that instead of trusting env vars that may or may
// not exist at this point.
//
// This also means a domain change (e.g. adding hub.loona.in alongside or instead of
// loonahub.netlify.app) needs no code change here — whichever domain a request actually
// came in on is the one reflected back.
"use strict";

function siteBaseUrl(event) {
  const host = (event.headers && (event.headers.host || event.headers.Host || event.headers["x-forwarded-host"])) || "";
  if (!host) return process.env.URL || process.env.DEPLOY_URL || "";
  const proto = (event.headers && event.headers["x-forwarded-proto"]) || "https";
  return `${proto}://${host}`;
}

module.exports = { siteBaseUrl };
