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

async function loadBrandConfig(brandId) {
  const key = fbSafeKey(brandId);
  let raw = await fbGet(`strategy_brands/${key}`);
  if (!raw) {
    raw = SEED_BRAND_CONFIGS[brandId] || null;
    if (!raw) throw new Error(`No brand config found for "${brandId}" (not in Firebase, no seed).`);
    await fbSet(`strategy_brands/${key}`, raw);
  }
  return BrandConfigSchema.parse(raw);
}

async function loadMonthInput(brandId, month) {
  const key = fbSafeKey(brandId);
  const monthKey = fbSafeKey(month);
  let raw = await fbGet(`strategy_months/${key}/${monthKey}`);
  if (!raw) {
    raw = SEED_MONTH_INPUTS[`${brandId}:${month}`] || null;
    if (raw) await fbSet(`strategy_months/${key}/${monthKey}`, raw);
  }
  if (!raw) {
    raw = { month, objectives: [], campaigns: [], momentsToConsider: [], exclusions: [], notes: [] };
  }
  const parsed = MonthInputSchema.parse(raw);
  if (parsed.month !== month) {
    throw new Error(`Month input for ${brandId}/${month} declares ${parsed.month}, expected ${month}.`);
  }
  return parsed;
}

async function loadLearnings(brandId) {
  const key = fbSafeKey(brandId);
  let text = await fbGet(`strategy_learnings/${key}/text`);
  if (!text) {
    text = SEED_LEARNINGS[brandId] || "# Brand learnings\n\nNo learning events recorded yet.\n";
    await fbSet(`strategy_learnings/${key}/text`, text);
  }
  return text;
}

function loadPrompt(name) {
  const stage = PROMPT_BY_FILE[name];
  if (!stage) throw new Error(`Unknown prompt file: ${name}`);
  return `${HOUSE_RULES}\n\n---\n\n${stage}`;
}

module.exports = { loadBrandConfig, loadMonthInput, loadLearnings, loadPrompt };
