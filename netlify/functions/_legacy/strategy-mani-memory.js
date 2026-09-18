"use strict";
// POST { brandId, content, actor } — saves a team-pasted source note for Mani.
// This is deliberately separate from asking Mani a question: pasted material is evidence,
// not an instruction, and remains attributable to the person who supplied it.
const { fbPush, fbSafeKey } = require("../lib/strategy/firebase");
const { checkAuthorization } = require("../lib/strategy/auth");
const { hubBrandExists } = require("../lib/strategy/hub-brands");
const { recordManiEventSafe } = require("../lib/strategy/mani-events");

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
    return { statusCode: 200, headers: headers(), body: JSON.stringify({ ok: true, id }) };
  } catch (error) { return fail(500, error.message || "Could not save Mani memory."); }
};
