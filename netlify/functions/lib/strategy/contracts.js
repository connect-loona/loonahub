// Ported from loona-strategy-agents/src/contracts.ts. Originally trimmed to just Research +
// Strategy for the first vertical slice; Copy, CreativeDirection and DeckSpec are now
// ported the same way (field names and validation rules kept byte-for-byte identical to
// the original so validation.js needs no changes beyond the same porting pattern).
//
// Deliverable counts (reel/carousel/static) are per-brand numbers from BrandConfigSchema
// below, not a fixed constant anywhere — Strategy/Copy/CreativeDirection/Deck all size
// themselves off strategy.assets.length, whatever that turned out to be for this brand.
// There is no "12" or "13" hardcoded in this file or anywhere downstream of it.
"use strict";
const { z } = require("zod");

const NonEmpty = z.string().min(1);
const NullableText = z.string().nullable();

// "story" is treated the same as "static" everywhere a format-conditional rule exists
// (validation.js: no script, no shot-list minimum) — see 02-strategy.md's "Deliverable
// formats" section for what actually distinguishes it creatively. Adding a genuinely new
// generated format (as opposed to a deliverable-count-only line item like "blog"/
// "whatsapp" — see BrandConfigSchema.deliverables below) means adding it here AND teaching
// every stage's prompt file about it, the same way "story" was added.
const AssetFormatSchema = z.enum(["reel", "carousel", "static", "story"]);

const ApprovedWorkSchema = z
  .object({
    id: NonEmpty,
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    type: z.enum(["deck", "design", "video", "campaign", "other"]),
    title: NonEmpty,
    url: NonEmpty,
    notes: NonEmpty,
    outcome: NullableText,
  })
  .strict();

const ProductSchema = z
  .object({
    id: NonEmpty,
    name: NonEmpty,
    role: NonEmpty,
    approvedFacts: z.array(NonEmpty),
    approvedClaims: z.array(NonEmpty),
    prohibitedClaims: z.array(NonEmpty),
    restrictions: z.array(NonEmpty),
  })
  .strict();

const PortfolioSchema = z
  .object({
    id: NonEmpty,
    name: NonEmpty,
    positioning: NonEmpty,
    audience: z.array(NonEmpty).min(1),
    namingRules: z.array(NonEmpty).min(1),
    voiceRules: z.array(NonEmpty),
    visualRules: z.array(NonEmpty),
    products: z.array(ProductSchema).min(1),
  })
  .strict();

const ClaimRuleSchema = z
  .object({
    id: NonEmpty,
    rule: NonEmpty,
    action: z.enum(["rewrite_and_flag", "block"]),
    portfolioIds: z.array(NonEmpty),
    triggerPatterns: z.array(NonEmpty),
    safeAlternative: NonEmpty,
    verificationSource: NullableText,
  })
  .strict();

const CopyStructureSchema = z
  .object({
    captionVariants: z.number().int().min(1).max(5),
    order: z.array(NonEmpty).min(1),
    separatorLines: z.array(NonEmpty),
    keywordStyle: NonEmpty,
    hashtagRule: NonEmpty,
    ctaRule: NonEmpty,
  })
  .strict();

// Canva publishing was retired — deck output ships as a downloadable .pptx instead (see
// strategy-deck-download.js/pptx.js), and it never had real credentials configured for any
// brand. This schema stays, and the field below stays OPTIONAL rather than removed, purely
// so a brand config already saved with a `canva: {...}` object (BrandConfigSchema.strict()
// rejects unrecognized keys) keeps parsing exactly as it did — nothing here reads `.canva`
// any more, so its presence or absence has no effect either way.
const CanvaConfigSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["brand_template", "design"]),
    templateIdEnv: NonEmpty,
    sourceDesignIdEnv: NonEmpty,
    fieldPrefix: NonEmpty,
    indexWidth: z.number().int().min(1).max(4),
    fields: z
      .object({
        format: NonEmpty,
        portfolio: NonEmpty,
        idea: NonEmpty,
        hook: NonEmpty,
        creativeCopy: NonEmpty,
        direction: NonEmpty,
        shotList: NonEmpty,
        captionOne: NonEmpty,
        captionTwo: NonEmpty,
        captionThree: NonEmpty,
        referenceImage: NonEmpty,
        referenceCredit: NonEmpty,
      })
      .strict(),
  })
  .strict();

const BrandConfigSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: NonEmpty,
    category: NonEmpty,
    market: z.array(NonEmpty).min(1),
    aspirationalMarkets: z.array(NonEmpty),
    website: NullableText,
    driveFolderUrl: NullableText,
    approvedWork: z.array(ApprovedWorkSchema).optional().default([]),
    oneLineTruth: NonEmpty,
    // reel/carousel/static stay required, as before. `story` is a fourth format the
    // pipeline can also actually generate (see AssetFormatSchema) — optional/defaulted to
    // 0 so brand configs saved before it existed keep parsing unchanged. Beyond those four,
    // `.catchall()` accepts any other named deliverable ("blog", "whatsapp", or whatever
    // the "+ Add deliverable" UI is given — see DeliverablesFields.tsx) as a plain count:
    // it's recorded and included in a run's total deliverable count, but validation.js only
    // enforces the count for formats in AssetFormatSchema (reel/carousel/static/story) —
    // the strategy stage has no way to produce a "blog" or "whatsapp" format asset yet, so
    // requiring an exact count for one would be a target nothing could ever satisfy.
    deliverables: z
      .object({
        reel: z.number().int().min(0),
        carousel: z.number().int().min(0),
        static: z.number().int().min(0),
        story: z.number().int().min(0).optional().default(0),
        confirmed: z.boolean(),
      })
      .catchall(z.number().int().min(0)),
    voice: z
      .object({
        descriptors: z.array(NonEmpty).min(3).max(6),
        principles: z.array(NonEmpty).min(1),
        bannedWords: z.array(NonEmpty),
        bannedMoves: z.array(NonEmpty),
        emojiRule: NonEmpty,
        languageRule: NonEmpty,
      })
      .strict(),
    audiences: z
      .array(
        z
          .object({
            id: NonEmpty,
            description: NonEmpty,
            buyingSituation: NonEmpty,
            trigger: NonEmpty,
          })
          .strict(),
      )
      .min(1),
    visual: z
      .object({
        feel: z.array(NonEmpty).min(3),
        palette: z.array(NonEmpty),
        principles: z.array(NonEmpty).min(1),
        avoid: z.array(NonEmpty).min(1),
      })
      .strict(),
    pillars: z
      .array(
        z
          .object({
            id: NonEmpty,
            name: NonEmpty,
            description: NonEmpty,
            targetShare: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1),
    competitors: z.array(NonEmpty),
    portfolios: z.array(PortfolioSchema),
    claimRules: z.array(ClaimRuleSchema),
    copyStructure: CopyStructureSchema.nullable(),
    knownUnknowns: z.array(NonEmpty),
    sourceVectorStoreIds: z.array(NonEmpty),
    canva: CanvaConfigSchema.optional(),
  })
  .strict();

const MonthInputSchema = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    objectives: z.array(NonEmpty),
    campaigns: z.array(NonEmpty),
    momentsToConsider: z.array(NonEmpty),
    exclusions: z.array(NonEmpty),
    notes: z.array(NonEmpty),
  })
  .strict();

