// The strategy stage's review screen — ported from strategy-app.js's strategyReviewHtml()/
// conceptCandidateHtml()/gateChip(). This is the interface the working-instructions doc
// calls out as the one that matters most: thirteen concept cards, each editable
// (Refine/Suggest similar), regeneratable with a stated reason (Discard), or locked as a
// human checkpoint.
import { useState } from "react";
import type { ConceptCandidate, StageMetrics, StageState, StrategyCheckpoint, StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { discardConcept, proposeConcept, toggleAssetLock } from "../lib/api";
import { ConceptChatPanel } from "./ConceptChatPanel";
import { CompetitionSummary, CriticNote, criticVerdictFor } from "./CriticSummary";

// `disputed` marks a gate where the writing model's own self-report and the independent
// critic's fresh judgement disagree — the exact failure mode this whole feature exists to
// catch (see validation.js:166's comment), so it's worth calling out visually rather than
// just quietly trusting whichever number happened to be shown.
function GateChip({ pass, label, disputed }: { pass: boolean; label: string; disputed?: boolean }) {
  return (
    <span
      className={`st-chip ${pass ? "st-chip-pass" : "st-chip-fail"}`}
      title={disputed ? "The writer's own self-report disagreed with independent review on this gate." : undefined}
    >
      {pass ? "✓ " : "✗ "}{label}{disputed ? " ⚠" : ""}
    </span>
  );
}

function ConceptRow({ run, stage, actor, assetId, asset, candidate, locked, metrics, onError }: {
  run: StrategyRun; stage: StageState; actor: string; assetId: string;
  asset: StrategyCheckpoint["assets"][number]; candidate: ConceptCandidate | undefined; locked: boolean;
  metrics: StageMetrics | undefined; onError: (msg: string) => void;
}) {
  const readOnly = stage.status === "approved";
  const busyCandidate = candidate?.status === "running";
  const [chatOpen, setChatOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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

  async function handleDiscard() {
    if (!confirm("Discard this concept? A replacement will be generated automatically.")) return;
    const notes = prompt("Optional: why is this concept being discarded? Helps future strategy avoid the same idea.") || "";
    await withBusy(() => discardConcept({ runId: run.runId, stage: "strategy", assetId, notes, actor }));
  }

  const disabled = busy || busyCandidate;
  const verdict = criticVerdictFor(metrics, assetId);

  return (
    <div className={`st-concept-row ${locked ? "is-locked" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>
          {asset.assetId} &middot; {asset.format} &middot; {asset.conceptName}
          {locked && <span style={{ color: "var(--green)", fontSize: 11 }}> 🔒</span>}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>{asset.portfolioId || "—"}</div>
      </div>
      <div style={{ margin: "6px 0", fontStyle: "italic" }}>&ldquo;{asset.hook}&rdquo;</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Tension:</b> {asset.tension}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Send to:</b> {asset.sendTo}</div>
      <div style={{ marginTop: 8 }}>
        <GateChip pass={asset.gate.logoSwapPass} label="Logo-swap" disputed={verdict && verdict.logoSwapPass !== asset.gate.logoSwapPass} />
        <GateChip pass={asset.gate.killListPass} label="Kill list" disputed={verdict && verdict.killListPass !== asset.gate.killListPass} />
        <GateChip pass={asset.gate.tensionPass} label="Tension" disputed={verdict && verdict.tensionPass !== asset.gate.tensionPass} />
        <GateChip pass={asset.gate.overheardPass} label="Overheard" disputed={verdict && verdict.overheardPass !== asset.gate.overheardPass} />
      </div>
      <CriticNote verdict={verdict} />

      {!readOnly && (
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="st-btn st-btn-ghost st-btn-sm" disabled={disabled} onClick={() => setChatOpen((v) => !v)}>Refine</button>
          <button className="st-btn st-btn-ghost st-btn-sm" disabled={disabled} onClick={() => withBusy(() => proposeConcept({ runId: run.runId, stage: "strategy", assetId, action: "similar" }))}>Suggest similar</button>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ color: "var(--red)", borderColor: "var(--red)" }} disabled={disabled} onClick={handleDiscard}>Discard</button>
          <button
            className={`st-btn st-btn-sm ${locked ? "st-btn-primary" : "st-btn-ghost"}`}
            style={{ marginLeft: "auto" }}
            onClick={() => withBusy(() => toggleAssetLock({ runId: run.runId, stage: "strategy", assetId, actor, locked: !locked }))}
          >
            {locked ? "🔒 Locked" : "Lock"}
          </button>
        </div>
      )}
      <ConceptChatPanel
        runId={run.runId} stage="strategy" assetId={assetId} candidate={candidate} actor={actor}
        open={chatOpen} onOpenChange={setChatOpen} onError={onError}
      />
    </div>
  );
}

export function StrategyReview({ run, stage, actor }: { run: StrategyRun; stage: StageState; actor: string }) {
  const s = stage.checkpoint as StrategyCheckpoint;
  const readOnly = stage.status === "approved";
  const candidates = stage.candidates || {};
  const locks = stage.locks || {};
  const [error, setError] = useState<string | null>(null);

  const byFormat = (s.assets || []).reduce<Record<string, number>>((acc, a) => { acc[a.format] = (acc[a.format] || 0) + 1; return acc; }, {});
  const lockedCount = Object.keys(locks).length;
  const total = (s.assets || []).length;
  const left = Math.max(0, total - lockedCount);
  const approval = run.approvals?.strategy;
  const metrics = run.metrics?.strategy;

  return (
    <>
      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">Asset plan <span className="st-tag">{total} assets</span></div>
        <div className="st-note" style={{ marginBottom: 10 }}>
          {byFormat.reel || 0} reel &middot; {byFormat.carousel || 0} carousel &middot; {byFormat.static || 0} static
        </div>
        <div style={{ fontSize: 13, marginBottom: 10 }}><b>Month thesis:</b> {s.monthThesis}</div>
      </div>

      <div className="st-board">
        <div className="st-board-header" style={{ justifyContent: "space-between" }}>
          Concepts
          {!readOnly && (
            <span className={`st-lock-summary ${lockedCount === total && total > 0 ? "is-complete" : ""}`} style={{ marginLeft: "auto" }}>
              {lockedCount} of {total} locked{left > 0 ? ` · ${left} left` : ""}
            </span>
          )}
        </div>
        {error && <div className="st-error-text">{error}</div>}
        <CompetitionSummary metrics={metrics} />
        {(s.assets || []).map((asset) => (
          <ConceptRow
            key={asset.assetId}
            run={run}
            stage={stage}
            actor={actor}
            assetId={asset.assetId}
            asset={asset}
            candidate={candidates[asset.assetId]}
            locked={!!locks[asset.assetId]}
            metrics={metrics}
            onError={setError}
          />
        ))}
      </div>

      {!!s.discarded?.length && (
        <div className="st-board">
          <div className="st-board-header">Discarded candidates <span className="st-tag">{s.discarded.length}</span></div>
          {s.discarded.map((d, i) => (
            <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
              <b>{d.conceptName}</b> — failed {d.failedGate}: {d.reason}
            </div>
          ))}
        </div>
      )}

      {readOnly ? (
        <div className="st-note">Strategy approved {fmtDateTime(approval?.decidedAt)} by {approval?.decidedBy}.</div>
      ) : (
        <div className="st-note">Use the "Your next action" card to approve this or send it back with notes.</div>
      )}
    </>
  );
}
