import pipeline from "./lib/strategy/pipeline.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";

const FUNCTION_NAME = "strategy-concept-propose-background";
const { proposeAssetCandidate, proposeAssetVariations } = pipeline;

export default async function (request) {
  const body = await readSignedBackgroundBody(request, FUNCTION_NAME);
  if (!body) return;
  const { runId, assetId, action, notes, focus, section } = body;
  const stage = body.stage || "strategy";
  if (!runId || !assetId || !action) return;
  try {
    if (action === "variations") await proposeAssetVariations(runId, stage, assetId, focus, section);
    else await proposeAssetCandidate(runId, stage, assetId, action, notes, focus, section);
  } catch (error) {
    console.error(`${FUNCTION_NAME} failed for run ${runId}, stage ${stage}, asset ${assetId}:`, error);
  }
}

export const config = backgroundConfig;
