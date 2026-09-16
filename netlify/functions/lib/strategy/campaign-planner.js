"use strict";

const { z } = require("zod");
const { fbGet, fbPush, fbSet, fbUpdate } = require("./firebase");
const { loadBrandConfig, loadLearnings, loadBrandBrain } = require("./store");
const { createRuntime, buildStrategyResearchBrief } = require("./pipeline");

const Text = z.string().min(1);
const IdentityOptionSchema = z.object({
  id: Text,
  name: Text,
  tagline: Text,
  objective: Text,
  territory: Text,
}).strict();

const IdentityOptionsSchema = z.object({
  options: z.array(IdentityOptionSchema).length(3),
}).strict();

const CampaignThoughtSchema = z.object({
  thought: Text,
  strategicRole: Text,
  brandConnection: Text,
  audienceTakeaway: Text,
}).strict();

const CreativeRouteSchema = z.object({
  id: Text,
  name: Text,
  coreIdea: Text,
  howItComesAlive: Text,
  heroExecution: Text,
  whyItWorks: Text,
}).strict();

const CreativeRoutesSchema = z.object({
  routes: z.array(CreativeRouteSchema).length(3),
}).strict();

const CampaignAssetSchema = z.object({
  id: Text,
  format: Text,
  title: Text,
  idea: Text,
  onCreativeCopy: Text,
  caption: Text,
  creativeDirection: Text,
}).strict();

const CampaignAssetsSchema = z.object({
  assets: z.array(CampaignAssetSchema).min(1).max(20),
}).strict();

const SCHEMAS = {
  generate_identities: IdentityOptionsSchema,
  generate_thought: CampaignThoughtSchema,
  generate_routes: CreativeRoutesSchema,
  generate_assets: CampaignAssetsSchema,
};

function values(node) {
  return node && typeof node === "object" ? Object.values(node) : [];
}

function fixtureOutput(action) {
  if (action === "generate_identities") return { options: [
    { id: "identity-1", name: "One Idea, Every Scale", tagline: "Made to belong wherever life happens.", objective: "Turn product adaptability into the campaign's central promise.", territory: "A single design language moving confidently across different spaces and occasions." },
    { id: "identity-2", name: "Room to Become", tagline: "The same character, shaped for your space.", objective: "Make choice feel expressive rather than complicated.", territory: "People see one recognisable design become part of very different lives." },
    { id: "identity-3", name: "Fits the Feeling", tagline: "Right design. Right scale. Right where you are.", objective: "Reframe fit as emotional and spatial confidence.", territory: "The campaign resolves the hesitation between loving an object and knowing it belongs." },
  ] };
  if (action === "generate_thought") return { thought: "People rarely doubt the design they love; they doubt whether it will belong in their life. The campaign removes that hesitation by showing one recognisable idea adapting without losing its character.", strategicRole: "Move the conversation from product dimensions to confidence of choice.", brandConnection: "The brand becomes the maker that understands both design integrity and real spaces.", audienceTakeaway: "I do not have to compromise the design I love to make it fit." };
  if (action === "generate_routes") return { routes: [
    { id: "route-1", name: "The Fit Check", coreIdea: "Turn the audience's private fit anxiety into a confident visual answer.", howItComesAlive: "The same design moves through contrasting spaces while its character remains unmistakable.", heroExecution: "A film that cuts from an intimate corner to a large gathering around the same design family.", whyItWorks: "It resolves the campaign tension in a visual, immediately understandable way." },
    { id: "route-2", name: "Same Soul, New Room", coreIdea: "Treat every size as a different expression of the same personality.", howItComesAlive: "Paired portraits connect people, rooms and product scales through matching composition.", heroExecution: "A carousel of mirrored scenes where only the room and scale change.", whyItWorks: "It keeps the product family coherent while creating variety." },
    { id: "route-3", name: "Where It Belongs", coreIdea: "Show that belonging is a feeling, not a measurement.", howItComesAlive: "Human moments lead each execution; the product scale quietly proves itself in context.", heroExecution: "A series of short films built around recognisable moments in differently sized spaces.", whyItWorks: "It makes a functional advantage emotionally memorable." },
  ] };
  return { assets: [
    { id: "asset-1", format: "reel", title: "One idea, two lives", idea: "Mirror the selected route across two contrasting spaces.", onCreativeCopy: "Same character. A different kind of room.", caption: "The design you love should not depend on the size of the room. It should simply belong.", creativeDirection: "Match camera angle and human gesture across both spaces; let scale be the only reveal." },
  ] };
}

