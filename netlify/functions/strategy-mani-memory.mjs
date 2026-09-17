import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/strategy-mani-memory.js";

export default withLambda(legacy.handler);
