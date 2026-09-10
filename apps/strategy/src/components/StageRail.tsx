// The numbered stage rail — ported from strategy-ui.js's stageRail(), the decorator that's
// actually live on Hub today in place of the plainer box-strip strategy-app.js renders on
// its own (see docs/strategy-os-touchpoints.md). Walks each stage's OWN status rather than
// pattern-matching the run-level status string, so a stage whose repair loop exhausted
// (collapsing the run-level status to a bare "failed") still highlights the right step.
import { STAGE_ORDER, type StageKey, type StrategyRun } from "../lib/types";

const RAIL_LABELS: Record<StageKey, string> = {
  research: "Research", strategy: "Strategy", copy: "Copy",
  "creative-direction": "Creative direction", "deck-builder": "Deck",
};

export function StageRail({ run, onReopen }: { run: StrategyRun; onReopen: (stage: StageKey) => void }) {
  let current = STAGE_ORDER.length - 1;
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const status = run.stages[STAGE_ORDER[i]]?.status;
    if (status !== "approved") { current = i; break; }
  }

  return (
    <div className="st-stage-rail">
      {STAGE_ORDER.map((stage, index) => {
        const done = index < current;
        const isActive = index === current;
        const classes = ["st-stage-step", done && "is-done", isActive && "is-active", done && "is-clickable"].filter(Boolean).join(" ");
        return (
          <div
            key={stage}
            className={classes}
            title={done ? `Reopen ${RAIL_LABELS[stage]}` : undefined}
            onClick={done ? () => onReopen(stage) : undefined}
          >
            <span className="st-stage-num">{done ? "✓" : index + 1}</span>
            <span>{RAIL_LABELS[stage]}</span>
          </div>
        );
      })}
    </div>
  );
}
