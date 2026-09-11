// Mirrors the shapes strategy-app.js (the legacy implementation) reads from Firebase —
// see docs/strategy-os-touchpoints.md. Not exhaustive (only the fields the run list needs);
// each stage's own checkpoint shape gets its own type when the run-detail view is built.

export type StageKey = "research" | "strategy" | "copy" | "creative-direction" | "deck-builder";

export const STAGE_ORDER: StageKey[] = ["research", "strategy", "copy", "creative-direction", "deck-builder"];

export const STAGE_LABELS: Record<StageKey, string> = {
  research: "Research",
  strategy: "Strategy",
  copy: "Copy",
  "creative-direction": "Creative direction",
  "deck-builder": "Deck",
};

export interface StageState {
  status: string; // "locked" | "queued" | "needs_review" | "approved" | "failed" | ...
  checkpoint?: unknown;
  detail?: string;
  candidates?: Record<string, ConceptCandidate>;
  locks?: Record<string, { lockedAt: string; lockedBy: string }>;
  // Deck-builder only — see strategy-app.js's deckCompleteActionsHtml().
  canva?: { status: string; url?: string; detail?: string };
}

// The strategy stage's own checkpoint shape — the "thirteen concept cards" the
// working-instructions doc calls out as the interface that matters most.
export interface StrategyGate {
  logoSwapPass: boolean;
  killListPass: boolean;
  tensionPass: boolean;
  overheardPass: boolean;
}

export interface StrategyAsset {
  assetId: string;
  format: string;
  conceptName: string;
  portfolioId?: string;
  hook: string;
  tension: string;
  sendTo: string;
  gate: StrategyGate;
}

export interface DiscardedConcept {
  conceptName: string;
  failedGate: string;
  reason: string;
}

export interface StrategyCheckpoint {
  monthThesis: string;
  assets: StrategyAsset[];
  discarded?: DiscardedConcept[];
}

// One turn in a candidate's running chat thread — see ConceptChatPanel.tsx and
// pipeline.js's proposeAssetCandidate. A user turn records what was asked for; an
// assistant turn records a one-line summary of what that round produced (computed
// server-side by ASSET_STAGE_CONFIG's summarize()). The candidate object's own shape never
// changes — this is a separate, additive transcript alongside it.
export interface ConceptChatTurn {
  role: "user" | "assistant";
  at: string;
  // user turns:
  notes?: string | null;
  focus?: string | null;
  requestType?: string;
  // assistant turns:
  summary?: string;
}

// A pending refine/similar candidate for one asset — see strategy-concept-propose.js.
export interface ConceptCandidate {
  status: "running" | "ready" | "failed";
  detail?: string;
  requestType?: string;
  notes?: string;
  // The specific part of the asset this request pointed at (e.g. "Caption B", "Script") —
  // see CopyReview.tsx's per-caption/script "Refine this" links and
  // strategy-concept-propose.js's own header comment.
  focus?: string | null;
  // "captions" | "script" (copy only) — set when this candidate is one independent
  // section's own thread rather than a whole-asset one. See ConceptChatPanel.tsx and
  // pipeline.js's ASSET_STAGE_CONFIG.copy.sections.
  section?: string | null;
  // The running conversation for this candidate — grows across chained "refine" turns,
  // resets on a fresh "similar"/"discard"/"replace". See ConceptChatPanel.tsx.
  history?: ConceptChatTurn[];
  candidate?: {
    conceptName?: string;
    hook?: string;
    tension?: string;
    captions?: Caption[];
    claimAudit?: ClaimAudit;
    [key: string]: unknown;
  };
}

// An open map of {deliverableName: count} — reel/carousel/static/story are the ones the
// pipeline can actually generate (see AssetFormatSchema in contracts.js), but a brand's
// config (and this per-run override) can name any other deliverable too, e.g. "blog" —
// see DeliverablesFields.tsx and contracts.js's BrandConfigSchema.deliverables comment for
// why those extra ones are recorded but not enforced against generated asset counts.
//
// Used two ways: as a brand's own stored `deliverables` config (BrandForm.tsx), and as the
// new-run wizard's per-run-only override — see strategy-run-start.js's own header comment.
// Applied by runStrategyStage (pipeline.js) instead of the brand's own stored
// `deliverables`; never written back to the brand config itself.
export type DeliverablesCount = Record<string, number>;

export interface StrategyRun {
  runId: string;
  brandId: string;
  month: string; // YYYY-MM
  status: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
  stages: Partial<Record<StageKey, StageState>>;
  archivedAt?: string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  runtime?: string;
  fixtureDir?: string | null;
  approvals?: Partial<Record<StageKey, { decidedAt: string; decidedBy: string }>>;
  teamTasksCreatedAt?: string;
  // "monthly" | "campaign" (defaults to "monthly" server-side) — tags a run without
  // changing its pipeline; see strategy-run-start.js.
  runType?: "monthly" | "campaign";
  deliverablesOverride?: DeliverablesCount | null;
  sourceContext?: string[];
}