const ResearchSchema = z
  .object({
    brandId: NonEmpty,
    month: NonEmpty,
    researchedAt: NonEmpty,
    categoryFrame: NonEmpty,
    sources: z
      .array(
        z
          .object({
            id: NonEmpty,
            type: z.enum([
              "brand",
              "government",
              "publisher",
              "forum",
              "comment",
              "review",
              "search",
              "competitor",
              "other",
            ]),
            title: NonEmpty,
            url: NonEmpty,
            publishedAt: NullableText,
            accessedAt: NonEmpty,
            evidence: NonEmpty,
          })
          .strict(),
      )
      .min(1),
    liveQuestions: z
      .array(
        z
          .object({
            id: NonEmpty,
            verbatim: NonEmpty,
            underlyingNeed: NonEmpty,
            sourceIds: z.array(NonEmpty).min(1),
          })
          .strict(),
      )
      .min(8),
    arguments: z
      .array(
        z
          .object({
            id: NonEmpty,
            disagreement: NonEmpty,
            sideA: NonEmpty,
            sideB: NonEmpty,
            credibleBrandPosition: NonEmpty,
            credibilityReason: NonEmpty,
            sourceIds: z.array(NonEmpty).min(1),
          })
          .strict(),
      )
      .min(2),
    unspokenBehaviours: z
      .array(
        z
          .object({
            id: NonEmpty,
            behaviour: NonEmpty,
            hiddenTension: NonEmpty,
            sourceIds: z.array(NonEmpty).min(1),
          })
          .strict(),
      )
      .min(3),
    exhaustedTerritory: z
      .array(
        z
          .object({
            id: NonEmpty,
            territory: NonEmpty,
            reasonExhausted: NonEmpty,
            sourceIds: z.array(NonEmpty),
          })
          .strict(),
      )
      .min(6),
    calendar: z.array(
      z
        .object({
          id: NonEmpty,
          date: NonEmpty,
          moment: NonEmpty,
          relevance: NonEmpty,
          confidence: z.enum(["verified", "tentative", "irrelevant"]),
          sourceIds: z.array(NonEmpty).min(1),
        })
        .strict(),
    ),
    whitespace: z
      .array(
        z
          .object({
            id: NonEmpty,
            opening: NonEmpty,
            brandRightToSpeak: NonEmpty,
            sourceIds: z.array(NonEmpty).min(1),
          })
          .strict(),
      )
      .min(3),
    verifiedFacts: z.array(
      z
        .object({
          fact: NonEmpty,
          sourceIds: z.array(NonEmpty).min(1),
          usableInCopy: z.boolean(),
        })
        .strict(),
    ),
    unknowns: z.array(NonEmpty),
    researchNotes: z.array(NonEmpty),
  })
  .strict();

const ConceptGateSchema = z
  .object({
    logoSwapPass: z.boolean(),
    killListPass: z.boolean(),
    tensionPass: z.boolean(),
    overheardPass: z.boolean(),
    rationale: NonEmpty,
  })
  .strict();

const StrategyAssetSchema = z
  .object({
    assetId: z.string().regex(/^[A-Z]+-\d{2}$/),
    sequence: z.number().int().min(1),
    format: AssetFormatSchema,
    pillarId: NonEmpty,
    portfolioId: NullableText,
    skuIds: z.array(NonEmpty),
    conceptName: NonEmpty,
    concept: NonEmpty,
    hook: NonEmpty,
    tension: NonEmpty,
    sendTo: NonEmpty,
    brandAnchors: z.array(NonEmpty).min(2),
    researchIds: z.array(NonEmpty).min(1),
    strategicRole: NonEmpty,
    gate: ConceptGateSchema,
  })
  .strict();

const StrategySchema = z
  .object({
    brandId: NonEmpty,
    month: NonEmpty,
    monthThesis: NonEmpty,
    assets: z.array(StrategyAssetSchema).min(1),
    discarded: z.array(
      z
        .object({
          conceptName: NonEmpty,
          hook: NonEmpty,
          failedGate: z.enum(["logo_swap", "kill_list", "tension", "overheard"]),
          reason: NonEmpty,
        })
        .strict(),
    ),
    balanceRationale: NonEmpty,
    unresolvedDecisions: z.array(NonEmpty),
  })
  .strict();

const CaptionSchema = z
  .object({
    version: z.enum(["A", "B", "C"]),
    angle: NonEmpty,
    copy: NonEmpty,
    hashtags: z.array(NonEmpty),
  })
  .strict();

const CopyAssetSchema = z
  .object({
    assetId: NonEmpty,
    format: AssetFormatSchema,
    portfolioId: NullableText,
    portfolioName: NullableText,
    skuIds: z.array(NonEmpty),
    skuNames: z.array(NonEmpty),
    hook: NonEmpty,
    onCreative: z
      .object({
        cover: NonEmpty,
        frames: z.array(
          z
            .object({
              label: NonEmpty,
              text: NonEmpty,
            })
            .strict(),
        ),
        endFrame: NonEmpty,
      })
      .strict(),
    script: z
      .object({
        durationSeconds: z.number().min(0),
        scenes: z.array(
          z
            .object({
              timing: NonEmpty,
              visual: NonEmpty,
              voiceover: NonEmpty,
              onScreenText: NonEmpty,
            })
            .strict(),
        ),
      })
      .strict(),
    captions: z.array(CaptionSchema).length(3),
    claimAudit: z
      .object({
        rulesChecked: z.array(NonEmpty),
        rewrittenClaims: z.array(
          z
            .object({
              riskyVersion: NonEmpty,
              safeVersionUsed: NonEmpty,
              ruleId: NonEmpty,
            })
            .strict(),
        ),
        verificationFlags: z.array(
          z
            .object({
              claim: NonEmpty,
              evidenceNeeded: NonEmpty,
              ruleId: NonEmpty,
            })
            .strict(),
        ),
        status: z.enum(["ready", "needs_verification", "blocked"]),
      })
      .strict(),
  })
  .strict();

