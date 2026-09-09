// Ported from loona-strategy-agents/src/contracts.ts, trimmed to what the RRO vertical
// slice needs: brand config, month input, and the Research + Strategy stage outputs.
// Copy/CreativeDirection/DeckSpec schemas are deliberately NOT ported yet — those stages
// aren't part of this slice (see the Strategy OS integration report). Port them the same
// way, verbatim from the same source file, when Phase 3/4 is built.
//
// Field names and validation rules are kept byte-for-byte identical to the original so
// validation.js (also ported) needs no changes, and so the RRO fixtures under
// netlify/functions/lib/strategy/seed/ parse without modification.
"use strict";
const { z } = require("zod");

const NonEmpty = z.string().min(1);
const NullableText = z.string().nullable();

const AssetFormatSchema = z.enum(["reel", "carousel", "static"]);

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
    oneLineTruth: NonEmpty,
    deliverables: z
      .object({
        reel: z.number().int().min(0),
        carousel: z.number().int().min(0),
        static: z.number().int().min(0),
        confirmed: z.boolean(),
      })
      .strict(),
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
    canva: CanvaConfigSchema,
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

const STAGE_SCHEMAS = {
  research: ResearchSchema,
  strategy: StrategySchema,
};

module.exports = {
  AssetFormatSchema,
  BrandConfigSchema,
  MonthInputSchema,
  ResearchSchema,
  StrategyAssetSchema,
  StrategySchema,
  STAGE_SCHEMAS,
};
