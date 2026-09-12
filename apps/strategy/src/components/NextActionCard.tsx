// The single "Your next action" card — ported from strategy-app.js's nextActionCardHtml().
// One place that always says, in plain language, what's happening and what (if anything)
// there is to do about it right now. Lands in the review sidebar of the run-detail
// workspace (see strategy-ui.js's buildWorkspace, which moves this specific card there).
import { useState } from "react";
import { currentStageOf, STAGE_LABELS, type StrategyRun } from "../lib/types";
import { plainActionPhrase, STAGE_AGENT_EMOJI } from "../lib/format";
import { createTeamTasks, decideStage, retryStage } from "../lib/api";


function FriendlyError({ message, onRetry, retryBusy, retryLabel = "Retry" }: {
  message: string;
  onRetry?: () => void;
  retryBusy?: boolean;
  retryLabel?: string;
}) {
  const raw = (message || "").trim();
  if (!raw) return null;
  let title = "Something went wrong.";
  if (/timed?\s*out|ETIMEDOUT|deadline/i.test(raw)) title = "That took too long — try again.";
  else if (/failed to fetch|network|ECONN|ENOTFOUND|offline/i.test(raw)) title = "Couldn't reach the server.";
  else if (/401|unauth|not signed|session/i.test(raw)) title = "Session expired — sign back into Hub.";
  else if (/403|forbidden|permission/i.test(raw)) title = "You don't have permission for that.";
  else if (/404|not found/i.test(raw)) title = "We couldn't find that run or stage.";
  else if (/5\d\d|internal server|server error/i.test(raw)) title = "Something broke on our side.";
  else if (raw.length <= 90 && !/[{}\[\]<>]|stack|at\s+\w+\s*\(/i.test(raw)) title = raw;
  const showDetail = title !== raw;
  return (
    <div className="st-friendly-error">
      <div className="st-friendly-error-title">{title}</div>
      <div className="st-friendly-error-actions">
        {onRetry && (
          <button type="button" className="st-btn st-btn-primary st-btn-sm" disabled={!!retryBusy} onClick={onRetry}>
            {retryBusy ? "Retrying…" : retryLabel}
          </button>
        )}
        {showDetail && (
          <details className="st-friendly-error-detail">
            <summary>Technical detail</summary>
            <pre>{raw}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

// Shown once the deck stage is approved — ported from strategy-app.js's
// deckCompleteActionsHtml(). Canva publishing was retired (pipeline.js no longer attempts
// it) — deck output ships as a downloadable .pptx instead, so that's the only deck action
// here now. `stageState` is still accepted for a run whose deck predates the retirement
// and may carry a stale `canva` object; nothing reads it any more.
function DeckCompleteActions({ run, actor }: { run: StrategyRun; actor: string }) {
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
      {error && <FriendlyError message={error} />}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <a
          className="st-btn st-btn-primary"
          style={{ flex: 1, textAlign: "center", textDecoration: "none" }}
          href={`/.netlify/functions/strategy-deck-download?runId=${encodeURIComponent(run.runId)}`}
        >
          Download deck (.pptx)
        </a>
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
          {error && <FriendlyError message={error} />}
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
          <FriendlyError
            message={error || st.detail || "Something went wrong on this stage."}
            onRetry={handleRetry}
            retryBusy={busy === "retry"}
          />
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
