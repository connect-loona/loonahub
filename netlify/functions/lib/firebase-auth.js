// The one place a Netlify Function attaches a credential to a Realtime Database call.
//
// WHY THIS EXISTS. Every function in this repo talks to the RTDB over plain REST, and until
// now none of them authenticated. That is not a small omission: for Hub to work at all, the
// database itself had to accept unauthenticated reads AND writes from anyone — and its URL is
// hard-coded in a public repository and shipped in the browser bundle. Anyone who had the URL
// had the database: every brand, every client task, every strategy run, every distilled note
// Loona Brain holds about a client, and the employee and attendance records syncing in.
//
// Rules cannot be closed until the functions can prove who they are, which is what this does.
//
// TWO PROPERTIES THIS MUST HAVE, and both are load-bearing:
//
// 1. It is a NO-OP when no secret is configured. That is deliberate, not defensive padding —
//    it means this change can ship and be verified in production while the database is still
//    open, and the secret can be introduced afterwards without a flag day. Nothing breaks on
//    the way in, and nothing breaks if the secret is ever removed.
//
// 2. It attaches the secret ONLY to the database's own host. Several of these functions share
//    a single req() helper between Firebase and PetPooja, Spotify and Google. A patch that
//    appended the credential to every outbound call would hand Loona's database secret to
//    three third parties — a worse hole than the one being closed. So the host is checked, and
//    anything that is not the configured database is returned untouched.
"use strict";

const DEFAULT_DB_URL = "https://loona-hub-c85d7-default-rtdb.firebaseio.com";

function databaseUrl() {
  return (process.env.FIREBASE_DB_URL || DEFAULT_DB_URL).replace(/\/+$/, "");
}

function dbSecret() {
  return process.env.FIREBASE_DB_SECRET || "";
}

function hostOf(urlStr) {
  try {
    return new URL(urlStr).host;
  } catch {
    return null;
  }
}

// Only the configured database counts. Not "any firebaseio.com host" — that would still send
// the secret to somebody else's Firebase project if a URL were ever mistyped or injected.
function isDatabaseUrl(urlStr) {
  const host = hostOf(urlStr);
  return Boolean(host && host === hostOf(databaseUrl()));
}

// Appends the credential as Firebase's REST API expects it, preserving any query string the
// caller already built (shallow=, orderBy=, limitToLast= are all in use in this repo).
function authedUrl(urlStr) {
  const secret = dbSecret();
  if (!secret) return urlStr;
  if (!isDatabaseUrl(urlStr)) return urlStr;
  // Already carries a credential — don't add a second one.
  if (/[?&]auth=/.test(String(urlStr))) return urlStr;
  return `${urlStr}${String(urlStr).includes("?") ? "&" : "?"}auth=${encodeURIComponent(secret)}`;
}

module.exports = { authedUrl, isDatabaseUrl, databaseUrl, dbSecret, DEFAULT_DB_URL };
