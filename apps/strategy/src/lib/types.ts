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

// A pending refine/similar candidate for one asset — see strategy-concept-propose.js.
export interface ConceptCandidate {
  status: "running" | "ready" | "failed";
  detail?: string;
  requestType?: string;
  notes?: string;
  candidate?: {
    conceptName?: string;
    hook?: string;
    tension?: string;
    [key: string]: unknown;
  };
}

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
