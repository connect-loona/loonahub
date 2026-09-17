// Replaces loona-strategy-agents/src/core/files.ts's local-disk reads/writes with
// Firebase-backed ones — Netlify Functions have no persistent shared filesystem across
// invocations, so brand config / month input / learnings / run checkpoints all have to
// live in the same Firebase RTDB the rest of Hub already uses (see docs/DEPLOYMENT.md in
// the supplied package, which flags exactly this as the thing to fix before going live).
//
// Brand config, month input, learnings, and the house-rules/stage prompts are all seeded
// from require()'d data rather than fs.readFileSync(__dirname, ...) at runtime. That's
// deliberate, not a style choice: Netlify's esbuild function bundler concatenates every
// require()'d module into ONE output file per function, so __dirname inside the bundled
// code no longer points at this file's original nested directory
// (netlify/functions/lib/strategy/) — a runtime fs read for a sibling ./seed/*.json file
// silently misses even with `included_files` in netlify.toml correctly copying the actual
// files into the deploy (verified live: they land at the right path on disk, just not the
// path this bundled code computes). require()'ing the data instead sidesteps the problem
// entirely — JSON and JS modules get inlined as literal data directly into the same
// bundle by esbuild, so there's no separate file to locate at runtime at all.
//
// Brand config/month input/learnings are seeded into Firebase once, on first read, then
// live there from that point on — editable later through a proper config-editing screen
// (brief section 13) instead of only through git.
"use strict";
const { BrandConfigSchema, MonthInputSchema } = require("./contracts");
const { fbGet, fbSet, fbSafeKey } = require("./firebase");
const { loadBrandLibrary: loadDriveBrandLibrary } = require("./google-drive");
const { loadBrain, brainToPromptText } = require("./brand-brain");
const { loadTeamActivityText } = require("./team-activity");
const { loadVisualPromptText } = require("./visual-memory");
const { composeAgentInstructions } = require("./bb-loona");
const { HOUSE_RULES, RESEARCH_PROMPT, STRATEGY_PROMPT, COPY_PROMPT, DIRECTION_PROMPT, DECK_BUILDER_PROMPT, CONCEPT_REFINE_PROMPT, COPY_REFINE_PROMPT, RRO_LEARNINGS_SEED } = require("./prompts-data");

// Add one line per new brand here (and to SEED_MONTH_INPUTS/SEED_LEARNINGS below) when
// brands/<id>.config.json grows beyond RRO — see brief section "Adding a brand".
const SEED_BRAND_CONFIGS = {
  rro: require("./seed/rro.config.json"),
};
const SEED_MONTH_INPUTS = {
  "rro:2026-10": require("./seed/rro.2026-10.month.json"),
};
const SEED_LEARNINGS = {
  rro: RRO_LEARNINGS_SEED,
};
// Decision types that represent a durable "don't repeat this" signal — see loadLearnings'
// own comment on why these get a much larger retention window than routine feedback.
// "critic_objection" joins this set even though nobody typed it — an independent critic
// flagging a real problem (a weak brand anchor, repeated exhausted territory) that
// survived to the human-visible gateWarnings is exactly as load-bearing a "don't repeat
// this" signal as a human's own changes_requested. See executeCompetitiveStage's
// saveSystemLearningEvent call.
const PERMANENT_LEARNING_DECISIONS = new Set(["changes_requested", "reopened", "asset_discard", "asset_replace", "critic_objection"]);
const PROMPT_BY_FILE = {
  "01-research.md": RESEARCH_PROMPT,
  "02-strategy.md": STRATEGY_PROMPT,
  "03-copy.md": COPY_PROMPT,
  "04-creative-direction.md": DIRECTION_PROMPT,
  "05-deck-builder.md": DECK_BUILDER_PROMPT,
  "06-concept-refine.md": CONCEPT_REFINE_PROMPT,
  "07-copy-refine.md": COPY_REFINE_PROMPT,
};

// Validates whatever is cached in Firebase instead of trusting it blindly, and re-seeds
// (overwriting the bad copy) when it doesn't pass. This matters because a bad copy could
// get stuck there permanently otherwise: seen live, a run got as far as an actual Zod
// validation error deep in a product's fields (portfolios[1].products[N].approvedFacts
// etc. "expected array, received undefined") even though the seed file in the repo
// validates cleanly on its own — meaning Firebase already held something written before
// one of this integration's earlier bugs was fixed, and every run since kept reading that
// same broken copy back out, never re-checking or self-correcting it.
async function loadBrandConfig(brandId) {
  const key = fbSafeKey(brandId);
  const raw = await fbGet(`strategy_brands/${key}`);
  if (raw) {
    const result = BrandConfigSchema.safeParse(raw);
    if (result.success) return result.data;
    console.error(`strategy_brands/${key} in Firebase failed validation — re-seeding from source. Issues:`, JSON.stringify(result.error.issues).slice(0, 500));
  }
  const seed = SEED_BRAND_CONFIGS[brandId];
  if (!seed) throw new Error(`No brand config found for "${brandId}" (Firebase copy missing or invalid, and no seed available).`);
  const validated = BrandConfigSchema.parse(seed); // never write anything we haven't verified ourselves
  await fbSet(`strategy_brands/${key}`, validated);
  return validated;
}

