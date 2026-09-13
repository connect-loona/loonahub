// Loona Brain — the distillation layer.
//
// google-drive.js reads the brand folder and hands the agents raw extracted text, newest
// first, up to a budget, now with a guaranteed share for each KIND of material. That's the
// right raw material in the wrong shape: 80,000 characters of deck extracts in which the one
// line that actually matters for next month — "the 12-second reels outperformed everything
// else on saves" — sits somewhere in the middle of a September content calendar, next to a
// slide footer and an agency boilerplate paragraph.
//
// A model reading that from scratch every single run has to re-derive the same conclusions
// every time, from a budget-truncated view, and it has no way to notice that the same
// conclusion held in July and August too.
//
// So each kind gets distilled once into a short, durable brief: what the guidelines actually
// forbid, what the approved work actually looks like, what the numbers actually said. Written
// down, kept, and re-used until the underlying files change.
//
// Two things make this affordable. First, it's keyed to a fingerprint of the source files
// (their ids and modifiedTimes), so an unchanged folder is never re-distilled — the same
// principle as brand-library-memory.js, one level up. Second, it's the cheap model: this is
// summarising text that's already been extracted, not judgement.
//
// Stored at strategy_brain/<brandId>, separate from the library doc, so re-indexing a folder
// never throws away the distillation and vice versa.
"use strict";
const crypto = require("crypto");
const { fbGet, fbSet, fbSafeKey } = require("./firebase");

const MAX_SECTION_CHARS = 4000;
const MAX_INPUT_CHARS = 60000;
// Bumping this re-distills every brand on its next scan, which is what you want whenever the
// section prompts below change — otherwise brands keep serving briefs written to the old
// instructions and there's no way to tell which is which.
const PROMPT_VERSION = "1";

const SHARED_RULES = [
  "Write for another agent who will plan and write next month's content for this brand and will NOT see the source files.",
  "Be specific and concrete. Name products, formats, numbers, phrases. A brief that could describe any brand is worthless.",
  "Quote exact wording wherever a writer would need to reproduce it faithfully.",
  "Never invent. If the material does not say something, leave it out rather than filling the gap.",
  "No preamble, no sign-off, no restating these instructions. Start with the content itself.",
  "Use short markdown bullets under short headings. No long paragraphs.",
].join("\n");

// One per kind of material, because each answers a genuinely different question. Running the
// same generic "summarise this" over all three is what produces three briefs that say the
// same vague things about brand values.
const SECTIONS = [
  {
    key: "guidelines",
    label: "Brand guidelines",
    heading: "What this brand's guidelines require and forbid",
    prompt: [
      "These are the brand's own guidelines, identity documents and rulebooks.",
      "Extract the RULES, in a form another agent can obey without seeing the document:",
      "- Anything forbidden: banned claims, banned words, territory to avoid, visual treatments that are off-limits. Quote them exactly.",
      "- Anything mandatory: required phrasing, legal lines, disclaimers, how the brand name and products must be written.",
      "- Tone of voice: how this brand sounds, and — more usefully — how it must NOT sound.",
      "- Visual direction: colour, typography, photography style, layout conventions.",
      "- Hard product facts a writer could get wrong: exact product names, variants, pack sizes, ingredients, permitted claims.",
      "Rules the material states outright come first. Put anything you are inferring under a final 'Less certain' heading.",
    ].join("\n"),
  },
  {
    key: "approved",
    label: "Approved content",
    heading: "What this brand's approved work actually looks like",
    prompt: [
      "This is content that actually shipped for this brand and was signed off — past calendars, final posts, approved decks.",
      "Describe the WORK, so another agent can match it and avoid repeating it:",
      "- The formats that recur, and roughly in what mix.",
      "- How a typical piece is structured: how hooks open, how captions run, how they close, whether there's a CTA and what it sounds like.",
      "- Recurring themes, angles and series that this brand keeps coming back to.",
      "- Specific angles already used and therefore EXHAUSTED — the ones a new month should not simply repeat. Be concrete: name them.",
      "- Anything notable about how this brand talks about its own products.",
    ].join("\n"),
  },
  {
    key: "performance",
    label: "Performance reports",
    heading: "What actually worked for this brand, and what didn't",
    prompt: [
      "These are performance and analytics reports for content this brand has already run.",
      "Extract what the numbers actually said, so next month's plan can act on it:",
      "- What performed well, with the metric and the number where the material gives one, and what it was attributed to.",
      "- What performed badly, equally specifically. This half matters as much and usually gets dropped.",
      "- Patterns that hold across more than one report or month — those are the durable ones, so say which period each came from.",
      "- Anything the reports themselves recommend doing more or less of.",
      "Separate what the reports measured from what they merely claimed. Do not turn a one-month blip into a rule.",
    ].join("\n"),
  },
];

function anthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
}

function brainPath(brandId) {
  return `strategy_brain/${fbSafeKey(brandId)}`;
}

// What the distillation was computed FROM. Two folders with the same files at the same
// versions produce the same fingerprint, so nothing is re-distilled without a real change;
// any edit, addition or removal changes it, so nothing goes stale either.
function fingerprintFor(files) {
  const parts = files
    .map((file) => `${file.id}:${file.modifiedTime || ""}:${(file.text || "").length}`)
    .sort();
  return crypto.createHash("sha1").update(`v${PROMPT_VERSION}|${parts.join("|")}`).digest("hex");
}

