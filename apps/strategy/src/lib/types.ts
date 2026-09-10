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
