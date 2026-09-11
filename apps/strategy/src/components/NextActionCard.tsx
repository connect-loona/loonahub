// The single "Your next action" card — ported from strategy-app.js's nextActionCardHtml().
// One place that always says, in plain language, what's happening and what (if anything)
// there is to do about it right now. Lands in the review sidebar of the run-detail
// workspace (see strategy-ui.js's buildWorkspace, which moves this specific card there).
import { useState } from "react";
import { currentStageOf, STAGE_LABELS, type StageState, type StrategyRun } from "../lib/types";
import { plainActionPhrase, STAGE_AGENT_EMOJI } from "../lib/format";
import { createTeamTasks, decideStage, retryStage } from "../lib/api";

// Shown once the deck stage is approved — ported from strategy-app.js's
// deckCompleteActionsHtml(). Canva's own status can still be not_configured/failed even
// here (deck content itself doesn't depend on Canva succeeding).
function DeckCompleteActions({ run, actor, stageState }: { run: StrategyRun; actor: string; stageState: StageState }) {
  const canva = stageState.canva;
  const tasksCreated = !!run.teamTasksCreatedAt;
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreateTasks() {
    setCreating(true);
    setError(null);
    try {
      await createTeamTasks({ runId: run.runId, actor });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      {error && <div className="st-error-text">{error}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <a
          className="st-btn st-btn-primary"
          style={{ flex: 1, textAlign: "center", textDecoration: "none" }}
          href={`/.netlify/functions/strategy-deck-download?runId=${encodeURIComponent(run.runId)}`}
        >
          Download deck (.pptx)
        </a>
        {canva?.status === "published" && canva.url ? (
          <a className="st-btn st-btn-primary" style={{ flex: 1, textAlign: "center", textDecoration: "none" }} href={canva.url} target="_blank" rel="noopener noreferrer">
            Open Canva deck
          </a>
        ) : canva?.status === "failed" ? (
          <div className="st-note" style={{ color: "var(--red)", flex: 1 }}>Canva publish failed: {canva.detail || "Unknown error"}</div>
        ) : (
          <div className="st-note" style={{ flex: 1 }}>{canva?.detail || "Canva isn't connected for this brand yet — the deck content is ready above."}</div>
        )}
        <button className={`st-btn ${tasksCreated ? "st-btn-ghost" : "st-btn-primary"}`} style={{ flex: 1 }} disabled={tasksCreated || creating} onClick={handleCreateTasks}>
          {tasksCreated ? "Team tasks created ✓" : creating ? "Creating…" : "Create team tasks"}
        </button>
      </div>
    </div>
  );
}

export function NextActionCard({ run, actor }: { run: StrategyRun; actor: string }) {
  const stage = currentStageOf(run);
  const st = run.stages[stage] || { status: "locked" };
  const phrase = plainActionPhrase(stage, st.status);
  const isWorking = st.status === "running" || st.status === "repairing";
  const accent = st.status === "failed" ? "var(--red)" : st.status === "needs_review" ? "var(--accent)" : st.status === "approved" ? "var(--green)" : "var(--text)";

  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"approve" | "notes" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Strategy, Copy and Creative direction each have a per-asset lock — and approving any
  // of them now has a real, load-bearing effect (see strategy-stage-approve.js's own
  // comment): with anything locked, ONLY the locked subset moves to the next stage and
  // everything else is dropped from the run entirely. Locking is opt-in — approve with
  // NOTHING locked and everything still advances exactly as before — so this only needs to
  // warn about the one case that actually loses work: some, but not all, locked. Research
  // and deck-builder have no lock concept, so this never applies to them.
  function isAssetLocked(assetId: string, locks: Record<string, unknown>): boolean {
    if (stage === "copy") return !!locks[`${assetId}::captions`] && !!locks[`${assetId}::script`];
    return !!locks[assetId];
  }

  function lockSummary(): { total: number; locked: number } {
    if (stage !== "strategy" && stage !== "copy" && stage !== "creative-direction") return { total: 0, locked: 0 };
    const checkpoint = st.checkpoint as { assets?: { assetId: string }[] } | undefined;
    const assets = checkpoint?.assets || [];
    const locks = st.locks || {};
    return { total: assets.length, locked: assets.filter((a) => isAssetLocked(a.assetId, locks)).length };
  }

  async function handleDecide(decision: "approved" | "changes_requested") {
    if (decision === "approved") {
      const { total, locked } = lockSummary();
      if (locked > 0 && locked < total) {
        const dropped = total - locked;
        const keptNoun = locked === 1 ? "asset" : "assets";
        const droppedNoun = dropped === 1 ? "concept" : "concepts";
        const ok = confirm(
          `Only the ${locked} locked ${keptNoun} will move to the next stage — the other ${dropped} unlocked ${droppedNoun} will be dropped from this run. This can't be undone. Continue?`,
        );
        if (!ok) return;
      }
    }
    setBusy(decision === "approved" ? "approve" : "notes");
    setError(null);
    try {
      await decideStage({ runId: run.runId, stage, decision, actor, notes: notes.trim() });
      // The live Firebase listener re-renders once the function's writes land — no manual
      // refresh needed here.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry() {
    setBusy("retry");
    setError(null);
    try {
      await retryStage({ runId: run.runId, stage, actor });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="st-board" style={{ marginTop: 0, borderColor: accent }}>
      <div className="st-board-header">Your next action</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent }}>
        {isWorking && <>{STAGE_AGENT_EMOJI[stage] || "🤖"} </>}
        {phrase}
        {isWorking && <> <span className="st-working" aria-hidden><span /><span /><span /></span></>}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{STAGE_LABELS[stage]} stage</div>

      {st.status === "needs_review" && (
        <>
          <textarea
            className="st-form-control"
            placeholder="Notes (optional)"
            style={{ margin: "10px 0", minHeight: 56 }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {error && <div className="st-error-text">{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="st-btn st-btn-ghost" style={{ flex: 1 }} disabled={busy !== null} onClick={() => handleDecide("changes_requested")}>
              {busy === "notes" ? <>Sending… <span className="st-working" aria-hidden><span /><span /><span /></span></> : "Send back with notes"}
            </button>
            <button className="st-btn st-btn-primary" style={{ flex: 1 }} disabled={busy !== null} onClick={() => handleDecide("approved")}>
              {busy === "approve" ? <>Approving… <span className="st-working" aria-hidden><span /><span /><span /></span></> : "Approve"}
            </button>
          </div>
        </>
      )}

      {st.status === "failed" && (
        <>
          <div className="st-note" style={{ color: "var(--red)", margin: "8px 0" }}>{st.detail || "No details recorded."}</div>
          {error && <div className="st-error-text">{error}</div>}
          <button className="st-btn st-btn-primary" disabled={busy !== null} onClick={handleRetry}>
            {busy === "retry" ? <>Retrying… <span className="st-working" aria-hidden><span /><span /><span /></span></> : "Retry"}
          </button>
        </>
      )}

      {st.status === "changes_requested" && (
        <div className="st-note" style={{ margin: "8px 0" }}>
          Sent back for changes — this needs a person to update the run and retry {STAGE_LABELS[stage]} by hand for now.
        </div>
      )}

      {isWorking && (
        <div className="st-note" style={{ margin: "8px 0", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="st-working" aria-hidden><span /><span /><span /></span>
          <span>{st.detail || "Working…"} This updates live — no need to refresh.</span>
        </div>
      )}

      {stage === "deck-builder" && st.status === "approved" && (
        <DeckCompleteActions run={run} actor={actor} stageState={st} />
      )}
    </div>
  );
}