async function loadMonthInput(brandId, month) {
  const key = fbSafeKey(brandId);
  const monthKey = fbSafeKey(month);
  const raw = await fbGet(`strategy_months/${key}/${monthKey}`);
  if (raw) {
    const result = MonthInputSchema.safeParse(raw);
    if (result.success && result.data.month === month) return result.data;
    console.error(`strategy_months/${key}/${monthKey} in Firebase failed validation or has the wrong month — re-seeding from source.`);
  }
  const seed = SEED_MONTH_INPUTS[`${brandId}:${month}`];
  const fallback = seed || { month, objectives: [], campaigns: [], momentsToConsider: [], exclusions: [], notes: [] };
  const parsed = MonthInputSchema.parse(fallback);
  if (parsed.month !== month) {
    throw new Error(`Month input for ${brandId}/${month} declares ${parsed.month}, expected ${month}.`);
  }
  await fbSet(`strategy_months/${key}/${monthKey}`, parsed);
  return parsed;
}

async function loadLearnings(brandId) {
  const key = fbSafeKey(brandId);
  const [raw, eventsRaw] = await Promise.all([
    fbGet(`strategy_learnings/${key}/text`),
    fbGet(`strategy_learning_events/${key}`),
  ]);
  let text = typeof raw === "string" && raw.length > 0
    ? raw
    : (SEED_LEARNINGS[brandId] || "# Brand learnings\n\nNo learning events recorded yet.\n");
  if (!(typeof raw === "string" && raw.length > 0)) await fbSet(`strategy_learnings/${key}/text`, text);

  const sortedEvents = Object.values(eventsRaw || {})
    .filter((event) => event && event.notes)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  // "stage_failed" (see saveSystemLearningEvent) is an operational note — a provider
  // outage or a billing lapse says nothing about brand voice or content, so it's kept in
  // its own clearly-labeled section below rather than mixed into the content feedback a
  // writing model might otherwise mistake for a style instruction.
  const operational = sortedEvents.filter((event) => event.decision === "stage_failed").slice(-15);
  const contentEvents = sortedEvents.filter((event) => event.decision !== "stage_failed");
  // A flat "last 30" cutoff quietly drops exactly the events most worth keeping — a
  // "changes_requested"/"reopened"/kill decision is a durable "don't repeat this" signal,
  // not routine chatter, and a brand with a long history could lose its oldest, most
  // load-bearing corrections to nothing more than newer minor refinements piling up after
  // them. PERMANENT_DECISIONS gets a much larger cap of its own instead; only the lower-
  // stakes routine adjustments (a plain refine/similar/approval, or a competition_outcome
  // score comparison — see saveSystemLearningEvent) stay capped at 30.
  const permanent = contentEvents.filter((event) => PERMANENT_LEARNING_DECISIONS.has(event.decision)).slice(-200);
  const routine = contentEvents.filter((event) => !PERMANENT_LEARNING_DECISIONS.has(event.decision)).slice(-30);
  const events = [...permanent, ...routine].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  if (events.length) {
    // Not JUST human feedback any more — a critic's own objection and a competitive
    // round's outcome (see saveSystemLearningEvent) share this same section, since both
    // are genuine "here's what happened last time" content signals; the "actor" field on
    // each event (a real name, vs "system") is what tells them apart if it matters.
    text += "\n\n# Recent review feedback (human decisions and the pipeline's own findings)\n" + events.map((event) =>
      `- ${event.month || "unknown month"} · ${event.stage} · ${event.decision}: ${event.notes}`
    ).join("\n");
  }
  if (operational.length) {
    text += "\n\n# Recent stage failures — operational only, not a content note\n" + operational.map((event) =>
      `- ${event.month || "unknown month"} · ${event.stage} · ${event.decision}: ${event.notes}`
    ).join("\n");
  }
  return text;
}

