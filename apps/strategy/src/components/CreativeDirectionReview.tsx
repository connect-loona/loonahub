// The creative-direction stage's review screen — ported from strategy-app.js's
// directionReviewHtml(). Read-only content (no per-item actions, matching the legacy
// app) — approve/send-back lives entirely in the "Your next action" card.
import type { CreativeDirectionCheckpoint, StageState, StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";

export function CreativeDirectionReview({ run, stage }: { run: StrategyRun; stage: StageState }) {
  const d = stage.checkpoint as CreativeDirectionCheckpoint;
  const readOnly = stage.status === "approved";
  const approval = run.approvals?.["creative-direction"];

  return (
    <>
      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">Creative direction <span className="st-tag">{(d.assets || []).length} assets</span></div>
        {(d.assets || []).map((a) => (
          <div key={a.assetId} style={{ borderBottom: "1px solid var(--border)", padding: "12px 0" }}>
            <div style={{ fontWeight: 700 }}>{a.assetId} &middot; {a.format} &middot; {a.productionMode}</div>
            <div style={{ margin: "6px 0" }}>{a.visualConcept}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Art direction:</b> {a.artDirection}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Palette:</b> {(a.palette || []).join(", ")}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Typography:</b> {a.typography}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Composition:</b> {a.composition}</div>
            {(a.shotList || []).map((s, i) => (
              <div key={i} style={{ fontSize: 12, color: "var(--muted)", borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 6 }}>
                <b>{s.shot}:</b> {s.framing} — {s.action} &middot; {s.productVisibility}
              </div>
            ))}
            {(a.references || []).map((r, i) => (
              <div key={i} style={{ fontSize: 12, borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 6 }}>
                <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{r.title || r.url}</a>
                {" "}&middot; <span style={{ color: "var(--muted)" }}>{r.source}</span>
                <div style={{ color: "var(--muted)" }}>Use for: {r.useFor}</div>
                <div style={{ color: "var(--yellow)" }}>{r.rightsNote}</div>
              </div>
            ))}
            {!!a.designNotes?.length && <div style={{ fontSize: 12, marginTop: 6 }}><b>Design notes:</b> {a.designNotes.join("; ")}</div>}
            {!!a.avoid?.length && <div style={{ fontSize: 12, color: "var(--red)" }}><b>Avoid:</b> {a.avoid.join("; ")}</div>}
          </div>
        ))}
      </div>

      {!!d.productionNotes?.length && (
        <div className="st-board">
          <div className="st-board-header">Production notes</div>
          {d.productionNotes.map((n, i) => <div key={i} style={{ padding: "6px 0" }}>{n}</div>)}
        </div>
      )}

      {readOnly ? (
        <div className="st-note">Creative direction approved {fmtDateTime(approval?.decidedAt)} by {approval?.decidedBy}.</div>
      ) : (
        <div className="st-note">Use the "Your next action" card to approve this or send it back with notes.</div>
      )}
    </>
  );
}
