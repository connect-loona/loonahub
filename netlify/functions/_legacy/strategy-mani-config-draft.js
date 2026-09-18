"use strict";
const { fbGet, fbSet, fbSafeKey } = require("../lib/strategy/firebase");
const { checkAuthorization } = require("../lib/strategy/auth");
const { hubBrandExists } = require("../lib/strategy/hub-brands");
const { createRuntime } = require("../lib/strategy/pipeline");
const { draftBrandFromLibrary } = require("../lib/strategy/brand-draft");
function headers() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" }; }
function fail(statusCode, error) { return { statusCode, headers: headers(), body: JSON.stringify({ error }) }; }
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  const auth = checkAuthorization(event); if (!auth.ok) return fail(401, `Unauthorized — ${auth.reason}`);
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }
  const brandId = String(body.brandId || "").trim(); const name = String(body.name || "").trim();
  if (!/^[a-z0-9-]+$/.test(brandId) || !name) return fail(400, "Choose a valid brand first.");
  if (!(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");
  const notes = await fbGet(`mani_brand_notes/${fbSafeKey(brandId)}`);
  if (!notes || !Object.keys(notes).length) return fail(400, "Paste brand context into Mani memory before drafting the configuration.");
  const path = `strategy_brand_drafts/${fbSafeKey(brandId)}`;
  await fbSet(path, { brandId, name, source: "mani_memory", status: "drafting", startedAt: new Date().toISOString(), draft: null, error: null });
  try {
    // This used to hand work to a background function. On the live site that worker can
    // fail before its handler runs, leaving the UI permanently at “Drafting…”. Drafting
    // directly gives the team a completed form or a real visible error, never a silent
    // queue state.
    const orderedNotes = Object.values(notes).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const text = orderedNotes.map((note) => `--- ${note.createdAt || ""} · ${note.actor || "Hub team"} ---\n${note.content || ""}`).join("\n\n").slice(0, 70000);
    const runtime = createRuntime({ runtime: "openai" }, "strategy");
    const draft = await draftBrandFromLibrary(runtime, name, { files: [{ name: "Team-pasted Mani memory", path: "Mani memory", text }], unreadFiles: [] });
    await fbSet(path, { brandId, name, source: "mani_memory", status: "ready", draft, completedAt: new Date().toISOString(), servedBy: runtime.servedBy || null, error: null });
    return { statusCode: 200, headers: headers(), body: JSON.stringify({ ok: true, brandId }) };
  } catch (error) { await fbSet(path, { brandId, name, status: "failed", draft: null, completedAt: new Date().toISOString(), error: error.message || String(error) }); return fail(502, error.message || "Could not draft the configuration."); }
};
