import planner from "./lib/strategy/campaign-planner.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";

const FUNCTION_NAME = "strategy-campaign-background";

export default async function (request) {
  const body = await readSignedBackgroundBody(request, FUNCTION_NAME);
  if (!body || !body.runId || !body.action) return;
  try {
    await planner.runCampaignAction(body.runId, body.action, body.payload || {});
  } catch (error) {
    console.error(`${FUNCTION_NAME} failed for ${body.runId}/${body.action}:`, error);
  }
}

export const config = backgroundConfig;
