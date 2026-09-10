// The proposed-replacement block shown under a concept once a refine/similar/discard
// request is in flight or done — ported from strategy-app.js's conceptCandidateHtml().
// Preview shown for a "ready" candidate differs by stage (strategy has conceptName/
// tension, copy has captions/claimAudit instead); everything else about proposing/
// accepting/rejecting it is identical across stages. Shared between StrategyReview and
// CopyReview rather than duplicated.
import { useState } from "react";
import type { ConceptCandidate } from "../lib/types";
import { acceptCandidate, discardConcept, proposeConcept, rejectCandidate } from "../lib/api";

function claimChipStyle(status?: string) {
  const color = status === "ready" ? "var(--green)" : status === "flagged" ? "var(--yellow)" : "var(--red)";
  const bg = status === "ready" ? "#12291d" : status === "flagged" ? "#3a2c12" : "#2c1414";
  return { color, background: bg };
}

export function ConceptCandidatePreview({ runId, stage, assetId, candidate, actor, onError }: {
  runId: string; stage: "strategy" | "copy"; assetId: string; candidate: ConceptCandidate | undefined; actor: string; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!candidate) return null;

  async function withBusy(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (candidate.status === "running") {
    return (
      <div className="st-note" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <span className="st-working" aria-hidden><span /><span /><span /></span>
        <span>{candidate.detail || "Working on a replacement…"}{candidate.focus ? ` (${candidate.focus})` : ""}</span>
      </div>
    );
  }

  if (candidate.status === "failed") {
    return (
      <>
        <div className="st-note" style={{ marginTop: 8, color: "var(--red)" }}>Couldn't generate a replacement: {candidate.detail || "Unknown error"}</div>
        <button
          className="st-btn st-btn-ghost st-btn-sm"
          style={{ marginTop: 6 }}
          disabled={busy}
          onClick={() => withBusy(() => (candidate.requestType === "discard" || candidate.requestType === "replace")
            ? discardConcept({ runId, stage, assetId, notes: candidate.notes, actor })
            : proposeConcept({ runId, stage, assetId, action: (candidate.requestType as "refine" | "similar") || "similar", notes: candidate.notes, focus: candidate.focus || undefined }))}
        >
          Try again
        </button>
      </>
    );
  }

  if (candidate.status === "ready" && candidate.candidate) {
    const c = candidate.candidate;
    const preview = stage === "copy" ? (
      <>
        <div style={{ margin: "4px 0", fontStyle: "italic" }}>&ldquo;{c.hook}&rdquo;</div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>{c.captions?.[0]?.copy || ""}</div>
        {c.claimAudit?.status && (
          <div style={{ marginTop: 4 }}>
            <span className="st-chip" style={claimChipStyle(c.claimAudit.status)}>{c.claimAudit.status}</span>
          </div>
        )}
      </>
    ) : (
      <>
        <div style={{ fontWeight: 700 }}>{c.conceptName}</div>
        <div style={{ margin: "4px 0", fontStyle: "italic" }}>&ldquo;{c.hook}&rdquo;</div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Tension:</b> {c.tension}</div>
      </>
    );
    return (
      <div className="st-candidate-box">
        <div className="st-candidate-label">Proposed replacement{candidate.focus ? ` — ${candidate.focus}` : ""}</div>
        {preview}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="st-btn st-btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={() => withBusy(() => rejectCandidate({ runId, stage, assetId }))}>
            Discard suggestion
          </button>
          <button className="st-btn st-btn-primary" style={{ flex: 1 }} disabled={busy} onClick={() => withBusy(() => acceptCandidate({ runId, stage, assetId, actor }))}>
            Use this instead
          </button>
        </div>
      </div>
    );
  }

  return null;
}
