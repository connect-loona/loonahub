// Modern-runtime wrapper for the WhatsApp Cloud API webhook.
import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/whatsapp-webhook.js";

export default withLambda(legacy.handler);
