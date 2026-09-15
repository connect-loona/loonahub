import pipeline from "./lib/strategy/pipeline.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";

const FUNCTION_NAME = "strategy-concept-discard-background";
const { replaceAsset } = pipeline;

export default async function (request) {
  const body = await readSignedBackgroundBody(request, FUNCTION_NAME);
  if (!body) return;
  const { runId, assetId, notes, actor } = body;
  const stage = body.stage || "strategy";
  if (!runId || !assetId) return;
  try {
    await replaceAsset(runId, stage, assetId, notes, actor);
  } catch (error) {
    console.error(`${FUNCTION_NAME} failed for run ${runId}, stage ${stage}, asset ${assetId}:`, error);
  }
}

export const config = backgroundConfig;
