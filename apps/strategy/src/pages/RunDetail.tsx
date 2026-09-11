// The run detail / review-gate screen — ported from strategy-app.js's soRenderRunDetail()
// plus strategy-ui.js's buildWorkspace() decorator (the numbered rail + Brand memory +
// review-panel three-column layout that's actually live on Hub today, not just the plainer
// layout strategy-app.js renders on its own — see docs/strategy-os-touchpoints.md).
//
// The working-instructions doc calls this "the interface that matters most": thirteen
// concept cards, each editable, regeneratable with a stated reason, or killable with a
// stated reason (the strategy stage's own review board). All five stages' review boards
// are ported now — research/creative-direction are read-only content, copy shares the
// same refine/replace/lock action set as strategy, and deck adds the per-page Owner/
// Production status fields.
import { latestReviewableStage, STAGE_LABELS, type StrategyRun } from "../lib/types";
import { monthLabel } from "../lib/format";
import { useBrands, useRun } from "../lib/useRuns";
import { reopenStage } from "../lib/api";
import { StageRail } from "../components/StageRail";
import { BrandMemory } from "../components/BrandMemory";
import { NextActionCard } from "../components/NextActionCard";
import { ResearchReview } from "../components/ResearchReview";
import { StrategyReview } from "../components/StrategyReview";
import { CopyReview } from "../components/CopyReview";
import { CreativeDirectionReview } from "../components/CreativeDirectionReview";
import { DeckReview } from "../components/DeckReview";

function ReviewBody({ run, reviewStage }: { run: StrategyRun; reviewStage: ReturnType<typeof latestReviewableStage> }) {
  if (!reviewStage) {
    return (
      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">Nothing to review yet</div>
        <div className="st-note">This run hasn't produced anything to review yet — check "Your next action".</div>
      </div>
    );
  }
  const stage = run.stages[reviewStage]!;
  switch (reviewStage) {
    case "research": return <ResearchReview run={run} stage={stage} />;
    case "strategy": return <StrategyReview run={run} stage={stage} actor={run.owner} />;
    case "copy": return <CopyReview run={run} stage={stage} actor={run.owner} />;
    case "creative-direction": return <CreativeDirectionReview run={run} stage={stage} actor={run.owner} />;
    case "deck-builder": return <DeckReview run={run} stage={stage} />;
  }
}

export function RunDetail({ runId, actor, onBack }: { runId: string; actor: string; onBack: () => void }) {
  const { run, loading } = useRun(runId);
  const { brands } = useBrands();

  if (loading) return <div className="st-note" style={{ marginTop: 20 }}>Loading…</div>;
  if (!run) {
    return (
      <div>
        <div className="st-note" style={{ marginTop: 20 }}>This run could not be found.</div>
        <button className="st-btn st-btn-ghost" style={{ marginTop: 12 }} onClick={onBack}>&larr; Back to Strategy OS</button>
      </div>
    );
  }

  const brand = brands.find((b) => b.id === run.brandId);
  const reviewStage = latestReviewableStage(run);

  async function handleReopen(stage: string) {
    const stageIdx = ["research", "strategy", "copy", "creative-direction", "deck-builder"].indexOf(stage);
    const downstream = stageIdx > -1
      ? ["research", "strategy", "copy", "creative-direction", "deck-builder"].slice(stageIdx + 1).map((s) => STAGE_LABELS[s as keyof typeof STAGE_LABELS])
      : [];
    const warning = `Reopen ${STAGE_LABELS[stage as keyof typeof STAGE_LABELS] || stage}? ` +
      (downstream.length ? `Everything after it (${downstream.join(", ")}) will be reset and will need to be regenerated. ` : "") +
      "This can't be undone.";
    if (!confirm(warning)) return;
    const notes = prompt("Optional: what needs to change?") || "";
    try {
      await reopenStage({ runId: run!.runId, stage, notes, actor });
    } catch (e) {
      alert(`Could not reopen: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div>
      <div className="st-section-header" style={{ marginTop: 0 }}>
        <div>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ marginBottom: 8 }} onClick={onBack}>&larr; All runs</button>
          <div className="st-section-title">{brand?.name || run.brandId} &middot; {monthLabel(run.month)}</div>
        </div>
      </div>

      {/* Full-width and first thing on the page — the "Your next action" card was
          previously the third column of the workspace grid below, off to the side of the
          numbered stage rail; it now leads, since it's the one thing that always says what
          to do right now. */}
      <div className="st-review-panel">
        <NextActionCard run={run} actor={actor} />
      </div>

      <StageRail run={run} onReopen={handleReopen} />

      <div className="st-workspace">
        <BrandMemory brand={brand} />
        <main className="st-workspace-main">
          <ReviewBody run={run} reviewStage={reviewStage} />
        </main>
      </div>
    </div>
  );
}
