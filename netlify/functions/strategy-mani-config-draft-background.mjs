import firebase from "./lib/strategy/firebase.js";
import pipeline from "./lib/strategy/pipeline.js";
import brandDraft from "./lib/strategy/brand-draft.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";
const { fbGet, fbSet, fbSafeKey } = firebase;
const { createRuntime } = pipeline;
const { draftBrandFromLibrary } = brandDraft;
export default async function (request) {
  const body = await readSignedBackgroundBody(request, "strategy-mani-config-draft-background"); if (!body) return;
  const brandId = String(body.brandId || "").trim(); const name = String(body.name || "").trim(); if (!brandId || !name) return;
  const path = `strategy_brand_drafts/${fbSafeKey(brandId)}`;
  try {
    const notes = Object.values((await fbGet(`mani_brand_notes/${fbSafeKey(brandId)}`)) || {}).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const text = notes.map((note) => `--- ${note.createdAt || ""} · ${note.actor || "Hub team"} ---\n${note.content || ""}`).join("\n\n").slice(0, 70000);
    const runtime = createRuntime({ runtime: "openai" }, "strategy");
    const draft = await draftBrandFromLibrary(runtime, name, { files: [{ name: "Team-pasted Mani memory", path: "Mani memory", text }], unreadFiles: [] });
    await fbSet(path, { brandId, name, source: "mani_memory", status: "ready", draft, completedAt: new Date().toISOString(), servedBy: runtime.servedBy || null, error: null });
  } catch (error) { await fbSet(path, { brandId, name, source: "mani_memory", status: "failed", draft: null, completedAt: new Date().toISOString(), error: error.message || String(error) }); }
}
export const config = backgroundConfig;
