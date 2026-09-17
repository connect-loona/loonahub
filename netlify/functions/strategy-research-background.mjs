import pipeline from "./lib/strategy/pipeline.js";
import { fbGet, fbUpdate } from "./lib/strategy/firebase.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";
// pipeline.js reaches zod and the Anthropic SDK through CommonJS dependencies.  Netlify's
// bundler does not reliably retain those transitive dependencies for a modern ESM
// background entry, which left new runs permanently "queued" before this handler could
// execute.  Make both dependencies explicit, as the foreground wrappers already do.
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import * as OpenAIAgents from "@openai/agents";

globalThis.__zodBundled = z;
globalThis.__anthropicSdkBundled = Anthropic;
globalThis.__openaiAgentsBundled = OpenAIAgents;

const FUNCTION_NAME = "strategy-research-background";
const { runResearchStage, runChatPipeline } = pipeline;

export default async function (request) {
  const body = await readSignedBackgroundBody(request, FUNCTION_NAME);
  if (!body || !body.runId) return;
  try {
    const run = await fbGet(`strategy_runs/${body.runId}`);
    // Campaign chat has its own identity -> thought -> routes -> assets state machine.
    // It needs the Research evidence, but running the monthly Strategy/Copy/Direction
    // chain here would generate the wrong artefacts and spend three unnecessary calls.
    if (run && run.chatMode && run.runType === "campaign") await runResearchStage(body.runId);
    else if (run && run.chatMode) await runChatPipeline(body.runId);
    else await runResearchStage(body.runId);
  } catch (error) {
    console.error(`${FUNCTION_NAME} failed for run ${body.runId}:`, error);
    const now = new Date().toISOString();
    try {
      const detail = error instanceof Error ? error.message : String(error);
      await fbUpdate(`strategy_runs/${body.runId}/stages/research`, { status: "failed", detail: `Research could not start: ${detail}`, updatedAt: now });
      await fbUpdate(`strategy_runs/${body.runId}`, { status: "research_failed", updatedAt: now });
    } catch { /* the original error is still logged above */ }
  }
}

export const config = backgroundConfig;