function compactCampaignContext(run) {
  const campaign = run.campaign || {};
  return {
    brief: campaign.brief || {},
    lockedIdentity: campaign.lockedIdentity || null,
    lockedThought: campaign.lockedThought || null,
    lockedRoute: campaign.lockedRoute || null,
    previousIdentityOptions: values(campaign.identityBatches).flatMap((batch) => batch.options || []),
    previousRoutes: values(campaign.routeBatches).flatMap((batch) => batch.routes || []),
  };
}

function instructionsFor(action) {
  const shared = `You are Loona's campaign strategist. Work from the brand truth, evidence, and approved campaign brief. Be specific enough that a competitor could not simply replace the logo. Avoid generic marketing language, invented product claims, and explanations disguised as names. Return only the requested structured output.`;
  if (action === "generate_identities") return `${shared}\nCreate exactly three distinct overarching campaign identity options. Each option needs a memorable campaign name, a tagline immediately beneath it, a short objective, and the creative territory it opens. Names must be short enough to use as a campaign title. Do not repeat or lightly reword any previous option.`;
  if (action === "generate_thought") return `${shared}\nDevelop the strategic campaign thought behind the locked name and tagline. This is the central reasoning that every creative route must express, not another tagline and not a list of executions.`;
  if (action === "generate_routes") return `${shared}\nCreate exactly three genuinely different creative routes that bring the locked campaign identity and thought to life. These are executions of one campaign, not competing campaign names. Make each route producible and explain its hero execution.`;
  return `${shared}\nBuild the requested campaign assets from the locked identity, campaign thought, and selected creative route. Follow the user's requested formats and quantity exactly. For every asset provide the idea, actual on-creative words, a usable caption, and concrete creative direction.`;
}

async function generateCampaignOutput(run, action, payload) {
  if (run.runtime === "fixture") return fixtureOutput(action);
  const config = await loadBrandConfig(run.brandId);
  const [learnings, brandBrain] = await Promise.all([
    loadLearnings(run.brandId),
    loadBrandBrain(run.brandId, config.name),
  ]);
  const research = run.stages && run.stages.research && run.stages.research.checkpoint;
  const runtime = createRuntime(run, "strategy");
  return runtime.runStage({
    stage: `campaign-${action}`,
    agentName: "Dora — Campaign Strategy",
    instructions: instructionsFor(action),
    input: {
      brandConfig: config,
      learnings,
      brandBrain,
      research: research ? buildStrategyResearchBrief(research) : null,
      campaign: compactCampaignContext(run),
      instruction: String((payload && payload.instruction) || "").trim() || null,
      assetRequest: String((payload && payload.assetRequest) || "").trim() || null,
    },
    outputSchema: SCHEMAS[action],
    toolProfile: "none",
  });
}

async function runCampaignAction(runId, action, payload) {
  const run = await fbGet(`strategy_runs/${runId}`);
  if (!run || run.runType !== "campaign") throw new Error("Campaign run not found.");
  try {
    const output = await generateCampaignOutput(run, action, payload || {});
    const now = new Date().toISOString();
    if (action === "generate_identities") {
      await fbPush(`strategy_runs/${runId}/campaign/identityBatches`, { options: output.options, instruction: payload.instruction || null, createdAt: now });
    } else if (action === "generate_thought") {
      await fbSet(`strategy_runs/${runId}/campaign/thoughtCandidate`, Object.assign({}, output, { instruction: payload.instruction || null, createdAt: now }));
    } else if (action === "generate_routes") {
      await fbPush(`strategy_runs/${runId}/campaign/routeBatches`, { routes: output.routes, instruction: payload.instruction || null, createdAt: now });
    } else if (action === "generate_assets") {
      await fbSet(`strategy_runs/${runId}/campaign/assets`, output.assets);
      await fbSet(`strategy_runs/${runId}/campaign/assetRequest`, payload.assetRequest || "");
      await fbUpdate(`strategy_runs/${runId}`, { status: "campaign_assets_ready", updatedAt: now });
    }
    await fbSet(`strategy_runs/${runId}/campaign/job`, { status: "ready", action, completedAt: now });
    return output;
  } catch (error) {
    await fbSet(`strategy_runs/${runId}/campaign/job`, { status: "failed", action, detail: error.message || String(error), completedAt: new Date().toISOString() });
    throw error;
  }
}

module.exports = {
  IdentityOptionsSchema, CampaignThoughtSchema, CreativeRoutesSchema, CampaignAssetsSchema,
  generateCampaignOutput, runCampaignAction,
};
