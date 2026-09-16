import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/strategy-campaign-action.js";

export default withLambda(legacy.handler);
