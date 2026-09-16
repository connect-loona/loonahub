// strategy-run-start — runs on Netlify's current Functions runtime.
//
// The handler itself is unchanged, in _legacy/strategy-run-start.js. withLambda converts the incoming
// Request into the Lambda-style event it expects, and its response back again.
// See _legacy/README.md for why this wrapper exists.
import { withLambda } from "@netlify/aws-lambda-compat";
// strategy-run-start.js's dependency chain reaches zod (a plain `require("zod")` two CJS
// hops down, through this ESM wrapper's static import of a CommonJS _legacy handler) — a
// pattern the deployed bundle silently failed to trace, crashing every invocation with a
// raw "Cannot find module 'zod'" 502 that none of this file's own error handling ever got
// a chance to run for (a known gap bundling CJS requires reached through an ESM entry's
// import graph — see netlify/zip-it-and-ship-it issues #869 and #1025 — not a bug in the
// handler itself). Importing it directly here, in the one place a bundler's dependency scan
// is guaranteed to look, sidesteps the gap instead of depending on it being found two hops
// away. The same fix is applied to every other .mjs wrapper whose _legacy handler also
// reaches zod: strategy-mani-ask, strategy-brand-save, strategy-concept-accept,
// strategy-stage-approve, strategy-stage-reopen, strategy-stage-retry.
import { z } from "zod";
globalThis.__zodBundled = z;
import legacy from "./_legacy/strategy-run-start.js";

export default withLambda(legacy.handler);
