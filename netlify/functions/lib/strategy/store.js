// Replaces loona-strategy-agents/src/core/files.ts's local-disk reads/writes with
// Firebase-backed ones — Netlify Functions have no persistent shared filesystem across
// invocations, so brand config / month input / learnings / run checkpoints all have to
// live in the same Firebase RTDB the rest of Hub already uses (see docs/DEPLOYMENT.md in
// the supplied package, which flags exactly this as the thing to fix before going live).
//
// Brand config, month input and learnings are seeded once from the bundled JSON/Markdown
// files under ./seed/ (copied verbatim from the supplied loona-strategy-agents package)
// the first time they're read, then live in Firebase from that point on — editable later
// through a proper config-editing screen (brief section 13) instead of only through git.
"use strict";
const fs = require("fs");
const path = require("path");
const { BrandConfigSchema, MonthInputSchema } = require("./contracts");
const { fbGet, fbSet, fbSafeKey } = require("./firebase");

const SEED_DIR = path.join(__dirname, "seed");
const PROMPTS_DIR = path.join(__dirname, "prompts");

function readSeedJson(name) {
  const p = path.join(SEED_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function readSeedText(name) {
  const p = path.join(SEED_DIR, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

async function loadBrandConfig(brandId) {
  const key = fbSafeKey(brandId);
  let raw = await fbGet(`strategy_brands/${key}`);
  if (!raw) {
    raw = readSeedJson(`${brandId}.config.json`);
    if (!raw) throw new Error(`No brand config found for "${brandId}" (not in Firebase, no seed file).`);
    await fbSet(`strategy_brands/${key}`, raw);
  }
  return BrandConfigSchema.parse(raw);
}

async function loadMonthInput(brandId, month) {
  const key = fbSafeKey(brandId);
  const monthKey = fbSafeKey(month);
  let raw = await fbGet(`strategy_months/${key}/${monthKey}`);
  if (!raw) {
    raw = readSeedJson(`${brandId}.${month}.month.json`);
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
    text = readSeedText(`${brandId}.learnings.md`) || "# Brand learnings\n\nNo learning events recorded yet.\n";
    await fbSet(`strategy_learnings/${key}/text`, text);
  }
  return text;
}

function loadPrompt(name) {
  const house = fs.readFileSync(path.join(PROMPTS_DIR, "house-rules.md"), "utf8");
  const stage = fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");
  return `${house}\n\n---\n\n${stage}`;
}

module.exports = { loadBrandConfig, loadMonthInput, loadLearnings, loadPrompt };
