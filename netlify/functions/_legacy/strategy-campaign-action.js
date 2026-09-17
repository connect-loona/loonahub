// POST actions for the conversational Campaign Planning state machine.
// Long model work is delegated to strategy-campaign-background; human decisions are
// committed immediately so a refresh always reopens at the same campaign phase.
"use strict";

const { fbGet, fbPush, fbSet, fbUpdate } = require("../lib/strategy/firebase");
const { checkAuthorization } = require("../lib/strategy/auth");
const { signedBackgroundHeaders } = require("../lib/strategy/background-auth");
const { siteBaseUrl } = require("../lib/site-base-url");
const { recordManiEventSafe } = require("../lib/strategy/mani-events");

const GENERATE_ACTIONS = new Set(["generate_identities", "generate_thought", "generate_routes", "generate_assets"]);
const DECISION_ACTIONS = new Set(["lock_identity", "save_identity", "lock_thought", "lock_route"]);

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
}

function collectionValues(node, field) {
  return Object.values(node || {}).flatMap((batch) => Array.isArray(batch && batch[field]) ? batch[field] : []);
}

function findById(items, id) {
  return items.find((item) => item && item.id === id);
}

async function remember(run, actor, decision, notes) {
  await fbPush(`strategy_learning_events/${run.brandId}`, {
    runId: run.runId, month: run.month, stage: "campaign", decision, actor,
    notes, createdAt: new Date().toISOString(),
  });
  await recordManiEventSafe({ type: "campaign_decision", source: "strategy_os", brandId: run.brandId, actor, entityType: "strategy_run", entityId: run.runId, action: decision, summary: String(notes || decision), data: { month: run.month } });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const runId = String(body.runId || "").trim();
  const action = String(body.action || "").trim();
  const actor = String(body.actor || "Unknown").trim().slice(0, 200);
  if (!runId || (!GENERATE_ACTIONS.has(action) && !DECISION_ACTIONS.has(action))) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "A campaign runId and valid action are required." }) };
  }

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    if (!run || run.runType !== "campaign") return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Campaign run not found." }) };
    const campaign = run.campaign || {};

    if (GENERATE_ACTIONS.has(action)) {
      if (!run.stages || !run.stages.research || !run.stages.research.checkpoint) {
        return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: "Campaign research is still running." }) };
      }
      const jobAge = campaign.job && campaign.job.startedAt ? Date.now() - new Date(campaign.job.startedAt).getTime() : 0;
      if (campaign.job && campaign.job.status === "running" && jobAge < 20 * 60 * 1000) {
        return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: "Another campaign response is already being prepared." }) };
      }
      if (action === "generate_thought" && !campaign.lockedIdentity) return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: "Lock a campaign identity first." }) };
      if (action === "generate_routes" && !campaign.lockedThought) return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: "Lock the campaign thought first." }) };
      if (action === "generate_assets" && !campaign.lockedRoute) return { statusCode: 409, headers: cors(), body: JSON.stringify({ error: "Select a creative route first." }) };
      if (action === "generate_assets" && !String(body.assetRequest || "").trim()) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Tell me which campaign assets to build." }) };

      const payload = {
        instruction: String(body.instruction || "").trim().slice(0, 4000),
        assetRequest: String(body.assetRequest || "").trim().slice(0, 4000),
      };
      await fbSet(`strategy_runs/${runId}/campaign/job`, { status: "running", action, instruction: payload.instruction || null, startedAt: new Date().toISOString() });
      const backgroundBody = JSON.stringify({ runId, action, payload });
      try {
        await fetch(`${siteBaseUrl(event)}/.netlify/functions/strategy-campaign-background`, {
          method: "POST",
          headers: signedBackgroundHeaders("strategy-campaign-background", backgroundBody),
          body: backgroundBody,
        });
      } catch (error) {
        await fbSet(`strategy_runs/${runId}/campaign/job`, { status: "failed", action, detail: `Could not start: ${error.message || error}`, completedAt: new Date().toISOString() });
        return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: `Could not start campaign generation: ${error.message || error}` }) };
      }
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, status: "running" }) };
    }

    const now = new Date().toISOString();
    if (action === "save_identity") {
      const id = String(body.optionId || "").trim();
      const option = findById(collectionValues(campaign.identityBatches, "options"), id);
      if (!option) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Campaign identity option not found." }) };
      const saved = Array.from(new Set([...(campaign.savedIdentityIds || []), id]));
      await fbSet(`strategy_runs/${runId}/campaign/savedIdentityIds`, saved);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, saved: true }) };
    }

    if (action === "lock_identity") {
      const custom = body.customIdentity && typeof body.customIdentity === "object" ? body.customIdentity : null;
      const option = custom ? {
        id: `custom-${Date.now()}`,
        name: String(custom.name || "").trim(), tagline: String(custom.tagline || "").trim(),
        objective: String(custom.objective || "Team-provided campaign identity").trim(), territory: String(custom.territory || "Custom direction").trim(),
      } : findById(collectionValues(campaign.identityBatches, "options"), String(body.optionId || ""));
      if (!option || !option.name || !option.tagline) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Choose a complete campaign name and tagline." }) };
      await fbSet(`strategy_runs/${runId}/campaign/lockedIdentity`, Object.assign({}, option, { lockedAt: now, lockedBy: actor }));
      await fbSet(`strategy_runs/${runId}/campaign/thoughtCandidate`, null);
      await fbSet(`strategy_runs/${runId}/campaign/lockedThought`, null);
      await fbSet(`strategy_runs/${runId}/campaign/routeBatches`, null);
      await fbSet(`strategy_runs/${runId}/campaign/lockedRoute`, null);
      await fbSet(`strategy_runs/${runId}/campaign/assets`, null);
      await remember(run, actor, "campaign_identity_locked", `${option.name} — ${option.tagline}`);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, identity: option }) };
    }

    if (action === "lock_thought") {
      const thought = body.thought && typeof body.thought === "object" ? body.thought : campaign.thoughtCandidate;
      if (!thought || !String(thought.thought || "").trim()) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Generate or write the campaign thought first." }) };
      await fbSet(`strategy_runs/${runId}/campaign/lockedThought`, Object.assign({}, thought, { lockedAt: now, lockedBy: actor }));
      await fbSet(`strategy_runs/${runId}/campaign/routeBatches`, null);
      await fbSet(`strategy_runs/${runId}/campaign/lockedRoute`, null);
      await fbSet(`strategy_runs/${runId}/campaign/assets`, null);
      await remember(run, actor, "campaign_thought_locked", String(thought.thought));
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
    }

    const route = findById(collectionValues(campaign.routeBatches, "routes"), String(body.routeId || ""));
    if (!route) return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Creative route not found." }) };
    await fbSet(`strategy_runs/${runId}/campaign/lockedRoute`, Object.assign({}, route, { lockedAt: now, lockedBy: actor }));
    await fbSet(`strategy_runs/${runId}/campaign/assets`, null);
    await fbUpdate(`strategy_runs/${runId}`, { status: "campaign_route_locked", updatedAt: now });
    await remember(run, actor, "campaign_route_locked", `${route.name}: ${route.coreIdea}`);
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, route }) };
  } catch (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message || String(error) }) };
  }
};
