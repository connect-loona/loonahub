// The single "Your next action" card — ported from strategy-app.js's nextActionCardHtml().
// One place that always says, in plain language, what's happening and what (if anything)
// there is to do about it right now. Lands in the review sidebar of the run-detail
// workspace (see strategy-ui.js's buildWorkspace, which moves this specific card there).
import { useState } from "react";
import { currentStageOf, STAGE_LABELS, type StageState, type StrategyRun } from "../lib/types";
import { plainActionPhrase, STAGE_AGENT_EMOJI } from "../lib/format";
import { createTeamTasks, decideStage, downloadDeck, retryStage } from "../lib/api";

function DeckCompleteActions({ run, actor }: { run: StrategyRun; actor: string }) {
  const tasksCreated = !!run.teamTasksCreatedAt;
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState<"json" | "pptx" | null>(null);
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

  async function handleExport(format: "json" | "pptx") {
    setExporting(format);
    setError(null);
    try { await downloadDeck(run.runId, format); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(null); }
  }

  return (
    <div style={{ marginTop: 10 }}>
      {error && <div className="st-error-text">{error}</div>}
      <div className="st-deck-actions">
        <button className="st-btn st-btn-primary" disabled={exporting !== null} onClick={() => handleExport("pptx")}>{exporting === "pptx" ? "Exporting…" : "Download PPTX"}</button>
        <button className="st-btn st-btn-ghost" disabled={exporting !== null} onClick={() => handleExport("json")}>{exporting === "json" ? "Exporting…" : "Download JSON"}</button>
        <button className={`st-btn ${tasksCreated ? "st-btn-ghost" : "st-btn-primary"}`} disabled={tasksCreated || creating} onClick={handleCreateTasks}>
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

  // Strategy and Copy are the two stages with a per-asset lock ("this one's done, don't
  // touch it again") — approving either of them is what actually kicks off the next stage
  // (Copy, then Creative direction), so this is the point that matters: catch it before
  // moving on with concepts/copy still unlocked, rather than silently carrying whatever's
  // there forward. Research/creative-direction/deck-builder have no lock concept, so this
  // never applies to them.
  function unlockedCount(): number {
    if (stage !== "strategy" && stage !== "copy") return 0;
    const checkpoint = st.checkpoint as { assets?: unknown[] } | undefined;
    const total = checkpoint?.assets?.length || 0;
    const locked = Object.keys(st.locks || {}).length;
    return Math.max(0, total - locked);
  }

  async function handleDecide(decision: "approved" | "changes_requested") {
    if (decision === "approved") {
      const left = unlockedCount();
      if (left > 0) {
        const noun = left === 1 ? "asset is" : "assets are";
        const ok = confirm(`${left} ${noun} still not locked. Continue to the next stage anyway?`);
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
          <div className="st-review-actions">
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
        <DeckCompleteActions run={run} actor={actor} />
      )}
    </div>
  );
}
