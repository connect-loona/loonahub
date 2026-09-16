// strategy-stage-reopen — runs on Netlify's current Functions runtime.
//
// The handler itself is unchanged, in _legacy/strategy-stage-reopen.js. withLambda converts the incoming
// Request into the Lambda-style event it expects, and its response back again.
// See _legacy/README.md for why this wrapper exists.
import { withLambda } from "@netlify/aws-lambda-compat";
// Forces zod into this function's bundle — see strategy-run-start.mjs's own comment for why
// the transitive `require("zod")` two CJS hops down wasn't enough on its own.
import { z } from "zod";
globalThis.__zodBundled = z;
import legacy from "./_legacy/strategy-stage-reopen.js";

export default withLambda(legacy.handler);
