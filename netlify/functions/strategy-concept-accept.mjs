// strategy-concept-accept — runs on Netlify's current Functions runtime.
//
// The handler itself is unchanged, in _legacy/strategy-concept-accept.js. withLambda converts the incoming
// Request into the Lambda-style event it expects, and its response back again.
// See _legacy/README.md for why this wrapper exists.
import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/strategy-concept-accept.js";

export default withLambda(legacy.handler);
