// The strategy stage's review screen — ported from strategy-app.js's strategyReviewHtml()/
// conceptCandidateHtml()/gateChip(). Refined: one concept at a time with Approve / Tweak /
// Skip (Hub-scale), matching strategy-os-refined-demo.html. All concept rows stay mounted
// (scroll-snap carousel) so existing e2e locators keep working. Backend APIs unchanged.
import { useEffect, useRef, useState } from "react";
import type { ConceptCandidate, StageMetrics, StageState, StrategyCheckpoint, StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { discardConcept, proposeConcept, toggleAssetLock } from "../lib/api";
import { ConceptChatPanel } from "./ConceptChatPanel";
import { CompetitionSummary, CriticNote, criticVerdictFor } from "./CriticSummary";

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

function ConceptRow({ run, stage, actor, assetId, asset, candidate, locked, metrics, onError, chatOpen, onChatOpenChange }: {
  run: StrategyRun; stage: StageState; actor: string; assetId: string;
  asset: StrategyCheckpoint["assets"][number]; candidate: ConceptCandidate | undefined; locked: boolean;
  metrics: StageMetrics | undefined; onError: (msg: string) => void;
  chatOpen: boolean; onChatOpenChange: (open: boolean) => void;
}) {
  const readOnly = stage.status === "approved";
  const busyCandidate = candidate?.status === "running";
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
    <div className={`st-concept-row ${locked ? "is-locked" : ""}`} data-asset-id={assetId}>
      <div className="st-concept-meta">{asset.format} concept · {asset.assetId}{locked ? " · locked" : ""}{asset.portfolioId ? ` · ${asset.portfolioId}` : ""}</div>
      <div className="st-concept-title">
        {asset.conceptName}
        {locked && <span style={{ color: "var(--green)", fontSize: 11 }}> 🔒</span>}
      </div>
      <p className="st-concept-hook">&ldquo;{asset.hook}&rdquo;</p>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Tension:</b> {asset.tension}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Send to:</b> {asset.sendTo}</div>
      <div className="st-concept-chips" style={{ marginTop: 8 }}>
        <GateChip pass={asset.gate.logoSwapPass} label="Logo-swap" disputed={verdict && verdict.logoSwapPass !== asset.gate.logoSwapPass} />
        <GateChip pass={asset.gate.killListPass} label="Kill list" disputed={verdict && verdict.killListPass !== asset.gate.killListPass} />
        <GateChip pass={asset.gate.tensionPass} label="Tension" disputed={verdict && verdict.tensionPass !== asset.gate.tensionPass} />
        <GateChip pass={asset.gate.overheardPass} label="Overheard" disputed={verdict && verdict.overheardPass !== asset.gate.overheardPass} />
      </div>
      <CriticNote verdict={verdict} />

      {!readOnly && (
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="st-btn st-btn-ghost st-btn-sm" disabled={disabled} onClick={() => onChatOpenChange(!chatOpen)}>Refine</button>
          <button className="st-btn st-btn-ghost st-btn-sm" disabled={disabled} onClick={() => withBusy(() => proposeConcept({ runId: run.runId, stage: "strategy", assetId, action: "similar" }))}>Suggest similar</button>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ color: "var(--red)", borderColor: "var(--red)" }} disabled={disabled} onClick={handleDiscard}>Discard</button>
          <button
            className={`st-btn st-btn-sm ${locked ? "st-btn-primary" : "st-btn-ghost"}`}
            style={{ marginLeft: "auto" }}
            disabled={disabled}
            onClick={() => withBusy(() => toggleAssetLock({ runId: run.runId, stage: "strategy", assetId, actor, locked: !locked }))}
          >
            {locked ? "🔒 Locked" : "Lock"}
          </button>
        </div>
      )}
      <ConceptChatPanel
        runId={run.runId} stage="strategy" assetId={assetId} candidate={candidate} actor={actor}
        open={chatOpen} onOpenChange={onChatOpenChange} onError={onError}
      />
    </div>
  );
}

function ConceptRowManaged(props: Omit<Parameters<typeof ConceptRow>[0], "chatOpen" | "onChatOpenChange"> & { tweakSignal?: number; isFocused?: boolean }) {
  const [chatOpen, setChatOpen] = useState(false);
  const lastSignal = useRef(0);
  useEffect(() => {
    if (!props.isFocused) return;
    if (props.tweakSignal && props.tweakSignal !== lastSignal.current) {
      lastSignal.current = props.tweakSignal;
      setChatOpen(true);
    }
  }, [props.tweakSignal, props.isFocused]);
  const { tweakSignal: _t, isFocused: _i, ...rest } = props;
  return <ConceptRow {...rest} chatOpen={chatOpen} onChatOpenChange={setChatOpen} />;
}

