// Loona Brain's third input: what the team has been generating visually for each brand.
//
// Visual Studio keeps the image bytes in object storage and the searchable record here.
// Approved finals can still be copied into Drive for the existing production workflow.
// the prompt someone actually typed, which model made it, how many takes it took, and which
// take they chose. That is the part nobody ever writes down, and it is the part that says how
// this brand is really being made.
//
// So every generation is recorded here, and the picks become durable brand memory. A year of
// this is a genuine record of what visual direction this brand converged on — readable by the
// strategy agents, and the raw material for training something brand-specific later.
//
// A deliberate consequence of not hosting images: a provider's image URL expires (OpenAI's in
// about an hour). A record therefore keeps the prompt forever and the preview only while it
// lasts, and says which it is rather than rendering a broken image and calling it history.
"use strict";
const { fbGet, fbPush, fbSet, fbSafeKey } = require("./firebase");

// How long a provider's returned image URL is worth showing before it's assumed dead. Erring
// short is right: a preview that quietly 404s is worse than one honestly marked expired.
const PREVIEW_TTL_MS = 55 * 60 * 1000;
const MAX_PROMPT_CHARS = 2000;
const MAX_RECENT = 40;
const MAX_PICKED_IN_PROMPT = 15;

function visualPath(brandId) {
  return `strategy_visual/${fbSafeKey(brandId)}`;
}

// One generation round: what was asked for, what produced it, and what came back. Written the
// moment the images return, before anybody has chosen — an abandoned round is still evidence
// about what this brand's team tried and rejected.
async function recordGeneration(brandId, round) {
  if (!brandId) throw new Error("recordGeneration needs a brandId.");
  const record = {
    prompt: String(round.prompt || "").slice(0, MAX_PROMPT_CHARS),
    // Which conversation this round happened in. Null for a one-off generation with no chat,
    // which keeps every record written before chats existed readable.
    chatId: round.chatId || null,
    provider: round.provider || "unknown",
    model: round.model || null,
    // The shape this round was actually made at — never stored before this, so a follow-up had
    // no way to ask for the same one back except the person remembering to reselect it. See
    // image-shapes.js for the key; null for anything recorded before shapes existed at all.
    size: round.size || null,
    operation: round.operation || "generate",
    providerTaskId: round.providerTaskId || null,
    actor: round.actor || "unknown",
    // What the team started from, if anything — Visual Studio's whole point is that people
    // work from a reference, not from a blank prompt (see the ChatGPT workflows this copies).
    referenceCount: Number(round.referenceCount || 0),
    referenceNote: round.referenceNote || null,
    // Which rules actually shaped this image (see visual-rules.js). Stored so the record can
    // show what was applied rather than the UI claiming it.
    appliedRules: (round.appliedRules || []).map((rule) => ({ key: rule.key, label: rule.label, source: rule.source })),
    // What the image model was actually asked for, once the person's words were expanded with
    // the thread and the brand's memory (see visual-prompt.js). Null when no rewrite happened.
    // Kept because it is the only way to tell a bad image apart from a bad rewrite later.
    expandedPrompt: round.expandedPrompt || null,
    // "draft" or "final" — see QUALITY_MODES. A draft that looks soft later is explained by
    // this rather than looking like the model underperforming.
    quality: round.quality === "final" ? "final" : "draft",
    images: (round.images || []).map((image) => ({
      url: image.url || null,
      assetKey: image.assetKey || null,
      durable: Boolean(image.durable),
      contentType: image.contentType || null,
      byteLength: Number(image.byteLength || 0) || null,
      revisedPrompt: image.revisedPrompt || null,
    })),
    referenceAssets: (round.referenceAssets || []).map((reference) => ({
      assetKey: reference.assetKey || null,
      // Dropped here previously, unlike the durable url already kept for generated output
      // images above — the reference itself was stored and servable, but nothing recorded how
      // to actually show it once a round became history.
      dataUrl: reference.dataUrl || null,
      name: reference.name || null,
      role: reference.role || null,
      contentType: reference.contentType || null,
    })).filter((reference) => reference.assetKey),
    parentGenerationId: round.parentGenerationId || null,
    parentImageIndex: Number.isInteger(round.parentImageIndex) ? round.parentImageIndex : null,
    suggestions: Array.isArray(round.suggestions) ? round.suggestions.slice(0, 4) : [],
    createdAt: new Date().toISOString(),
    // Filled in later by recordPick, if anyone ever chooses one.
    pickedIndex: null,
    pickedAt: null,
    pickedBy: null,
  };
  const id = round.id || await fbPush(visualPath(brandId), record);
  if (round.id) await fbSet(`${visualPath(brandId)}/${fbSafeKey(round.id)}`, record);
  return { id, record };
}

