import pipeline from "./lib/strategy/pipeline.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";

const FUNCTION_NAME = "strategy-deck-builder-background";
const { runDeckStage } = pipeline;

export default async function (request) {
  const body = await readSignedBackgroundBody(request, FUNCTION_NAME);
  if (!body || !body.runId) return;
  try {
    await runDeckStage(body.runId);
  } catch (error) {
    console.error(`${FUNCTION_NAME} failed for run ${body.runId}:`, error);
  }
}

export const config = backgroundConfig;
