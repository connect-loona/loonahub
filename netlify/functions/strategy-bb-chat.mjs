// Modern-runtime wrapper for the conversational BB endpoint.
import { withLambda } from "@netlify/aws-lambda-compat";
import { z } from "zod";
globalThis.__zodBundled = z;
import Anthropic from "@anthropic-ai/sdk";
globalThis.__anthropicSdkBundled = Anthropic;
// bb-chat's OpenAI safety net is loaded lazily in CommonJS. Keep a static import here so
// Netlify Runtime V2 includes @openai/agents in the deployed function bundle.
import { Agent } from "@openai/agents";
globalThis.__openaiAgentsBundled = Agent;
import "./_shared/visual-blob-store.mjs";
import legacy from "./_legacy/strategy-bb-chat.js";

export default withLambda(legacy.handler);
