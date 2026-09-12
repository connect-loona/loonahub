import { useMemo, useState } from "react";
import { useBrands, useRuns } from "../lib/useRuns";
import { currentStageOf, isArchived, STAGE_LABELS, type StrategyBrand, type StrategyRun } from "../lib/types";
import { AGENT_LINEUP, monthLabel, statusLabel } from "../lib/format";
import { archiveRun, purgeRun, restoreRun } from "../lib/api";
import { AgentGreeting } from "../components/AgentGreeting";

type ListView = "active" | "archived";

const AGENT_BY_STAGE = Object.fromEntries(AGENT_LINEUP.map((a) => [a.stage, a]));

function brandInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function brandTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 42% 28%)`;
}

function statusPillClass(status?: string | null): string {
  if (!status) return "";
  if (status === "failed" || status.endsWith("_failed")) return "is-danger";
  if (status.includes("needs_review") || status === "needs_review") return "is-accent";
  if (status.includes("running") || status.includes("repairing") || status === "queued") return "is-working";
  if (status.includes("approved") || status === "approved") return "is-ok";
  return "";
}

function RunCard({
  run,
  brand,
  brandLabel,
  view,
  busy,
  onOpen,
  onArchive,
  onRestore,
  onPurge,
}: {
  run: StrategyRun;
  brand: StrategyBrand | undefined;
  brandLabel: string;
  view: ListView;
  busy: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const stage = currentStageOf(run);
  const agent = AGENT_BY_STAGE[stage];
  const stageLabel = STAGE_LABELS[stage] || stage;
  const logoUrl = (brand?.logoUrl || brand?.logo || brand?.imageUrl) as string | undefined;
  const initials = brandInitials(brandLabel);
  const working = run.status?.includes("running") || run.status?.includes("repairing")
    || run.stages[stage]?.status === "running" || run.stages[stage]?.status === "repairing";

  return (
    <article className="st-run-card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      <div className="st-run-card-logo" style={{ background: brandTint(run.brandId) }} aria-hidden>
        {logoUrl ? <img src={logoUrl} alt="" /> : <span>{initials}</span>}
      </div>
      <div className="st-run-card-body">
        <div className="st-run-card-title">{brandLabel}</div>
        <div className="st-run-card-month">{monthLabel(run.month)}</div>
        <div className="st-run-card-stage">
          <span className={`st-run-card-agent ${working ? "is-working" : ""}`} aria-hidden>{agent?.emoji || "🤖"}</span>
          <span>{agent?.name || "Agent"} · {stageLabel}</span>
        </div>
      </div>
      <div className="st-run-card-aside">
        <span className={`st-status-pill ${statusPillClass(run.status)}`}>{statusLabel(run.status)}</span>
        <div className="st-run-card-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={onOpen}>Open</button>
          {view === "archived" ? (
            <>
              <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={onRestore}>Restore</button>
              <a href="#" className="st-run-card-purge" onClick={(e) => { e.preventDefault(); onPurge(); }}>Purge permanently</a>
            </>
          ) : (
            <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={onArchive}>Archive</button>
          )}
        </div>
      </div>
    </article>
  );
}

export function RunList({ actor, onOpenRun, onManageBrands, onStartNewRun }: {
  actor: string;
  onOpenRun: (runId: string) => void;
  onManageBrands: () => void;
  onStartNewRun: () => void;
}) {
  const { runs, loading: runsLoading } = useRuns();
  const { brands } = useBrands();
  const [view, setView] = useState<ListView>("active");
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const brandById = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);
  const brandName = (id: string) => brandById.get(id)?.name || id;

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

  return (
    <div>
      <AgentGreeting />

      <div className="st-section-header">
        <div className="st-section-title">Strategy OS</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="st-btn st-btn-ghost" onClick={onManageBrands}>Manage brands</button>
          <button className="st-btn st-btn-primary" onClick={onStartNewRun}>+ New strategy run</button>
        </div>
      </div>

      {error && <div className="st-error-text">{error}</div>}

      <div className="st-board st-runs-board">
        <div className="st-board-header" style={{ gap: 10 }}>
          <span>Strategy runs<span className="st-tag" style={{ marginLeft: 8 }}>{visible.length}</span></span>
          <span className="st-view-pills" style={{ marginLeft: "auto" }}>
            <button type="button" className={`st-view-pill ${view === "active" ? "is-active" : ""}`} onClick={() => setView("active")}>Active ({activeRuns.length})</button>
            <button type="button" className={`st-view-pill ${view === "archived" ? "is-active" : ""}`} onClick={() => setView("archived")}>Archived ({archivedRuns.length})</button>
          </span>
        </div>

        {runsLoading ? (
          <div className="st-note">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="st-note">{view === "archived" ? "No archived runs." : "No strategy runs yet — start the first one."}</div>
        ) : (
          <div className="st-run-card-grid">
            {visible.map((run) => (
              <RunCard
                key={run.runId}
                run={run}
                brand={brandById.get(run.brandId)}
                brandLabel={brandName(run.brandId)}
                view={view}
                busy={busyRunId === run.runId}
                onOpen={() => onOpenRun(run.runId)}
                onArchive={() => handleArchive(run)}
                onRestore={() => handleRestore(run)}
                onPurge={() => handlePurge(run)}
              />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
