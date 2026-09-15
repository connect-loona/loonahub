import pipeline from "./lib/strategy/pipeline.js";
import { fbGet } from "./lib/strategy/firebase.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";

const FUNCTION_NAME = "strategy-research-background";
const { runResearchStage, runChatPipeline } = pipeline;

export default async function (request) {
  const body = await readSignedBackgroundBody(request, FUNCTION_NAME);
  if (!body || !body.runId) return;
  try {
    const run = await fbGet(`strategy_runs/${body.runId}`);
    if (run && run.chatMode) await runChatPipeline(body.runId);
    else await runResearchStage(body.runId);
  } catch (error) {
    console.error(`${FUNCTION_NAME} failed for run ${body.runId}:`, error);
  }
}

export const config = backgroundConfig;
