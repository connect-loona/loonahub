// brain-check-winner — runs on Netlify's current Functions runtime.
//
// The handler itself is unchanged, in _legacy/brain-check-winner.js. withLambda converts the incoming
// Request into the Lambda-style event it expects, and its response back again.
// See _legacy/README.md for why this wrapper exists.
import { withLambda } from "@netlify/aws-lambda-compat";
import webpush from "web-push";
globalThis.__webPushBundled = webpush;
import legacy from "./_legacy/brain-check-winner.js";

export default withLambda(legacy.handler);
