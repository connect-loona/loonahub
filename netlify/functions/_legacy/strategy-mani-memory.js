"use strict";
// POST { brandId, content, actor } — saves a team-pasted source note for Mani.
// This is deliberately separate from asking Mani a question: pasted material is evidence,
// not an instruction, and remains attributable to the person who supplied it.
const { fbPush, fbSafeKey, fbSet } = require("../lib/strategy/firebase");
const { checkAuthorization } = require("../lib/strategy/auth");
const { hubBrandExists } = require("../lib/strategy/hub-brands");
const { recordManiEventSafe } = require("../lib/strategy/mani-events");
const { findHubBrand } = require("../lib/strategy/hub-brands");
const { siteBaseUrl } = require("../lib/site-base-url");
const { signedBackgroundHeaders } = require("../lib/strategy/background-auth");

function headers() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" }; }
function fail(statusCode, error) { return { statusCode, headers: headers(), body: JSON.stringify({ error }) }; }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  const auth = checkAuthorization(event);
  if (!auth.ok) return fail(401, `Unauthorized — ${auth.reason}`);
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }
  const brandId = String(body.brandId || "").trim();
  const content = String(body.content || "").trim();
  const actor = String(body.actor || "Hub team").trim().slice(0, 120);
  if (!/^[a-z0-9-]+$/.test(brandId)) return fail(400, "Choose a valid brand first.");
  if (!content) return fail(400, "Paste something for Mani to remember.");
  // A complete conversation export is useful source material. Do not impose an
  // application-level character cap here: Firebase/HTTP's own safe payload limits
  // remain the only practical boundary, rather than arbitrarily making the team
  // split an export into separate memories.
  if (!(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");
  try {
    const now = new Date().toISOString();
    const id = await fbPush(`mani_brand_notes/${fbSafeKey(brandId)}`, { content, source: "team_paste", actor, createdAt: now });
    await recordManiEventSafe({ type: "team_memory_added", source: "mani_panel", brandId, actor, entityType: "memory_note", entityId: id, action: "saved", summary: `Added ${content.length.toLocaleString()} characters of team-pasted context to Mani memory.` });
    // Every new source should refresh the configuration draft automatically. The draft is
    // deliberately not saved over the team's Brand Directory: it appears in the form for
    // review, then the team chooses Save after checking the generated fields.
    const brand = await findHubBrand(brandId);
    const name = brand?.name || brandId;
    const draftPath = `strategy_brand_drafts/${fbSafeKey(brandId)}`;
    await fbSet(draftPath, { brandId, name, source: "mani_memory", status: "drafting", startedAt: now, draft: null, error: null });
    const backgroundBody = JSON.stringify({ brandId, name });
    try {
      const response = await fetch(`${siteBaseUrl(event)}/.netlify/functions/strategy-mani-config-draft-background`, {
        method: "POST", headers: signedBackgroundHeaders("strategy-mani-config-draft-background", backgroundBody), body: backgroundBody
      });
      if (!response.ok) throw new Error(`Could not start Mani's draft (${response.status}).`);
    } catch (draftError) {
      await fbSet(draftPath, { brandId, name, source: "mani_memory", status: "failed", draft: null, completedAt: new Date().toISOString(), error: draftError.message || String(draftError) });
    }
    return { statusCode: 200, headers: headers(), body: JSON.stringify({ ok: true, id, drafting: true }) };
  } catch (error) { return fail(500, error.message || "Could not save Mani memory."); }
};
