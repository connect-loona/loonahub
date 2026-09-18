import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/strategy-concept-review.js";

export default withLambda(legacy.handler);
