// The copy stage's review screen — ported from strategy-app.js's copyReviewHtml(). Same
// Refine/Replace/Lock action set as the strategy stage's concept cards, but "Replace"
// (not "Discard") is copy's own auto-accept kill type — see strategy-app.js's
// soReplaceCopyAsset.
import { useState } from "react";
import type { ConceptCandidate, CopyAsset, CopyCheckpoint, StageState, StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { discardConcept, proposeConcept, toggleAssetLock } from "../lib/api";
import { ConceptCandidatePreview } from "./ConceptCandidatePreview";

function claimChipStyle(status?: string) {
  const color = status === "ready" ? "var(--green)" : status === "flagged" ? "var(--yellow)" : "var(--red)";
  const bg = status === "ready" ? "#12291d" : status === "flagged" ? "#3a2c12" : "#2c1414";
  return { color, background: bg };
}

function CopyAssetRow({ run, stage, actor, asset, candidate, locked, onError }: {
  run: StrategyRun; stage: StageState; actor: string; asset: CopyAsset;
  candidate: ConceptCandidate | undefined; locked: boolean; onError: (msg: string) => void;
}) {
  const readOnly = stage.status === "approved";
  const busyCandidate = candidate?.status === "running";
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineNotes, setRefineNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const assetId = asset.assetId;

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

  async function handleReplace() {
    if (!confirm("Replace this asset's copy? A fresh version will be generated automatically.")) return;
    const notes = prompt("Optional: what's wrong with the current copy? Helps the rewrite avoid the same issue.") || "";
    await withBusy(() => discardConcept({ runId: run.runId, stage: "copy", assetId, notes, actor }));
  }

  async function handleSendRefine() {
    const trimmed = refineNotes.trim();
    if (!trimmed) { alert("Add a note on what should change first."); return; }
    await withBusy(() => proposeConcept({ runId: run.runId, stage: "copy", assetId, action: "refine", notes: trimmed }));
  }

  const disabled = busy || busyCandidate;
  const audit = asset.claimAudit || {};
  const label = (asset.skuNames && asset.skuNames.join(", ")) || asset.portfolioName || "—";

  return (
    <div className={`st-concept-row ${locked ? "is-locked" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>
          {asset.assetId} &middot; {asset.format} &middot; {label}
          {locked && <span style={{ color: "var(--green)", fontSize: 11 }}> 🔒</span>}
        </div>
        {audit.status && <span className="st-chip" style={claimChipStyle(audit.status)}>{audit.status}</span>}
      </div>
      <div style={{ margin: "6px 0", fontStyle: "italic" }}>&ldquo;{asset.hook}&rdquo;</div>
      {asset.onCreative?.cover && <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Cover:</b> {asset.onCreative.cover}</div>}
      {(asset.onCreative?.frames || []).map((f, i) => (
        <div key={i} style={{ fontSize: 12, color: "var(--muted)" }}>{f.label}: {f.text}</div>
      ))}
      {asset.onCreative?.endFrame && <div style={{ fontSize: 12, color: "var(--muted)" }}><b>End frame:</b> {asset.onCreative.endFrame}</div>}
      {!!asset.script?.scenes?.length && (
        <div style={{ marginTop: 8 }}>
          <b style={{ fontSize: 12 }}>Script ({asset.script.durationSeconds}s)</b>
          {asset.script.scenes.map((sc, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{sc.timing} — {sc.visual} &middot; VO: "{sc.voiceover}"</div>
          ))}
        </div>
      )}
      {!!audit.rewrittenClaims?.length && <div style={{ fontSize: 12, color: "#e0a53a", marginTop: 6 }}><b>Rewritten claims:</b> {audit.rewrittenClaims.join("; ")}</div>}
      {!!audit.verificationFlags?.length && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 4 }}><b>Needs verification:</b> {audit.verificationFlags.join("; ")}</div>}
      {(asset.captions || []).map((cap, i) => (
        <div key={i} style={{ borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 6 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase" }}>Version {cap.version} &middot; {cap.angle}</div>
          <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{cap.copy}</div>
          <div style={{ fontSize: 11, color: "var(--accent)" }}>{(cap.hashtags || []).join(" ")}</div>
        </div>
      ))}

      {!readOnly && (
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="st-btn st-btn-ghost st-btn-sm" disabled={disabled} onClick={() => setRefineOpen((v) => !v)}>Refine</button>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ color: "var(--red)", borderColor: "var(--red)" }} disabled={disabled} onClick={handleReplace}>Replace</button>
          <button
            className={`st-btn st-btn-sm ${locked ? "st-btn-primary" : "st-btn-ghost"}`}
            style={{ marginLeft: "auto" }}
            onClick={() => withBusy(() => toggleAssetLock({ runId: run.runId, stage: "copy", assetId, actor, locked: !locked }))}
          >
            {locked ? "🔒 Locked" : "Lock"}
          </button>
        </div>
      )}
      {!readOnly && refineOpen && (
        <div style={{ marginTop: 8 }}>
          <textarea
            className="st-form-control"
            placeholder="What should change about this copy?"
            style={{ minHeight: 50, fontSize: 12, marginBottom: 6 }}
            value={refineNotes}
            onChange={(e) => setRefineNotes(e.target.value)}
          />
          <button className="st-btn st-btn-primary st-btn-sm" disabled={disabled} onClick={handleSendRefine}>Send</button>
        </div>
      )}

      <ConceptCandidatePreview runId={run.runId} stage="copy" assetId={assetId} candidate={candidate} actor={actor} onError={onError} />
    </div>
  );
}

export function CopyReview({ run, stage, actor }: { run: StrategyRun; stage: StageState; actor: string }) {
  const c = stage.checkpoint as CopyCheckpoint;
  const readOnly = stage.status === "approved";
  const candidates = stage.candidates || {};
  const locks = stage.locks || {};
  const [error, setError] = useState<string | null>(null);
  const total = (c.assets || []).length;
  const lockedCount = Object.keys(locks).length;
  const left = Math.max(0, total - lockedCount);
  const approval = run.approvals?.copy;

  return (
    <>
      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header" style={{ justifyContent: "space-between" }}>
          Copy <span className="st-tag">{total} assets</span>
          {!readOnly && (
            <span className={`st-lock-summary ${lockedCount === total && total > 0 ? "is-complete" : ""}`} style={{ marginLeft: "auto" }}>
              {lockedCount} of {total} locked{left > 0 ? ` · ${left} left` : ""}
            </span>
          )}
        </div>
        {error && <div className="st-error-text">{error}</div>}
        {(c.assets || []).map((asset) => (
          <CopyAssetRow
            key={asset.assetId}
            run={run}
            stage={stage}
            actor={actor}
            asset={asset}
            candidate={candidates[asset.assetId]}
            locked={!!locks[asset.assetId]}
            onError={setError}
          />
        ))}
      </div>

      {!!c.globalVerificationFlags?.length && (
        <div className="st-board">
          <div className="st-board-header" style={{ color: "var(--red)" }}>Flags across the whole batch</div>
          {c.globalVerificationFlags.map((f, i) => <div key={i} style={{ padding: "6px 0" }}>{f}</div>)}
        </div>
      )}

      {readOnly ? (
        <div className="st-note">Copy approved {fmtDateTime(approval?.decidedAt)} by {approval?.decidedBy}.</div>
      ) : (
        <div className="st-note">Use the "Your next action" card to approve this or send it back with notes.</div>
      )}
    </>
  );
}