export function StrategyReview({ run, stage, actor }: { run: StrategyRun; stage: StageState; actor: string }) {
  const s = stage.checkpoint as StrategyCheckpoint;
  const readOnly = stage.status === "approved";
  const candidates = stage.candidates || {};
  const locks = stage.locks || {};
  const [error, setError] = useState<string | null>(null);
  const assets = s.assets || [];
  const [focusIdx, setFocusIdx] = useState(0);
  const [tweakToken, setTweakToken] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [barBusy, setBarBusy] = useState(false);
  const carouselRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFocusIdx((i) => Math.min(i, Math.max(0, assets.length - 1)));
  }, [assets.length]);

  useEffect(() => {
    if (showAll) return;
    const el = carouselRef.current?.querySelectorAll(".st-concept-slide")[focusIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  }, [focusIdx, showAll, assets.length]);

  const byFormat = assets.reduce<Record<string, number>>((acc, a) => { acc[a.format] = (acc[a.format] || 0) + 1; return acc; }, {});
  const lockedCount = Object.keys(locks).length;
  const total = assets.length;
  const left = Math.max(0, total - lockedCount);
  const approval = run.approvals?.strategy;
  const metrics = run.metrics?.strategy;
  const focused = assets[focusIdx];

  function goNext() {
    setFocusIdx((i) => Math.min(i + 1, Math.max(0, total - 1)));
  }

  async function handleApproveFocus() {
    if (!focused || readOnly) return;
    setBarBusy(true);
    setError(null);
    try {
      if (!locks[focused.assetId]) {
        await toggleAssetLock({ runId: run.runId, stage: "strategy", assetId: focused.assetId, actor, locked: true });
      }
      goNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBarBusy(false);
    }
  }

  function handleTweak() {
    setTweakToken((t) => t + 1);
  }

  function handleSkip() {
    goNext();
  }

  return (
    <>
      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">Asset plan <span className="st-tag">{total} assets</span></div>
        <div className="st-note" style={{ marginBottom: 10 }}>
          {byFormat.reel || 0} reel &middot; {byFormat.carousel || 0} carousel &middot; {byFormat.static || 0} static
        </div>
        <div style={{ fontSize: 13, marginBottom: 10 }}><b>Month thesis:</b> {s.monthThesis}</div>
      </div>

      <div className="st-board st-concept-board">
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

        {total > 1 && (
          <div className="st-concept-toolbar">
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "One at a time" : "Show all"}
            </button>
            {!showAll && (
              <div className="st-concept-pills" role="tablist" aria-label="Concepts">
                {assets.map((a, i) => (
                  <button
                    key={a.assetId}
                    type="button"
                    role="tab"
                    aria-selected={i === focusIdx}
                    className={`st-concept-pill ${i === focusIdx ? "is-active" : ""} ${locks[a.assetId] ? "is-locked" : ""}`}
                    onClick={() => setFocusIdx(i)}
                    title={a.conceptName}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!showAll && total > 0 && (
          <div className="st-concept-focus-meta">{focused?.format || "concept"} · {focusIdx + 1} of {total}</div>
        )}

        <div
          ref={carouselRef}
          className={showAll || total <= 1 ? "st-concept-list" : "st-concept-carousel"}
        >
          {assets.map((asset, i) => (
            <div key={asset.assetId} className="st-concept-slide">
              <ConceptRowManaged
                run={run}
                stage={stage}
                actor={actor}
                assetId={asset.assetId}
                asset={asset}
                candidate={candidates[asset.assetId]}
                locked={!!locks[asset.assetId]}
                metrics={metrics}
                onError={setError}
                tweakSignal={tweakToken} isFocused={!showAll && i === focusIdx}
              />
            </div>
          ))}
        </div>
      </div>

      {!readOnly && !showAll && focused && total > 0 && (
        <div className="st-review-bar" role="toolbar" aria-label="Concept actions">
          <div className="st-review-bar-inner">
            <button type="button" className="st-btn st-btn-approve" disabled={barBusy} onClick={handleApproveFocus}>
              Approve
            </button>
            <button type="button" className="st-btn st-btn-tweak" disabled={barBusy} onClick={handleTweak}>
              Tweak
            </button>
            <button type="button" className="st-btn st-btn-skip" disabled={barBusy || focusIdx >= total - 1} onClick={handleSkip}>
              Skip
            </button>
            <div className="st-review-prog">
              {focusIdx + 1} of {total}
              <span className="st-review-prog-bar" aria-hidden>
                <i style={{ width: `${((focusIdx + 1) / Math.max(total, 1)) * 100}%` }} />
              </span>
            </div>
          </div>
        </div>
      )}

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
        <div className="st-note">Use the &quot;Your next action&quot; card to approve the whole stage or send it back with notes.</div>
      )}
    </>
  );
}
