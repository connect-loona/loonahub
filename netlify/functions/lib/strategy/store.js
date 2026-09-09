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
const { HOUSE_RULES, RESEARCH_PROMPT, STRATEGY_PROMPT, RRO_LEARNINGS_SEED } = require("./prompts-data");

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
const PROMPT_BY_FILE = {
  "01-research.md": RESEARCH_PROMPT,
  "02-strategy.md": STRATEGY_PROMPT,
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
  const raw = await fbGet(`strategy_learnings/${key}/text`);
  if (typeof raw === "string" && raw.length > 0) return raw;
  const text = SEED_LEARNINGS[brandId] || "# Brand learnings\n\nNo learning events recorded yet.\n";
  await fbSet(`strategy_learnings/${key}/text`, text);
  return text;
}

function loadPrompt(name) {
  const stage = PROMPT_BY_FILE[name];
  if (!stage) throw new Error(`Unknown prompt file: ${name}`);
  return `${HOUSE_RULES}\n\n---\n\n${stage}`;
}

module.exports = { loadBrandConfig, loadMonthInput, loadLearnings, loadPrompt };
