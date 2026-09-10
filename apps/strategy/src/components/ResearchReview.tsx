// The research stage's review screen — ported from strategy-app.js's researchReviewHtml().
// Read-only content (no per-item actions, matching the legacy app) — approve/send-back
// lives entirely in the "Your next action" card.
import type { ResearchCheckpoint, StageState, StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";

export function ResearchReview({ run, stage }: { run: StrategyRun; stage: StageState }) {
  const r = stage.checkpoint as ResearchCheckpoint;
  const readOnly = stage.status === "approved";
  const approval = run.approvals?.research;
  const sources = r.sources || [];

  return (
    <>
      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">Live questions <span className="st-tag">{(r.liveQuestions || []).length}</span></div>
        {(r.liveQuestions || []).map((q, i) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontWeight: 600 }}>&ldquo;{q.verbatim}&rdquo;</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{q.underlyingNeed}</div>
            <div style={{ fontSize: 11 }}>
              Source: {q.sourceIds.map((id, j) => {
                const src = sources.find((s) => s.id === id);
                return src ? (
                  <a key={id} href={src.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{j > 0 ? ", " : ""}{src.type}</a>
                ) : (
                  <span key={id}>{j > 0 ? ", " : ""}{id}</span>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="st-board">
        <div className="st-board-header">Category arguments <span className="st-tag">{(r.arguments || []).length}</span></div>
        {(r.arguments || []).map((a, i) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
            <div style={{ fontWeight: 600 }}>{a.disagreement}</div>
            <div style={{ fontSize: 12, marginTop: 4 }}><b>Side A:</b> {a.sideA}</div>
            <div style={{ fontSize: 12 }}><b>Side B:</b> {a.sideB}</div>
            <div style={{ fontSize: 12, color: "var(--accent)", marginTop: 4 }}>Credible position: {a.credibleBrandPosition} — {a.credibilityReason}</div>
          </div>
        ))}
      </div>

      <div className="st-board">
        <div className="st-board-header">Unspoken behaviours <span className="st-tag">{(r.unspokenBehaviours || []).length}</span></div>
        {(r.unspokenBehaviours || []).map((b, i) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
            <div style={{ fontWeight: 600 }}>{b.behaviour}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{b.hiddenTension}</div>
          </div>
        ))}
      </div>

      <div className="st-board">
        <div className="st-board-header">Exhausted territory (kill list) <span className="st-tag">{(r.exhaustedTerritory || []).length}</span></div>
        {(r.exhaustedTerritory || []).map((t, i) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
            <b>{t.territory}</b> — {t.reasonExhausted}
          </div>
        ))}
      </div>

      {readOnly ? (
        <div className="st-note">Research approved {fmtDateTime(approval?.decidedAt)} by {approval?.decidedBy}.</div>
      ) : (
        <div className="st-note">Use the "Your next action" card to approve this or send it back with notes.</div>
      )}
    </>
  );
}
