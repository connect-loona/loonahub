// The copy stage's review screen — ported from strategy-app.js's copyReviewHtml(). Same
// Replace/Lock action set as the strategy stage's concept cards, but "Replace" (not
// "Discard") is copy's own auto-accept kill type — see strategy-app.js's
// soReplaceCopyAsset.
//
// Captions and script are each their own independently refinable, lockable section (see
// pipeline.js's ASSET_STAGE_CONFIG.copy.sections) — captions render as a row of three
// cards with one shared chat/refine box (plus a one-click "Get 3 variations"), and the
// script gets its own always-visible chat box below it. Each has its own Lock button; an
// asset only counts as "locked" for the stage-wide summary once BOTH are locked.
import { useState } from "react";
import type { ConceptCandidate, CopyAsset, CopyCheckpoint, StageMetrics, StageState, StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { discardConcept, toggleAssetLock } from "../lib/api";
import { ConceptChatPanel } from "./ConceptChatPanel";
import { CompetitionSummary, CriticNote, criticVerdictFor } from "./CriticSummary";

function claimChipStyle(status?: string) {
  const color = status === "ready" ? "var(--green)" : status === "flagged" ? "var(--yellow)" : "var(--red)";
  const bg = status === "ready" ? "#12291d" : status === "flagged" ? "#3a2c12" : "#2c1414";
  return { color, background: bg };
}

function SectionLockButton({ locked, disabled, onClick }: { locked: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button className={`st-btn st-btn-sm ${locked ? "st-btn-primary" : "st-btn-ghost"}`} disabled={disabled} onClick={onClick}>
      {locked ? "🔒 Locked" : "Lock"}
    </button>
  );
}

function CopyAssetRow({ run, stage, actor, asset, captionsCandidate, scriptCandidate, captionsLocked, scriptLocked, metrics, onError }: {
  run: StrategyRun; stage: StageState; actor: string; asset: CopyAsset;
  captionsCandidate: ConceptCandidate | undefined; scriptCandidate: ConceptCandidate | undefined;
  captionsLocked: boolean; scriptLocked: boolean; metrics: StageMetrics | undefined; onError: (msg: string) => void;
}) {
  const readOnly = stage.status === "approved";
  const [busy, setBusy] = useState(false);
  const assetId = asset.assetId;
  const hasScript = !!asset.script?.scenes?.length || asset.format === "reel";

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

  const busyCaptions = captionsCandidate?.status === "running";
  const busyScript = scriptCandidate?.status === "running";
  const disabled = busy || busyCaptions || busyScript;
  const audit = asset.claimAudit || {};
  const verdict = criticVerdictFor(metrics, assetId);
  const label = (asset.skuNames && asset.skuNames.join(", ")) || asset.portfolioName || "—";

  return (
    <div className="st-concept-row">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>
          {asset.assetId} &middot; {asset.format} &middot; {label}
          {captionsLocked && scriptLocked && <span style={{ color: "var(--green)", fontSize: 11 }}> 🔒</span>}
        </div>
        {audit.status && <span className="st-chip" style={claimChipStyle(audit.status)}>{audit.status}</span>}
      </div>
      <div style={{ margin: "6px 0", fontStyle: "italic" }}>&ldquo;{asset.hook}&rdquo;</div>
      {asset.onCreative?.cover && <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Cover:</b> {asset.onCreative.cover}</div>}
      {(asset.onCreative?.frames || []).map((f, i) => (
        <div key={i} style={{ fontSize: 12, color: "var(--muted)" }}>{f.label}: {f.text}</div>
      ))}
      {asset.onCreative?.endFrame && <div style={{ fontSize: 12, color: "var(--muted)" }}><b>End frame:</b> {asset.onCreative.endFrame}</div>}
      {!!audit.rewrittenClaims?.length && <div style={{ fontSize: 12, color: "#e0a53a", marginTop: 6 }}><b>Rewritten claims:</b> {audit.rewrittenClaims.join("; ")}</div>}
      {!!audit.verificationFlags?.length && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 4 }}><b>Needs verification:</b> {audit.verificationFlags.join("; ")}</div>}
      <CriticNote verdict={verdict} />

      {/* ---- Captions: a row of three cards, one shared chat/refine box below ---- */}
      {!!asset.captions?.length && (
        <div className="st-copy-section st-copy-section-captions" style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <b style={{ fontSize: 12 }}>Captions</b>
            {!readOnly && <SectionLockButton locked={captionsLocked} disabled={disabled} onClick={() => withBusy(() => toggleAssetLock({ runId: run.runId, stage: "copy", assetId, actor, locked: !captionsLocked, section: "captions" }))} />}
          </div>
          <div className="st-caption-card-row">
            {asset.captions.map((cap, i) => (
              <div key={i} className="st-caption-card">
                <div className="st-caption-card-label">{cap.version} &middot; {cap.angle}</div>
                <div className="st-caption-card-copy">{cap.copy}</div>
                {!!cap.hashtags?.length && <div className="st-caption-card-tags">{cap.hashtags.join(" ")}</div>}
              </div>
            ))}
          </div>
          {!readOnly && (
            <ConceptChatPanel
              runId={run.runId} stage="copy" assetId={assetId} section="captions" focus="Captions" showVariations
              candidate={captionsCandidate} actor={actor} open onOpenChange={() => {}} showCancel={false} onError={onError}
            />
          )}
        </div>
      )}

      {/* ---- Script: its own always-visible chat box ---- */}
      {hasScript && (
        <div className="st-copy-section st-copy-section-script" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <b style={{ fontSize: 12 }}>Script{asset.script?.durationSeconds ? ` (${asset.script.durationSeconds}s)` : ""}</b>
            {!readOnly && <SectionLockButton locked={scriptLocked} disabled={disabled} onClick={() => withBusy(() => toggleAssetLock({ runId: run.runId, stage: "copy", assetId, actor, locked: !scriptLocked, section: "script" }))} />}
          </div>
          {(asset.script?.scenes || []).map((sc, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{sc.timing} — {sc.visual} &middot; VO: "{sc.voiceover}"</div>
          ))}
          {!readOnly && (
            <ConceptChatPanel
              runId={run.runId} stage="copy" assetId={assetId} section="script" focus="Script"
              candidate={scriptCandidate} actor={actor} open onOpenChange={() => {}} showCancel={false} onError={onError}
            />
          )}
        </div>
      )}

      {!readOnly && (
        <div style={{ marginTop: 10 }}>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ color: "var(--red)", borderColor: "var(--red)" }} disabled={disabled} onClick={handleReplace}>Replace</button>
        </div>
      )}
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
  // An asset counts as "locked" for the stage-wide summary only once BOTH its captions and
  // script sections are locked independently — see SectionLockButton / strategy-asset-
  // lock.js's `section` param.
  const isLocked = (assetId: string) => !!locks[`${assetId}::captions`] && !!locks[`${assetId}::script`];
  const lockedCount = (c.assets || []).filter((a) => isLocked(a.assetId)).length;
  const left = Math.max(0, total - lockedCount);
  const approval = run.approvals?.copy;
  const metrics = run.metrics?.copy;

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
        <CompetitionSummary metrics={metrics} />
        {(c.assets || []).map((asset) => (
          <CopyAssetRow
            key={asset.assetId}
            run={run}
            stage={stage}
            actor={actor}
            asset={asset}
            captionsCandidate={candidates[`${asset.assetId}::captions`]}
            scriptCandidate={candidates[`${asset.assetId}::script`]}
            captionsLocked={!!locks[`${asset.assetId}::captions`]}
            scriptLocked={!!locks[`${asset.assetId}::script`]}
            metrics={metrics}
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
