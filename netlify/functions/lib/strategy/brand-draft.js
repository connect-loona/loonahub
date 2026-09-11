// Drafts a brand's strategic configuration from what's actually in its Drive folder.
//
// A brand can't run on a folder name: BrandConfigSchema wants a truth, a voice, pillars,
// audiences, products and claim boundaries before the first stage will validate. All of that
// is normally typed in by hand from the brand guidelines — which is exactly the document now
// sitting readable in the brand's own Drive folder.
//
// This drafts, and only drafts. Nothing here writes a brand: the result goes to
// strategy_brand_drafts/<brandId> for a human to correct and save through the normal Manage
// brands form. Brand truth and prohibited claims are things a client is held to, so a model's
// guess at them is a starting point for someone who knows the account, never a fact.
"use strict";
const { z } = require("zod");

const NonEmpty = z.string().min(1);

// A deliberately smaller shape than BrandConfigSchema. Everything here is something the
// guidelines can genuinely support; the parts a document can't know — deliverable counts
// (a commercial agreement), approvedWork (a history), the Drive link (we already have it) —
// are left for the form rather than invented.
const BrandDraftSchema = z
  .object({
    category: NonEmpty,
    market: z.array(NonEmpty).min(1),
    aspirationalMarkets: z.array(NonEmpty),
    website: z.string().nullable(),
    oneLineTruth: NonEmpty,
    voice: z
      .object({
        descriptors: z.array(NonEmpty).min(3).max(6),
        principles: z.array(NonEmpty).min(1),
        bannedWords: z.array(NonEmpty),
        bannedMoves: z.array(NonEmpty),
      })
      .strict(),
    audiences: z.array(z.object({ description: NonEmpty, tension: NonEmpty }).strict()).min(1),
    pillars: z.array(z.object({ id: NonEmpty, name: NonEmpty, intent: NonEmpty }).strict()).min(1),
    products: z
      .array(
        z
          .object({
            id: NonEmpty,
            name: NonEmpty,
            role: NonEmpty,
            approvedFacts: z.array(NonEmpty),
            approvedClaims: z.array(NonEmpty),
            prohibitedClaims: z.array(NonEmpty),
            restrictions: z.array(NonEmpty),
          })
          .strict()
      )
      .default([]),
    // Per field, where this came from — which file, or that it was inferred. The reviewer
    // needs to know which parts are quoted from the guidelines and which the model filled in
    // around them, because those deserve very different levels of scrutiny.
    sources: z.array(z.object({ field: NonEmpty, basis: NonEmpty }).strict()).default([]),
    // Anything the folder genuinely didn't answer. Better an explicit gap than a confident
    // invention — this list is what the reviewer must supply themselves.
    gaps: z.array(NonEmpty).default([]),
  })
  .strict();

const DRAFT_INSTRUCTIONS = [
  "You are setting up a new brand in a strategy system, working only from that brand's own reference folder.",
  "Draft its configuration from the supplied documents.",
  "",
  "Rules:",
  "- Use only what the documents actually support. Never invent a fact, a claim, or a restriction.",
  "- Quote the brand's own wording wherever it exists, especially for voice and prohibited claims.",
  "- `oneLineTruth` is the single sentence that makes this brand itself and not a competitor — not a slogan, not a category description.",
  "- `pillars` are the recurring territories this brand's content lives in. Give each a short id in kebab-case.",
  "- `audiences` pair a real group with the human tension that makes them care. 'People who like good food' is a failure.",
  "- `prohibitedClaims` matters most: list anything the documents forbid saying, in their words.",
  "- For every field, record in `sources` which document it came from, or say it was inferred.",
  "- Put anything the folder does not answer in `gaps`. An honest gap is more useful than a confident guess.",
].join("\n");

// Keeps the prompt to the documents most likely to define the brand, in a fixed order, so a
// folder full of monthly content plans can't crowd out the guidelines.
const PRIORITY = [/guideline/i, /brand/i, /thought starter/i, /strategy/i, /proposal/i, /product/i];

function orderedFiles(library) {
  const withText = (library.files || []).filter((file) => file.text);
  const score = (file) => {
    const hay = `${file.path || ""} ${file.name || ""}`;
    const index = PRIORITY.findIndex((pattern) => pattern.test(hay));
    return index === -1 ? PRIORITY.length : index;
  };
  return withText.slice().sort((a, b) => score(a) - score(b));
}

function buildInput(folderName, library) {
  const files = orderedFiles(library);
  return {
    brandFolder: folderName,
    filesRead: files.length,
    // The files the model never got to see. Worth sending: "I could not read the brand
    // guidelines" is something the draft should be able to say out loud in `gaps`.
    filesNotRead: (library.unreadFiles || []).map((file) => `${file.name} — ${file.reason}`),
    documents: files.map((file) => ({ name: file.name, path: file.path, content: file.text })),
  };
}

// runtime is any object with the runStage() interface (FailoverRuntime in production), so a
// draft survives one provider being down exactly like a pipeline stage does.
async function draftBrandFromLibrary(runtime, folderName, library) {
  if (!(library.files || []).some((file) => file.text)) {
    throw new Error(
      `Nothing in ${folderName}'s Drive folder could be read, so there's nothing to draft from. ` +
      `Re-export its oversized PDFs, or fill the brand in by hand.`
    );
  }
  return runtime.runStage({
    stage: "brand-draft",
    agentName: "Brand setup",
    instructions: DRAFT_INSTRUCTIONS,
    input: buildInput(folderName, library),
    outputSchema: BrandDraftSchema,
    toolProfile: "none",
    repairIssues: [],
  });
}

module.exports = { BrandDraftSchema, draftBrandFromLibrary, orderedFiles, buildInput, DRAFT_INSTRUCTIONS };
