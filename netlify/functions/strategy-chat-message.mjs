import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/strategy-chat-message.js";

export default withLambda(legacy.handler);
