import { useMemo, useState } from "react";
import { useBrands, useRuns } from "../lib/useRuns";
import { currentStageOf, isArchived, STAGE_LABELS, type StrategyRun } from "../lib/types";
import { fmtDateTime, monthLabel, statusLabel } from "../lib/format";
import { archiveRun, purgeRun, restoreRun, startRun } from "../lib/api";
import { NewRunModal } from "../components/NewRunModal";

type ListView = "active" | "archived";

export function RunList({ actor, onOpenRun }: { actor: string; onOpenRun: (runId: string) => void }) {
  const { runs, loading: runsLoading } = useRuns();
  const { brands } = useBrands();
  const [view, setView] = useState<ListView>("active");
  const [modalOpen, setModalOpen] = useState(false);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const brandName = useMemo(() => {
    const map = new Map(brands.map((b) => [b.id, b.name]));
    return (id: string) => map.get(id) || id;
  }, [brands]);

  const activeRuns = runs.filter((r) => !isArchived(r));
  const archivedRuns = runs.filter(isArchived);
  const visible = view === "archived" ? archivedRuns : activeRuns;

  async function handleArchive(run: StrategyRun) {
    const label = `${brandName(run.brandId)} · ${monthLabel(run.month)}`;
    if (!confirm(`Archive this run (${label})? It moves to the Archived view and won't block starting a new run for the same brand + month. You can restore it anytime.`)) return;
    const reason = prompt("Optional: why are you archiving this?") || undefined;
    setBusyRunId(run.runId);
    setError(null);
    try {
      await archiveRun({ runId: run.runId, actor, reason });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyRunId(null);
    }
  }

  async function handleRestore(run: StrategyRun) {
    const label = `${brandName(run.brandId)} · ${monthLabel(run.month)}`;
    if (!confirm(`Restore this run (${label})? It reappears in the active list.`)) return;
    setBusyRunId(run.runId);
    setError(null);
    try {
      await restoreRun({ runId: run.runId, actor });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyRunId(null);
    }
  }

  async function handlePurge(run: StrategyRun) {
    const label = `${brandName(run.brandId)} · ${monthLabel(run.month)}`;
    const typed = prompt(`This PERMANENTLY deletes "${label}" — it cannot be restored.\n\nType the run's label exactly to confirm:\n\n${label}`);
    if (typed === null) return;
    if (typed !== label) { alert("Didn't match — nothing was deleted."); return; }
    setBusyRunId(run.runId);
    setError(null);
    try {
      await purgeRun({ runId: run.runId, actor });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyRunId(null);
    }
  }

  async function handleStartRun(brandId: string, month: string) {
    const { runId } = await startRun({ brandId, month, actor });
    setModalOpen(false);
    onOpenRun(runId);
  }

  return (
    <div>
      <div className="st-section-header">
        <div className="st-section-title">Strategy OS</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="st-btn st-btn-ghost" disabled title="Coming in a later phase of the rewrite">Manage brands</button>
          <button className="st-btn st-btn-primary" onClick={() => setModalOpen(true)}>+ New monthly strategy</button>
        </div>
      </div>

      {error && <div className="st-error-text">{error}</div>}

      <div className="st-board">
        <div className="st-board-header" style={{ gap: 10 }}>
          <span>Strategy runs<span className="st-tag" style={{ marginLeft: 8 }}>{visible.length}</span></span>
          <span style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <button className={`st-btn st-btn-sm ${view === "active" ? "st-btn-primary" : "st-btn-ghost"}`} onClick={() => setView("active")}>Active ({activeRuns.length})</button>
            <button className={`st-btn st-btn-sm ${view === "archived" ? "st-btn-primary" : "st-btn-ghost"}`} onClick={() => setView("archived")}>Archived ({archivedRuns.length})</button>
          </span>
        </div>

        {runsLoading ? (
          <div className="st-note">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="st-note">{view === "archived" ? "No archived runs." : "No strategy runs yet — start the first one."}</div>
        ) : (
          <div className="st-scroll">
            <table className="st-table st-wide">
              <thead>
                <tr>
                  <th>Client</th><th>Month</th><th>Current stage</th><th>Status</th><th>Owner</th><th>Last updated</th><th />
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => (
                  <tr key={run.runId} className="st-row-clickable" onClick={() => onOpenRun(run.runId)}>
                    <td>{brandName(run.brandId)}</td>
                    <td>{monthLabel(run.month)}</td>
                    <td>{STAGE_LABELS[currentStageOf(run)] || "—"}</td>
                    <td>{statusLabel(run.status)}</td>
                    <td>{run.owner || "—"}</td>
                    <td>{fmtDateTime(run.updatedAt)}</td>
                    <td style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      <button className="st-btn st-btn-ghost st-btn-sm" onClick={() => onOpenRun(run.runId)}>Open</button>
                      {view === "archived" ? (
                        <>
                          <button className="st-btn st-btn-ghost st-btn-sm" disabled={busyRunId === run.runId} onClick={() => handleRestore(run)}>Restore</button>
                          <a href="#" style={{ fontSize: "var(--text-sm)", color: "var(--muted)", alignSelf: "center" }} onClick={(e) => { e.preventDefault(); handlePurge(run); }}>Purge permanently</a>
                        </>
                      ) : (
                        <button className="st-btn st-btn-ghost st-btn-sm" disabled={busyRunId === run.runId} onClick={() => handleArchive(run)}>Archive</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <NewRunModal
          brands={brands}
          onCancel={() => setModalOpen(false)}
          onSubmit={handleStartRun}
        />
      )}
    </div>
  );
}