const CopySchema = z
  .object({
    brandId: NonEmpty,
    month: NonEmpty,
    assets: z.array(CopyAssetSchema).min(1),
    globalVerificationFlags: z.array(NonEmpty),
  })
  .strict();

const DirectionAssetSchema = z
  .object({
    assetId: NonEmpty,
    format: AssetFormatSchema,
    portfolioId: NullableText,
    skuIds: z.array(NonEmpty),
    visualConcept: NonEmpty,
    artDirection: NonEmpty,
    palette: z.array(NonEmpty).min(1),
    typography: NonEmpty,
    composition: NonEmpty,
    productionMode: z.enum(["design", "product-shoot", "lifestyle-shoot", "mixed"]),
    referenceQueries: z.array(NonEmpty).min(1),
    references: z
      .array(
        z
          .object({
            url: NonEmpty,
            title: NonEmpty,
            source: NonEmpty,
            useFor: NonEmpty,
            rightsNote: NonEmpty,
          })
          .strict(),
      )
      .min(1),
    shotList: z.array(
      z
        .object({
          shot: NonEmpty,
          framing: NonEmpty,
          action: NonEmpty,
          productVisibility: NonEmpty,
          copyPlacement: NonEmpty,
        })
        .strict(),
    ),
    designNotes: z.array(NonEmpty).min(1),
    avoid: z.array(NonEmpty).min(1),
  })
  .strict();

const CreativeDirectionSchema = z
  .object({
    brandId: NonEmpty,
    month: NonEmpty,
    assets: z.array(DirectionAssetSchema).min(1),
    productionNotes: z.array(NonEmpty),
  })
  .strict();

// DeckPageSchema is the AI-facing contract — exactly what the model can actually know.
// owner/productionStatus are deliberately NOT here: the model has no way to know who's
// assigned or what stage production is at, and asking it to guess would just produce
// plausible-sounding fabrication (the same failure mode house-rules.md warns against
// everywhere else). The pipeline enriches each page with those two fields itself, right
// after this validates, before checkpointing — see pipeline.js's runDeckStage(). The UI
// reads them off the enriched checkpoint, not off this schema.
const DeckPageSchema = z
  .object({
    pageNumber: z.number().int().min(1),
    assetId: NonEmpty,
    format: AssetFormatSchema,
    portfolioAndSku: NonEmpty,
    idea: NonEmpty,
    hook: NonEmpty,
    creativeCopy: NonEmpty,
    direction: NonEmpty,
    shotList: NonEmpty,
    captionOne: NonEmpty,
    captionTwo: NonEmpty,
    captionThree: NonEmpty,
    referenceImageUrl: NonEmpty,
    referenceCredit: NonEmpty,
    productionNotes: NonEmpty,
  })
  .strict();

const DeckSpecSchema = z
  .object({
    brandId: NonEmpty,
    month: NonEmpty,
    title: NonEmpty,
    subtitle: NonEmpty,
    pages: z.array(DeckPageSchema).min(1),
    approvalFlags: z.array(NonEmpty),
  })
  .strict();

// Production status is set to "not_started" by the pipeline when the deck is built, and is
// meant to be advanced by hand later (no UI for that yet — see the deck review screen's
// "Create team tasks" action, which is the current substitute for per-page status tracking).
const PRODUCTION_STATUSES = ["not_started", "in_progress", "ready_for_review", "complete"];

const STAGE_SCHEMAS = {
  research: ResearchSchema,
  strategy: StrategySchema,
  copy: CopySchema,
  "creative-direction": CreativeDirectionSchema,
  "deck-builder": DeckSpecSchema,
};

module.exports = {
  AssetFormatSchema,
  ApprovedWorkSchema,
  BrandConfigSchema,
  MonthInputSchema,
  ResearchSchema,
  StrategyAssetSchema,
  StrategySchema,
  CopyAssetSchema,
  CopySchema,
  DirectionAssetSchema,
  CreativeDirectionSchema,
  DeckPageSchema,
  DeckSpecSchema,
  PRODUCTION_STATUSES,
  STAGE_SCHEMAS,
};
