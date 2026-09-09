// POST { brandId, month, actor, runtime?, sourceContext? } -> creates a strategy_runs
// entry and kicks off the Research stage as a Background Function (fire-and-forget —
// the Hub UI follows progress live via its Firebase listener on strategy_runs/<runId>,
// same reactive pattern the rest of Hub already uses everywhere else).
//
// Auth: this endpoint is meant to be called only from an already-logged-in Hub session.
// basic-auth.ts's edge gate lets ALL /.netlify/functions/* requests through unchecked
// (unlike most of Hub's other functions, this one shouldn't skip auth entirely — it can
// kick off billed AI runs and touch a client's live strategy), so this function checks the
// same site cookie itself — see ./lib/strategy/auth.js.
"use strict";
const { fbGet, fbSet } = require("./lib/strategy/firebase");
const { loadBrandConfig, loadMonthInput } = require("./lib/strategy/store");
const { checkAuthorization } = require("./lib/strategy/auth");

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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function runId(brandId, month) {
  return `${brandId}_${month}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

// process.env.URL / DEPLOY_URL are documented as build-time environment variables — their
// availability inside a Function's own runtime process.env isn't guaranteed, and appears
// not to hold live (confirmed: a run stuck in "queued" forever with nothing logged past a
// silently-caught fetch failure). The incoming request's own Host header is always
// present, so build the base URL from that instead of trusting env vars that may or may
// not exist at this point.
function siteBaseUrl(event) {
  const host = (event.headers && (event.headers.host || event.headers.Host || event.headers["x-forwarded-host"])) || "";
  if (!host) return process.env.URL || process.env.DEPLOY_URL || "";
  const proto = (event.headers && event.headers["x-forwarded-proto"]) || "https";
  return `${proto}://${host}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const brandId = String(body.brandId || "").trim();
  const month = String(body.month || "").trim();
  const actor = String(body.actor || "Unknown").trim();
  if (!/^[a-z0-9-]+$/.test(brandId)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "brandId must be lowercase letters, numbers or hyphens." }) };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "month must be YYYY-MM." }) };

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
    const runtimeName = body.runtime === "fixture" ? "fixture" : "openai";
    const now = new Date().toISOString();
    await fbSet(`strategy_runs/${id}`, {
      runId: id,
      brandId,
      month,
      runtime: runtimeName,
      fixtureDir: runtimeName === "fixture" ? (body.fixtureDir || null) : null,
      sourceContext: Array.isArray(body.sourceContext) ? body.sourceContext.filter((s) => typeof s === "string") : [],
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

    const base = siteBaseUrl(event);
    try {
      await fetch(`${base}/.netlify/functions/strategy-research-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: id }),
      });
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
