// Modern-runtime wrapper for the conversational BB endpoint.
import { withLambda } from "@netlify/aws-lambda-compat";
import { z } from "zod";
globalThis.__zodBundled = z;
import Anthropic from "@anthropic-ai/sdk";
globalThis.__anthropicSdkBundled = Anthropic;
import legacy from "./_legacy/strategy-bb-chat.js";

export default withLambda(legacy.handler);
