// The creative-direction stage's review screen — ported from strategy-app.js's
// directionReviewHtml(). No refine/regenerate actions here (matching the legacy app), but
// each asset now has its own Lock button — see strategy-stage-approve.js's header comment:
// approving a stage with anything locked now carries forward only the locked subset, so
// this is the one place in creative-direction to say "keep this one" before moving on.
import { useState } from "react";
import type { CreativeDirectionCheckpoint, StageState, StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { toggleAssetLock } from "../lib/api";

export function CreativeDirectionReview({ run, stage, actor }: { run: StrategyRun; stage: StageState; actor: string }) {
  const d = stage.checkpoint as CreativeDirectionCheckpoint;
  const readOnly = stage.status === "approved";
  const approval = run.approvals?.["creative-direction"];
  const locks = stage.locks || {};
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = (d.assets || []).length;
  const lockedCount = (d.assets || []).filter((a) => !!locks[a.assetId]).length;
  const left = Math.max(0, total - lockedCount);

  async function handleToggleLock(assetId: string, locked: boolean) {
    setBusyId(assetId);
    setError(null);
    try {
      await toggleAssetLock({ runId: run.runId, stage: "creative-direction", assetId, actor, locked });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header" style={{ justifyContent: "space-between" }}>
          Creative direction <span className="st-tag">{total} assets</span>
          {!readOnly && (
            <span className={`st-lock-summary ${lockedCount === total && total > 0 ? "is-complete" : ""}`} style={{ marginLeft: "auto" }}>
              {lockedCount} of {total} locked{left > 0 ? ` · ${left} left` : ""}
            </span>
          )}
        </div>
        {error && <div className="st-error-text">{error}</div>}
        {(d.assets || []).map((a) => {
          const locked = !!locks[a.assetId];
          return (
          <div key={a.assetId} style={{ borderBottom: "1px solid var(--border)", padding: "12px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <div style={{ fontWeight: 700 }}>
                {a.assetId} &middot; {a.format} &middot; {a.productionMode}
                {locked && <span style={{ color: "var(--green)", fontSize: 11 }}> 🔒</span>}
              </div>
              {!readOnly && (
                <button
                  className={`st-btn st-btn-sm ${locked ? "st-btn-primary" : "st-btn-ghost"}`}
                  disabled={busyId === a.assetId}
                  onClick={() => handleToggleLock(a.assetId, !locked)}
                >
                  {locked ? "🔒 Locked" : "Lock"}
                </button>
              )}
            </div>
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
          );
        })}
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
