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
    // Campaign chat has its own identity -> thought -> routes -> assets state machine.
    // It needs the Research evidence, but running the monthly Strategy/Copy/Direction
    // chain here would generate the wrong artefacts and spend three unnecessary calls.
    if (run && run.chatMode && run.runType === "campaign") await runResearchStage(body.runId);
    else if (run && run.chatMode) await runChatPipeline(body.runId);
    else await runResearchStage(body.runId);
  } catch (error) {
    console.error(`${FUNCTION_NAME} failed for run ${body.runId}:`, error);
  }
}

export const config = backgroundConfig;
