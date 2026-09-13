// The "locked rules" a brand's images are generated under.
//
// Both UI prototypes drew these as toggles — "Exact product geometry", "No label
// regeneration", "Approved palette only" — sitting next to sliders labelled things like
// "composition match 72%". None of that maps to anything an image API accepts. Shipped as
// drawn, they would be switches that change nothing, which is worse than not having them:
// somebody turns on "no label regeneration", believes the label is protected, and sends a
// client a bottle with invented text on it.
//
// So a rule here is exactly one thing: a sentence that is really prepended to the prompt. That
// is the only mechanism a text-to-image model actually has, and it genuinely does work. A rule
// is therefore honest by construction — if it appears in the UI, it is in the prompt, and the
// stored record shows precisely what was sent.
//
// The brand-specific half comes from Loona Brain's distilled guidelines, so a brand that has
// told us "never show the cap off" gets that carried into every image without anybody
// remembering to type it.
"use strict";
const { loadBrain } = require("./brand-brain");

const MAX_RULE_CHARS = 300;
const MAX_BRAND_RULE_LINES = 6;

// Always applied, because these are the failures that make an image unusable for a client
// rather than merely off-brief, and no one should have to remember them.
const STANDARD_RULES = [
  {
    key: "product_geometry",
    label: "Exact product geometry",
    text: "Preserve the exact shape, proportions and geometry of any product shown in a reference image. Do not restyle, redesign or reproportion the product itself.",
  },
  {
    key: "no_label_regeneration",
    label: "No label regeneration",
    text: "Never invent, redraw or alter text on packaging, labels or logos. Reproduce them exactly as they appear in the reference, or leave them out of frame entirely.",
  },
  {
    key: "no_invented_claims",
    label: "No invented claims",
    text: "Do not add any text, badge, certification, award or nutritional claim that is not present in the reference material.",
  },
];

const STANDARD_BY_KEY = new Map(STANDARD_RULES.map((rule) => [rule.key, rule]));

// The brand's own hard rules, taken from the guidelines Loona Brain already distilled. Only
// lines that read as prohibitions or requirements are lifted — a paragraph about brand values
// is true but useless to an image model, and padding the prompt with it costs quality.
function brandRuleLinesFrom(brainText) {
  if (!brainText) return [];
  return String(brainText)
    .split("\n")
    .map((line) => line.replace(/^[-*\s]+/, "").trim())
    .filter((line) => line.length > 8 && line.length <= MAX_RULE_CHARS)
    .filter((line) => /\b(never|always|must|do not|don'?t|avoid|only|forbidden|banned|required)\b/i.test(line))
    .slice(0, MAX_BRAND_RULE_LINES);
}

async function brandRulesFor(brandId, deps = {}) {
  try {
    const brain = deps.brain || (await loadBrain(brandId));
    const guidelines = brain && brain.sections && brain.sections.guidelines;
    return brandRuleLinesFrom(guidelines && guidelines.text);
  } catch (error) {
    // A missing or broken brain must not stop someone generating an image. The standard rules
    // still apply; the brand-specific ones simply aren't available this time.
    console.error(`Could not load visual rules for ${brandId}:`, error.message);
    return [];
  }
}

// What the caller asked to switch off. Unknown keys are ignored rather than rejected, so an
// older UI can't break generation by naming a rule that has since been renamed.
function selectStandardRules(disabledKeys) {
  const disabled = new Set((disabledKeys || []).map(String));
  return STANDARD_RULES.filter((rule) => !disabled.has(rule.key));
}

// Returns both the text to prepend and the list of rules that produced it, so the UI can show
// exactly what was applied and the record can store it.
async function buildRulePreamble(brandId, options = {}) {
  const standard = selectStandardRules(options.disabledRules);
  const brandLines = options.skipBrandRules ? [] : await brandRulesFor(brandId, options);

  const applied = [
    ...standard.map((rule) => ({ key: rule.key, label: rule.label, source: "standard" })),
    ...brandLines.map((line, i) => ({ key: `brand_${i}`, label: line, source: "brand" })),
  ];
  if (!applied.length) return { preamble: "", applied: [] };

  const parts = [];
  if (standard.length) parts.push(standard.map((rule) => rule.text).join(" "));
  if (brandLines.length) {
    parts.push(`Follow this brand's own rules exactly: ${brandLines.join(" ")}`);
  }
  return { preamble: parts.join(" "), applied };
}

// The rules and the request, in the order a model reads them: constraints first so they frame
// everything that follows, then what the person actually asked for.
function applyRules(preamble, prompt) {
  const clean = String(prompt || "").trim();
  return preamble ? `${preamble}\n\n${clean}` : clean;
}

module.exports = {
  buildRulePreamble, applyRules, brandRulesFor, brandRuleLinesFrom,
  selectStandardRules, STANDARD_RULES, STANDARD_BY_KEY,
};
