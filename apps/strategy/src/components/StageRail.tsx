// Stage rail with fixed agent persona/emoji on every stage — refined Hub-scale layout
// (see strategy-os-refined-demo.html). Still walks each stage's OWN status rather than
// pattern-matching the run-level status string. Keeps .st-stage-rail / .st-stage-step /
// .is-done / .is-active class names for e2e locators.
import { STAGE_ORDER, type StageKey, type StrategyRun } from "../lib/types";
import { AGENT_LINEUP } from "../lib/format";

const RAIL_ROLES: Record<StageKey, string> = {
  research: "Research",
  strategy: "Strategy",
  copy: "Copy",
  "creative-direction": "Creative",
  "deck-builder": "Deck",
};

const AGENT_BY_STAGE = Object.fromEntries(AGENT_LINEUP.map((a) => [a.stage, a])) as Record<
  StageKey,
  { stage: string; emoji: string; name: string }
>;

function statusLabelFor(status: string | undefined, isActive: boolean, isDone: boolean, isLocked: boolean): string {
  if (isDone) return "Done";
  if (isLocked) return "Locked";
  if (!isActive) return "";
  if (status === "running" || status === "repairing") return "working";
  if (status === "needs_review") return "Review";
  if (status === "failed") return "Failed";
  if (status === "changes_requested") return "Sent back";
  if (status === "queued") return "Queued";
  return status || "";
}

export function StageRail({ run, onReopen }: { run: StrategyRun; onReopen: (stage: StageKey) => void }) {
  let current = STAGE_ORDER.length - 1;
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const status = run.stages[STAGE_ORDER[i]]?.status;
    if (status !== "approved") {
      current = i;
      break;
    }
  }

  return (
    <div className="st-stage-rail" aria-label="Pipeline stages">
      {STAGE_ORDER.map((stage, index) => {
        const agent = AGENT_BY_STAGE[stage];
        const st = run.stages[stage];
        const status = st?.status;
        const done = index < current;
        const isActive = index === current;
        const isLocked = index > current;
        const isWorking = isActive && (status === "running" || status === "repairing");
        const classes = [
          "st-stage-step",
          done && "is-done",
          isActive && "is-active",
          isLocked && "is-locked",
          isWorking && "is-working",
          done && "is-clickable",
        ]
          .filter(Boolean)
          .join(" ");
        const label = statusLabelFor(status, isActive, done, isLocked);
        return (
          <div
            key={stage}
            className={classes}
            title={done ? `Reopen ${RAIL_ROLES[stage]}` : undefined}
            onClick={done ? () => onReopen(stage) : undefined}
          >
            {/* Keep .st-stage-num for CSS/e2e compatibility; it now wraps the agent emoji. */}
            <span className="st-stage-num st-stage-agent" aria-hidden>
              {agent.emoji}
              {done && <span className="st-stage-badge">✓</span>}
              {isLocked && <span className="st-stage-badge is-lock">🔒</span>}
            </span>
            <span className="st-stage-copy">
              <span className="st-stage-name">{agent.name}</span>
              <span className="st-stage-role">{RAIL_ROLES[stage]}</span>
              <span className="st-stage-status">
                {label}
                {isWorking && (
                  <>
                    {" "}
                    <span className="st-working st-working-sm" aria-hidden>
                      <span />
                      <span />
                      <span />
                    </span>
                  </>
                )}
              </span>
              {/* e2e still looks for "Research" / "Strategy" in step text */}
              <span className="st-stage-e2e-label">{RAIL_ROLES[stage]}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