function loadPrompt(name) {
  const stage = PROMPT_BY_FILE[name];
  if (!stage) throw new Error(`Unknown prompt file: ${name}`);
  return composeAgentInstructions(name, HOUSE_RULES, stage);
}

async function loadBrandLibrary(config, options) {
  return loadDriveBrandLibrary(config, options);
}

// Loona Brain's brief for this brand, as a plain string for the stage prompts, or null when
// there's nothing to say yet. Null is a real answer: the raw brand library still reaches the
// agents exactly as it always has, so a brand with no brain runs precisely as it did before
// any of this existed.
//
// Four inputs, joined here because the prompts want one block, not a growing list of fields:
//   - the reviewed Brand Directory configuration, which is the team's explicit source of
//     truth for identity, voice, audiences and visual guardrails;
//   - the distilled Drive material (brand-brain.js), cached against a fingerprint because
//     distilling costs a model call and unchanged files have nothing new to say;
//   - the live task board (team-activity.js), computed fresh every time because it is state
//     that changes whenever somebody ticks a task off, and a cached copy would be wrong;
//   - the visual direction the team has actually picked in Visual Studio (visual-memory.js),
//     which is the only record of how this brand is really being made — the prompts people
//     write and the takes they choose exist nowhere else.
//
// Any can be absent without affecting the others, and a failure in any is logged and skipped
// rather than allowed to fail a run — this is context, not the brief itself.
function brandDirectoryToPromptText(config) {
  if (!config) return null;
  const audience = (config.audiences || []).map((item) => item.description).filter(Boolean).join("; ");
  const pillars = (config.pillars || []).map((item) => `${item.name}: ${item.description}`).filter(Boolean).join("; ");
  const lines = [
    "# Brand Directory (reviewed configuration)",
    `Brand: ${config.name || config.id}`,
    config.category ? `Category: ${config.category}` : null,
    config.oneLineTruth ? `Brand truth: ${config.oneLineTruth}` : null,
    config.website ? `Website: ${config.website}` : null,
    config.market?.length ? `Markets: ${config.market.join(", ")}` : null,
    config.voice?.descriptors?.length ? `Voice: ${config.voice.descriptors.join(", ")}` : null,
    config.voice?.principles?.length ? `Voice principles: ${config.voice.principles.join("; ")}` : null,
    config.voice?.bannedWords?.length ? `Avoid words: ${config.voice.bannedWords.join(", ")}` : null,
    config.voice?.bannedMoves?.length ? `Avoid moves: ${config.voice.bannedMoves.join("; ")}` : null,
    config.visual?.feel?.length ? `Visual feel: ${config.visual.feel.join(", ")}` : null,
    config.visual?.avoid?.length ? `Visual avoid: ${config.visual.avoid.join("; ")}` : null,
    audience ? `Priority audiences: ${audience}` : null,
    pillars ? `Content pillars: ${pillars}` : null,
    config.competitors?.length ? `Competitors: ${config.competitors.join(", ")}` : null,
  ].filter(Boolean);
  return lines.length > 2 ? lines.join("\n") : null;
}

async function loadBrandBrain(brandId, brandName) {
  const { loadRecentManiEvents, maniEventsToPromptText } = require("./mani-events");
  const [directory, distilled, activity, visual, events] = await Promise.all([
    // The config is read fresh for every request so a review/save in Brand Directory is
    // immediately available to Mani and BB. An unconfigured Hub brand simply has no
    // directory entry yet; that must never take the rest of its memory offline.
    (async () => {
      try { return brandDirectoryToPromptText(await loadBrandConfig(brandId)); }
      catch (error) { if (!/No brand config found/.test(error.message || "")) console.error(`Could not load Brand Directory for ${brandId}:`, error.message); return null; }
    })(),
    (async () => {
      try { return brainToPromptText(await loadBrain(brandId)); }
      catch (error) { console.error(`Could not load Loona Brain for ${brandId}:`, error.message); return null; }
    })(),
    (async () => {
      try { return await loadTeamActivityText(brandId, brandName); }
      catch (error) { console.error(`Could not load team activity for ${brandId}:`, error.message); return null; }
    })(),
    loadVisualPromptText(brandId),
    // BB already receives its chat history separately. Keep every chat turn in Mani's
    // ledger, but omit those raw duplicates from the context block sent back to BB.
    loadRecentManiEvents(brandId)
      .then((items) => maniEventsToPromptText(items.filter((item) => item.type !== "bb_conversation")))
      .catch(() => null),
  ]);
  const parts = [directory, distilled, activity, visual, events].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

module.exports = { loadBrandConfig, loadMonthInput, loadLearnings, loadBrandLibrary, loadBrandBrain, loadPrompt };