// Which take a human chose. This is the signal worth the most: a prompt tells you what someone
// asked for, but the pick tells you what this brand actually looks like when a person with
// taste decides.
async function recordPick(brandId, generationId, { index, actor, note, tags }) {
  if (!brandId || !generationId) throw new Error("recordPick needs a brandId and a generationId.");
  const key = `${visualPath(brandId)}/${fbSafeKey(generationId)}`;
  const existing = await fbGet(key);
  if (!existing) throw new Error(`No generation ${generationId} for brand ${brandId}.`);
  if (!Array.isArray(existing.images) || index >= existing.images.length) {
    throw new Error(`Take ${Number(index) + 1} does not exist in generation ${generationId}.`);
  }
  const updated = Object.assign({}, existing, {
    pickedIndex: Number(index),
    pickedAt: new Date().toISOString(),
    pickedBy: actor || "unknown",
    pickNote: note ? String(note).slice(0, MAX_PROMPT_CHARS) : null,
    pickTags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
  });
  await fbSet(key, updated);
  return updated;
}

async function recordQc(brandId, generationId, qc) {
  const key = `${visualPath(brandId)}/${fbSafeKey(generationId)}`;
  const existing = await fbGet(key);
  if (!existing) throw new Error(`No generation ${generationId} for brand ${brandId}.`);
  const updated = Object.assign({}, existing, { qc });
  await fbSet(key, updated);
  return updated;
}

function isPreviewLive(record, now) {
  if (!record || !record.createdAt) return false;
  if ((record.images || []).some((image) => image && image.durable && image.assetKey)) return true;
  return (now || Date.now()) - Date.parse(record.createdAt) < PREVIEW_TTL_MS;
}

// Newest first, with each record told plainly whether its preview is still worth rendering.
async function loadVisualHistory(brandId, options = {}) {
  const raw = (await fbGet(visualPath(brandId))) || {};
  const now = options.now || Date.now();
  return Object.entries(raw)
    .map(([id, record]) => Object.assign({ id }, record, { previewExpired: !isPreviewLive(record, now) }))
    .filter((record) => !options.chatId || record.chatId === options.chatId)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .filter((record) => !options.before || String(record.createdAt || "") < String(options.before))
    .slice(0, Math.min(Number(options.limit) || MAX_RECENT, 100));
}

// The block the stage prompts see. Only the PICKED rounds — an unpicked round is useful as a
// record of what was tried, but it says nothing reliable about the brand's direction, and
// feeding every abandoned attempt to a writing model would teach it the opposite of taste.
function visualHistoryToPromptText(history) {
  const picked = (history || []).filter((record) => record.pickedIndex !== null && record.pickedIndex !== undefined);
  if (!picked.length) return null;
  const lines = picked.slice(0, MAX_PICKED_IN_PROMPT).map((record) => {
    const when = String(record.createdAt || "").slice(0, 10);
    const tags = Array.isArray(record.pickTags) && record.pickTags.length ? ` Signals: ${record.pickTags.join(", ")}.` : "";
    const note = record.pickNote ? ` Chosen because: ${record.pickNote}` : "";
    const took = record.images && record.images.length > 1 ? ` (chosen from ${record.images.length} takes)` : "";
    // WHO wrote the prompt and WHO chose the take. Both were always stored and neither ever
    // reached the agents, so "which of us made this creative" — a question with an exact
    // recorded answer — could not be answered by the one thing holding the answer.
    const madeBy = record.actor && record.actor !== "unknown" ? ` — written by ${record.actor}` : "";
    const chosenBy = record.pickedBy && record.pickedBy !== record.actor && record.pickedBy !== "unknown"
      ? `, chosen by ${record.pickedBy}` : "";
    return `- ${when} · ${record.provider}${record.model ? `/${record.model}` : ""}${took}: "${record.prompt}"${madeBy}${chosenBy}${tags}${note}`;
  });
  return [
    "# Visual direction this brand has actually chosen",
    "Image prompts the team wrote in Visual Studio, limited to the takes a human picked. This is what this brand looks like in practice, not what a guideline says it should look like. Use it for visual consistency; it is not content to write about, and the prompts are not copy.",
    "",
    ...lines,
  ].join("\n");
}

async function loadVisualPromptText(brandId, options) {
  try {
    return visualHistoryToPromptText(await loadVisualHistory(brandId, options));
  } catch (error) {
    console.error(`Could not load visual memory for ${brandId}:`, error.message);
    return null;
  }
}

module.exports = {
  recordGeneration, recordPick, recordQc, loadVisualHistory, loadVisualPromptText,
  visualHistoryToPromptText, isPreviewLive, visualPath,
  PREVIEW_TTL_MS, MAX_RECENT,
};
