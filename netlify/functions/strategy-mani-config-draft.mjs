import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/strategy-mani-config-draft.js";
export default withLambda(legacy.handler);