// ---- Research checkpoint (see strategy-app.js's researchReviewHtml) ----
export interface ResearchSource { id: string; url: string; type: string }
export interface LiveQuestion { verbatim: string; underlyingNeed: string; sourceIds: string[] }
export interface CategoryArgument { disagreement: string; sideA: string; sideB: string; credibleBrandPosition: string; credibilityReason: string }
export interface UnspokenBehaviour { behaviour: string; hiddenTension: string }
export interface ExhaustedTerritory { territory: string; reasonExhausted: string }
export interface ResearchCheckpoint {
  liveQuestions?: LiveQuestion[];
  arguments?: CategoryArgument[];
  unspokenBehaviours?: UnspokenBehaviour[];
  exhaustedTerritory?: ExhaustedTerritory[];
  sources?: ResearchSource[];
}

// ---- Copy checkpoint (see strategy-app.js's copyReviewHtml) ----
export interface ClaimAudit { status?: string; rewrittenClaims?: string[]; verificationFlags?: string[] }
export interface Caption { version: string | number; angle: string; copy: string; hashtags?: string[] }
export interface OnCreativeFrame { label: string; text: string }
export interface CopyAsset {
  assetId: string;
  format: string;
  skuNames?: string[];
  portfolioName?: string;
  hook: string;
  onCreative?: { cover?: string; frames?: OnCreativeFrame[]; endFrame?: string };
  script?: { durationSeconds: number; scenes: { timing: string; visual: string; voiceover: string }[] };
  claimAudit?: ClaimAudit;
  captions?: Caption[];
}
export interface CopyCheckpoint {
  assets: CopyAsset[];
  globalVerificationFlags?: string[];
}

// ---- Creative direction checkpoint (see strategy-app.js's directionReviewHtml) ----
export interface DirectionShot { shot: string; framing: string; action: string; productVisibility: string }
export interface DirectionReference { url: string; title?: string; source: string; useFor: string; rightsNote: string }
export interface DirectionAsset {
  assetId: string;
  format: string;
  productionMode: string;
  visualConcept: string;
  artDirection: string;
  palette?: string[];
  typography: string;
  composition: string;
  shotList?: DirectionShot[];
  references?: DirectionReference[];
  designNotes?: string[];
  avoid?: string[];
}
export interface CreativeDirectionCheckpoint {
  assets: DirectionAsset[];
  productionNotes?: string[];
}

// ---- Deck checkpoint (see strategy-app.js's deckReviewHtml) ----
export const PRODUCTION_STATUSES = ["not_started", "in_progress", "ready_for_review", "complete"] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];
export const PRODUCTION_STATUS_LABELS: Record<ProductionStatus, string> = {
  not_started: "Not started", in_progress: "In progress", ready_for_review: "Ready for review", complete: "Complete",
};
export interface DeckPage {
  pageNumber: number;
  assetId: string;
  format: string;
  portfolioAndSku?: string;
  idea: string;
  hook: string;
  creativeCopy: string;
  direction: string;
  shotList: string;
  captionOne: string;
  captionTwo: string;
  captionThree: string;
  referenceImageUrl?: string;
  referenceCredit?: string;
  owner?: string;
  productionStatus: ProductionStatus;
}
export interface DeckCheckpoint {
  title?: string;
  subtitle?: string;
  pages: DeckPage[];
}

export interface StrategyBrand {
  id: string;
  name: string;
  [key: string]: unknown;
}

export function isArchived(run: StrategyRun): boolean {
  return !!run.archivedAt;
}

// The "front" of the pipeline — first stage not yet approved. Matches
// strategy-app.js's currentStageOf().
export function currentStageOf(run: StrategyRun): StageKey {
  for (const stage of STAGE_ORDER) {
    const st = run.stages[stage];
    if (!st || st.status !== "approved") return stage;
  }
  return STAGE_ORDER[STAGE_ORDER.length - 1];
}

// The most-advanced stage that actually has a checkpoint to show — walked from the end of
// STAGE_ORDER backwards, matching strategy-app.js's latestReviewableStage(). Approving
// further stages naturally moves the review screen forward without separate state.
export function latestReviewableStage(run: StrategyRun): StageKey | null {
  for (let i = STAGE_ORDER.length - 1; i >= 0; i--) {
    const stage = STAGE_ORDER[i];
    const st = run.stages[stage];
    if (st && st.checkpoint && (st.status === "needs_review" || st.status === "approved" || st.status === "changes_requested")) return stage;
  }
  return null;
}