// The files of one kind that actually carry text. A file whose contents the agents never saw
// has nothing to contribute to a distillation of what those contents say.
function filesForSection(library, key) {
  return (library.files || []).filter((file) => file.category === key && file.text);
}

async function distill(section, files, client) {
  // Newest first, and capped: past a point more source text buys nothing but tokens, and the
  // library already ordered these so the most recent work is what survives the cut.
  let budget = MAX_INPUT_CHARS;
  const blocks = [];
  for (const file of files) {
    if (budget <= 0) break;
    const text = file.text.slice(0, budget);
    budget -= text.length;
    blocks.push(`--- ${file.path || file.name} (last modified ${file.modifiedTime || "unknown"}) ---\n${text}`);
  }

  const response = await client.messages.create({
    // Cheap tier on purpose: this is compression of already-extracted text, not judgement.
    model: process.env.STRATEGY_BRAIN_MODEL || process.env.STRATEGY_CLAUDE_MODEL_ECONOMY || "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    system: `${section.prompt}\n\n${SHARED_RULES}`,
    messages: [{ role: "user", content: blocks.join("\n\n") }],
  });

  const text = (response.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text ? text.slice(0, MAX_SECTION_CHARS) : null;
}

// Re-distils only the sections whose source files have actually changed, and keeps everything
// else exactly as it was. `deps.brainClient` is injected by tests; production builds a real
// SDK client once and shares it across the sections that need one.
async function refreshBrain(library, options = {}) {
  const brandId = library.brandId;
  const previous = (await fbGet(brainPath(brandId))) || {};
  const previousSections = previous.sections || {};

  let client = (options.deps && options.deps.brainClient) || null;
  const sections = {};
  let distilledCount = 0;
  let reusedCount = 0;

  for (const section of SECTIONS) {
    const files = filesForSection(library, section.key);
    const fingerprint = fingerprintFor(files);
    const existing = previousSections[section.key];

    // Nothing of this kind in the folder. Say so explicitly rather than leaving the section
    // missing — "this brand has no performance reports" is itself worth knowing, and a
    // stale brief from before the files were deleted would be worse than none.
    if (!files.length) {
      sections[section.key] = { fileCount: 0, fingerprint, text: null, distilledAt: null };
      continue;
    }

    if (existing && existing.fingerprint === fingerprint && existing.text) {
      sections[section.key] = existing;
      reusedCount += 1;
      continue;
    }

    if (!client) {
      const apiKey = anthropicApiKey();
      if (!apiKey) {
        // No key is not a failure to blow up a run over — the raw library still reaches the
        // agents exactly as before. Keep whatever brief we already had and record why it
        // didn't move.
        sections[section.key] = Object.assign({}, existing || { text: null }, {
          fileCount: files.length, fingerprint: existing ? existing.fingerprint : fingerprint,
          error: "No Anthropic key configured, so this could not be distilled.",
        });
        continue;
      }
      const Anthropic = require("@anthropic-ai/sdk");
      client = new Anthropic({ apiKey });
    }

    try {
      const text = await distill(section, files, client);
      sections[section.key] = {
        fileCount: files.length, fingerprint, text,
        distilledAt: new Date().toISOString(),
      };
      distilledCount += 1;
    } catch (error) {
      // One section failing must not cost the others. Keep the last good brief for this
      // section and carry the reason, so it's visible instead of silently frozen.
      console.error(`Loona Brain could not distil ${section.key} for ${brandId}:`, error.message);
      sections[section.key] = Object.assign({}, existing || { text: null }, {
        fileCount: files.length,
        error: `Could not be distilled: ${error.message}`,
      });
    }
  }

  const brain = {
    schemaVersion: "1.0", brandId,
    updatedAt: new Date().toISOString(),
    sectionsDistilled: distilledCount,
    sectionsFromMemory: reusedCount,
    sections,
  };
  await fbSet(brainPath(brandId), brain);
  return brain;
}

async function loadBrain(brandId) {
  return (await fbGet(brainPath(brandId))) || null;
}

// The brief as the stage prompts see it. Returns null rather than an empty shell when there's
// nothing distilled yet, so a brand with no brain simply doesn't get the field — the agents
// fall back to the raw library exactly as they did before any of this existed.
function brainToPromptText(brain) {
  if (!brain || !brain.sections) return null;
  const parts = [];
  for (const section of SECTIONS) {
    const stored = brain.sections[section.key];
    if (!stored || !stored.text) continue;
    parts.push(`## ${section.heading}\n${stored.text}`);
  }
  if (!parts.length) return null;
  return [
    "# Loona Brain — what we already know about this brand",
    "Distilled from this brand's own Drive folder: its guidelines, the work that shipped, and how that work performed.",
    "Treat it as established fact about the brand, not as a suggestion, and not as content to copy.",
    "",
    parts.join("\n\n"),
  ].join("\n");
}

module.exports = {
  refreshBrain, loadBrain, brainToPromptText,
  fingerprintFor, filesForSection, brainPath,
  SECTIONS, MAX_SECTION_CHARS,
};
