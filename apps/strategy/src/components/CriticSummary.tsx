// Surfaces executeCompetitiveStage's own findings (pipeline.js) — which model(s) actually
// wrote a stage, whether an independent critic reviewed it, and per-asset scores/reasoning
// — none of which reached the review screen before this. Shared by StrategyReview.tsx and
// CopyReview.tsx, the two stages that ever run through it; every other stage's `metrics`
// simply won't carry a `competition` field, and both components already treat that as
// "nothing to show" rather than an error.
import type { CriticAssetVerdict, StageMetrics } from "../lib/types";

function providerLabel(name?: string | null): string {
  if (name === "openai") return "ChatGPT";
  if (name === "claude") return "Claude";
  return name || "a model";
}

// competition.servedBy is a single provider name, or "providerA+providerB" when a merge
// happened (see pipeline.js's executeCompetitiveStage) — split it back apart to name both.
function servedByLabel(servedBy?: string): string {
  if (!servedBy) return "a model";
  const parts = servedBy.split("+");
  return parts.map(providerLabel).join(" + ");
}

export function criticVerdictFor(metrics: StageMetrics | undefined, assetId: string): CriticAssetVerdict | undefined {
  return metrics?.criticVerdicts?.find((v) => v.assetId === assetId);
}

// The stage-level line: who wrote it, whether it was contested, and anything the critic
// flagged that isn't tied to one specific asset. Renders nothing for a stage that never ran
// through the competitive path (no `metrics.competition` at all) — an older run, or a stage
// this feature doesn't apply to (research/creative-direction/deck-builder).
export function CompetitionSummary({ metrics }: { metrics: StageMetrics | undefined }) {
  if (!metrics || !metrics.competition) return null;
  const { competition, criticSkippedReason, criticPortfolioNotes, gateWarnings } = metrics;

  return (
    <>
      <div className="st-note" style={{ marginBottom: 10 }}>
        {competition.contested ? (
          competition.mergeRejected ? (
            <>Both models drafted this. The combined version didn&apos;t hold up under its own rules, so {servedByLabel(competition.servedBy)}&apos;s own version shipped instead.</>
          ) : competition.criticUnavailable ? (
            <>Both models drafted this, but no independent reviewer was reachable to score them — {servedByLabel(competition.servedBy)}&apos;s version shipped on its own self-report.</>
          ) : (
            <>
              Both models drafted this — {servedByLabel(competition.basedOn)}&apos;s version led overall.
              {competition.swapsFromChallenger
                ? ` ${competition.swapsFromChallenger} concept${competition.swapsFromChallenger === 1 ? "" : "s"} came from the runner-up where it scored higher on independent review.`
                : " It won every slot on independent review."}
            </>
          )
        ) : (
          <>
            Written by {servedByLabel(competition.servedBy)}
            {criticSkippedReason
              ? ` — no second model was reachable to review it independently (${criticSkippedReason}).`
              : ", reviewed independently by the other model."}
          </>
        )}
      </div>

      {!!criticPortfolioNotes?.length && (
        <div className="st-note" style={{ marginBottom: 10 }}>
          <b>Independent review, across the whole set:</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {criticPortfolioNotes.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        </div>
      )}

      {!!gateWarnings?.length && (
        <div className="st-error-text" style={{ marginBottom: 10 }}>
          ⚠️ The independent reviewer still had concerns after one round of fixes — worth checking before approving:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {gateWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

// The per-asset line: this specific concept/copy's independent score and reasoning, when a
// critic reviewed it. Silent when there's no verdict for this asset — either the whole
// stage had no independent critic (see CompetitionSummary above, shown once per stage
// rather than repeated on every card), or this is an older run predating the feature.
export function CriticNote({ verdict }: { verdict: CriticAssetVerdict | undefined }) {
  if (!verdict) return null;
  const failedGates = [
    !verdict.logoSwapPass && "logo swap",
    !verdict.killListPass && "kill list",
    !verdict.tensionPass && "tension",
    !verdict.overheardPass && "overheard",
  ].filter(Boolean) as string[];

  return (
    <div style={{ fontSize: 11, color: failedGates.length ? "var(--red)" : "var(--muted)", marginTop: 4 }}>
      <b>Independent review: {verdict.score}/10.</b> {verdict.reasoning}
      {!!verdict.fixes.length && <> <i>Fix: {verdict.fixes.join(" ")}</i></>}
    </div>
  );
}
