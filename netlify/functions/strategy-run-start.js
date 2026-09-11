// POST { brandId, month, actor, runtime?, sourceContext?, runType?, deliverablesOverride? }
// -> creates a strategy_runs entry and kicks off the Research stage as a Background
// Function (fire-and-forget — the Hub UI follows progress live via its Firebase listener
// on strategy_runs/<runId>, same reactive pattern the rest of Hub already uses everywhere
// else).
//
// runType ("monthly" | "campaign", defaults to "monthly") and deliverablesOverride
// ({reel: n, carousel: n, ...} — any of the brand's configured deliverable names, see
// contracts.js's BrandConfigSchema.deliverables) come from the new-run intake wizard
// (apps/strategy's NewRunWizard) — a campaign run goes through the exact same 5-stage
// pipeline as a monthly one for now (per the working-instructions doc, a campaign-specific
// pipeline is separate, later work). deliverablesOverride is a per-run-only override: it's
// read by runStrategyStage (pipeline.js) instead of the brand's own stored deliverables,
// and never written back to the brand config itself.
//
// Auth: this endpoint is meant to be called only from an already-logged-in Hub session.
// basic-auth.ts's edge gate lets ALL /.netlify/functions/* requests through unchecked
// (unlike most of Hub's other functions, this one shouldn't skip auth entirely — it can
// kick off billed AI runs and touch a client's live strategy), so this function checks the
// perimeter cookie and the caller's Firebase team session — see ./lib/strategy/auth.js.
"use strict";
const { fbGet, fbSet } = require("./lib/strategy/firebase");
const { loadBrandConfig, loadMonthInput } = require("./lib/strategy/store");
const { checkAuthorization } = require("./lib/strategy/auth");
const { triggerBackground } = require("./lib/strategy/background-trigger");

// A run only stops being "active" once its very last stage (deck-builder) has been
// approved — everything before that, including "failed", is still active: a failed run
// is meant to be retried via strategy-stage-retry.js, not silently duplicated by starting
// a second run for the same brand + month underneath it. An archived run (see
// index.html's soArchiveRun) is the other way out: the Hub UI uses it for stale/abandoned
// runs that aren't going to be retried, and archiving one deliberately frees up its
// brand + month for a fresh run without needing to touch its status.
function isActiveRun(run) {
  return run.status !== "deck-builder_approved" && !run.archivedAt;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function runId(brandId, month) {
  return `${brandId}_${month}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = await checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const brandId = String(body.brandId || "").trim();
  const month = String(body.month || "").trim();
  const actor = auth.actor;
  if (!/^[a-z0-9-]+$/.test(brandId)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "brandId must be lowercase letters, numbers or hyphens." }) };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "month must be YYYY-MM." }) };

  const runType = body.runType === "campaign" ? "campaign" : "monthly";
  // An open map of {deliverableName: count} — not just reel/carousel/static, since the
  // wizard's deliverables editor (DeliverablesFields.tsx) can list any of the brand's
  // configured deliverable names, including ones added on the fly (see contracts.js's
  // BrandConfigSchema.deliverables). Every value just has to be a non-negative integer.
  let deliverablesOverride = null;
  if (body.deliverablesOverride && typeof body.deliverablesOverride === "object" && !Array.isArray(body.deliverablesOverride)) {
    deliverablesOverride = {};
    for (const [name, rawValue] of Object.entries(body.deliverablesOverride)) {
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value < 0) {
        return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `deliverablesOverride.${name} must be a non-negative integer.` }) };
      }
      deliverablesOverride[name] = value;
    }
  }

  try {
    // Fail fast with a clear error if the brand isn't configured, rather than creating a
    // run doc that can never start.
    await loadBrandConfig(brandId);
    await loadMonthInput(brandId, month);

    // Prevent duplicate active runs for the same brand + month (brief: "Prevent duplicate
    // active runs for the same brand and month"). There's no indexed query support in the
    // plain-REST firebase.js helper, so this reads the whole strategy_runs node and filters
    // in memory — fine at Loona's actual run volume, and matches the same "read the whole
    // node" pattern the Hub UI's own listeners already use for this data.
    const allRuns = (await fbGet("strategy_runs")) || {};
    const existing = Object.values(allRuns).find(
      (r) => r && r.brandId === brandId && r.month === month && isActiveRun(r)
    );
    if (existing) {
      return {
        statusCode: 409,
        headers: cors(),
        body: JSON.stringify({
          error: `There's already an active run for this brand and month (status: ${existing.status}). Open it instead of starting a new one.`,
          existingRunId: existing.runId,
        }),
      };
    }

    const id = runId(brandId, month);
    // "openai" (default), "fixture" (offline testing), or "claude" (Anthropic runtime —
    // see runtime-claude.js; every agent runs through the same createRuntime() in
    // pipeline.js, so this one field is all it takes to run any stage on Claude instead).
    const runtimeName = body.runtime === "fixture" ? "fixture" : body.runtime === "claude" ? "claude" : "openai";
    const now = new Date().toISOString();
    await fbSet(`strategy_runs/${id}`, {
      runId: id,
      brandId,
      month,
      runtime: runtimeName,
      fixtureDir: runtimeName === "fixture" ? (body.fixtureDir || null) : null,
      sourceContext: Array.isArray(body.sourceContext) ? body.sourceContext.filter((s) => typeof s === "string") : [],
      runType,
      deliverablesOverride,
      owner: actor,
      createdAt: now,
      updatedAt: now,
      status: "draft",
      stages: {
        research: { status: "queued" },
        strategy: { status: "locked" },
        copy: { status: "locked" },
        "creative-direction": { status: "locked" },
        "deck-builder": { status: "locked" },
      },
      approvals: {},
    });

    try {
      await triggerBackground(event, "strategy-research-background", { runId: id });
    } catch (e) {
      // Write the failure into the run doc itself — previously this was only
      // console.error'd, which left the run silently stuck showing "queued" forever with
      // no visible error anywhere the UI could show it.
      console.error("Failed to trigger research background function:", e);
      await fbSet(`strategy_runs/${id}/stages/research`, { status: "failed", detail: `Could not start the Research stage: ${e.message || e}` });
      await fbSet(`strategy_runs/${id}/status`, "failed");
    }

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ runId: id }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }
};
