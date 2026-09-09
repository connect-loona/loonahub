# Strategy OS test suite

This suite doesn't run against production Firebase or Netlify — it spins up two small
local stand-ins so tests are fast, free, and safe to run anywhere:

- `tests/harness/fake-rtdb-server.js` — a plain in-memory HTTP server that speaks the same
  REST shape as Firebase Realtime Database (`GET`/`PUT`/`PATCH` on `<path>.json`), so
  `netlify/functions/lib/strategy/firebase.js` and the client SDK shim in
  `tests/harness/shared.js`'s `combinedInit` can talk to it unmodified. It does **not**
  replicate Firebase's real quirks exactly — most notably it doesn't drop empty arrays on
  write the way real Firebase does. See the header comment in that file, and
  `tests/strategy/firebase-empty-array-drop.test.js`, which exists specifically to guard
  against that real-Firebase behavior since the stand-in won't reproduce it on its own.
- `tests/harness/netlify-dev-lite.js` — a minimal local host for the Netlify Functions in
  `netlify/functions/`, auto-discovered from that directory (no function list to maintain),
  and for serving `index.html` itself so Playwright can drive the real UI.

## Running it

```
npm install
npm test              # everything: tests/strategy/*.test.js + tests/e2e/*.spec.js
npm run test:strategy # backend only (fast, no browser)
npm run test:e2e      # UI only (Playwright/Chromium)
```

`npm test` (via `tests/run-all.js`) starts both harness servers, wipes every known Strategy
OS Firebase path before *each* test file (so no file can leave state behind for the next
one), runs every file as its own process, tears the servers down, and exits non-zero if any
file failed.

Playwright's Chromium build must be present — CI installs it with
`npx playwright install --with-deps chromium`; locally, run that once if `npm test`
can't launch a browser.

## Adding a test

- Backend-only logic (a Netlify function's handler, a `lib/strategy/*.js` module) goes in
  `tests/strategy/*.test.js` — plain Node scripts, no test framework, using the
  `check(name, cond)` / `finish()` helpers from `tests/harness/shared.js` (or a local
  equivalent, matching the existing files).
- Anything that needs the real DOM/UI goes in `tests/e2e/*.spec.js`, driven with Playwright
  via `chromium.launch(chromiumLaunchOptions())` and the shared `combinedInit`/
  `loginAsGokul`/`authCookie` helpers from `tests/harness/shared.js`.
- Every test file must `process.exit(0)` on success and `process.exit(1)` (or throw) on
  failure — that's what `tests/run-all.js` checks to score it pass/fail.
