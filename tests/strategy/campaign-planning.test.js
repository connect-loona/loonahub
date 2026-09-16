// End-to-end contract for the dedicated conversational campaign flow. A campaign must
// research first, then move through identity -> thought -> routes -> assets without
// accidentally running the monthly Strategy/Copy/Direction pipeline.
"use strict";

const path = require("path");
const { HUB, RTDB_URL, DEV_LITE_URL, req, waitFor, waitForBackgroundIdle } = require("../harness/shared");
const api = (name, body) => req("POST", `${DEV_LITE_URL}/.netlify/functions/${name}`, body, { auth: true });

let allPass = true;
function check(name, condition, detail) {
  console.log(`${condition ? "✅" : "❌"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  allPass = allPass && condition;
}

async function runDoc(runId) {
  return (await req("GET", `${RTDB_URL}/strategy_runs/${runId}.json`)).body;
}

async function waitCampaign(runId, predicate, label) {
  return waitFor(async () => {
    const run = await runDoc(runId);
    return run && predicate(run) ? run : null;
  }, { label });
}

(async () => {
  const fixtureDir = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
  const brief = {
    occasion: "A new adaptable product family", objective: "Build consideration", audience: "Design-conscious homeowners",
    currentMessage: "One design language", available: "Products and founders", rules: "No invented claims", launchDate: "2026-11-08",
  };
  const started = await api("strategy-run-start", {
    brandId: "rro", month: "2026-10", actor: "Campaign Tester", runType: "campaign", chatMode: true,
    runtime: "fixture", fixtureDir, campaignBrief: brief, sourceContext: Object.values(brief),
  });
  check("campaign run starts", started.status === 200, started.body);
  const runId = started.body.runId;
  const researched = await waitCampaign(runId, (run) => Boolean(run.stages.research.checkpoint), "campaign research");
  check("brief is stored as structured campaign state", researched.campaign.brief.occasion === brief.occasion, researched.campaign.brief);
  check("campaign chat runs research only", !researched.stages.strategy.checkpoint && researched.stages.strategy.status === "locked", researched.stages.strategy);

  let response = await api("strategy-campaign-action", { runId, action: "generate_identities", actor: "Campaign Tester" });
  check("identity generation is queued", response.status === 200, response.body);
  let run = await waitCampaign(runId, (value) => Object.values(value.campaign.identityBatches || {}).length === 1, "campaign identities");
  const identities = Object.values(run.campaign.identityBatches)[0].options;
  check("exactly three campaign identities are generated", identities.length === 3, identities);
  check("identity carries name and tagline", Boolean(identities[0].name && identities[0].tagline), identities[0]);

  response = await api("strategy-campaign-action", { runId, action: "save_identity", actor: "Campaign Tester", optionId: identities[1].id });
  check("an unselected identity can be saved for later", response.status === 200, response.body);
  response = await api("strategy-campaign-action", { runId, action: "lock_identity", actor: "Campaign Tester", optionId: identities[0].id });
  check("campaign identity locks", response.status === 200, response.body);

  await api("strategy-campaign-action", { runId, action: "generate_thought", actor: "Campaign Tester" });
  run = await waitCampaign(runId, (value) => Boolean(value.campaign.thoughtCandidate), "campaign thought");
  check("campaign thought is generated after identity", Boolean(run.campaign.thoughtCandidate.thought), run.campaign.thoughtCandidate);
  response = await api("strategy-campaign-action", { runId, action: "lock_thought", actor: "Campaign Tester", thought: run.campaign.thoughtCandidate });
  check("campaign thought locks", response.status === 200, response.body);

  await api("strategy-campaign-action", { runId, action: "generate_routes", actor: "Campaign Tester" });
  run = await waitCampaign(runId, (value) => Object.values(value.campaign.routeBatches || {}).length === 1, "campaign routes");
  const routes = Object.values(run.campaign.routeBatches)[0].routes;
  check("three creative routes are generated", routes.length === 3, routes);
  response = await api("strategy-campaign-action", { runId, action: "lock_route", actor: "Campaign Tester", routeId: routes[0].id });
  check("creative route locks", response.status === 200, response.body);

  await api("strategy-campaign-action", { runId, action: "generate_assets", actor: "Campaign Tester", assetRequest: "One launch reel" });
  run = await waitCampaign(runId, (value) => Array.isArray(value.campaign.assets) && value.campaign.assets.length > 0, "campaign assets");
  check("campaign assets include copy, caption and direction", Boolean(run.campaign.assets[0].onCreativeCopy && run.campaign.assets[0].caption && run.campaign.assets[0].creativeDirection), run.campaign.assets[0]);
  check("completed campaign reaches assets-ready status", run.status === "campaign_assets_ready", run.status);

  await waitForBackgroundIdle();
  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
