// visual-generate — runs on Netlify's current Functions runtime.
//
// The handler itself is unchanged, in _legacy/visual-generate.js. withLambda converts the incoming
// Request into the Lambda-style event it expects, and its response back again.
// See _legacy/README.md for why this wrapper exists.
import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/visual-generate.js";

export default withLambda(legacy.handler);
