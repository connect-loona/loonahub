// Regenerates netlify/functions/lib/strategy/prompts-data.js from the human-editable
// source files under prompts/*.md and seed/rro.learnings.md. Run this (from the repo
// root, `node scripts/gen-strategy-prompts-data.js`) after editing any of those files —
// prompts-data.js itself is generated and should not be hand-edited. See prompts-data.js's
// own header comment for why this data is inlined into JS rather than read via fs at
// runtime (short version: Netlify's esbuild function bundler breaks __dirname-relative
// fs reads to sibling files once it concatenates everything into one output file).
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'strategy');

function jsEscape(str) {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function readMd(p) { return fs.readFileSync(path.join(BASE, p), 'utf8'); }

const houseRules = readMd('prompts/house-rules.md');
const researchPrompt = readMd('prompts/01-research.md');
const strategyPrompt = readMd('prompts/02-strategy.md');
const copyPrompt = readMd('prompts/03-copy.md');
const directionPrompt = readMd('prompts/04-creative-direction.md');
const deckBuilderPrompt = readMd('prompts/05-deck-builder.md');
const rroLearnings = readMd('seed/rro.learnings.md');

const header = [
  "// Generated from the .md files under ./prompts/ and ./seed/ — inlined as JS string",
  "// constants instead of read via fs.readFileSync(__dirname, ...) at runtime, because",
  "// Netlify's esbuild function bundler concatenates every require()'d file into ONE output",
  "// file per function; __dirname inside that bundle no longer points at this file's original",
  "// nested directory (netlify/functions/lib/strategy/), so a runtime fs read for a sibling",
  "// ./prompts/*.md or ./seed/*.md file silently misses even with included_files correctly",
  "// copying the actual files into the deploy (they end up at the right path on disk, just not",
  "// the path this bundled code computes). Requiring/inlining the content instead sidesteps the",
  "// whole problem: esbuild inlines these as literal data directly into the same bundle, so",
  "// there is no separate file to locate at runtime at all.",
  "//",
  "// Regenerate this file (do not hand-edit) whenever the source .md files change, from",
  "// the repo root: node scripts/gen-strategy-prompts-data.js",
  '"use strict";',
  '',
].join('\n');

const body =
  'const HOUSE_RULES = `' + jsEscape(houseRules) + '`;\n\n' +
  'const RESEARCH_PROMPT = `' + jsEscape(researchPrompt) + '`;\n\n' +
  'const STRATEGY_PROMPT = `' + jsEscape(strategyPrompt) + '`;\n\n' +
  'const COPY_PROMPT = `' + jsEscape(copyPrompt) + '`;\n\n' +
  'const DIRECTION_PROMPT = `' + jsEscape(directionPrompt) + '`;\n\n' +
  'const DECK_BUILDER_PROMPT = `' + jsEscape(deckBuilderPrompt) + '`;\n\n' +
  'const RRO_LEARNINGS_SEED = `' + jsEscape(rroLearnings) + '`;\n\n' +
  'module.exports = { HOUSE_RULES, RESEARCH_PROMPT, STRATEGY_PROMPT, COPY_PROMPT, DIRECTION_PROMPT, DECK_BUILDER_PROMPT, RRO_LEARNINGS_SEED };\n';

fs.writeFileSync(path.join(BASE, 'prompts-data.js'), header + body);
console.log('wrote prompts-data.js, ' + (header + body).length + ' bytes');
