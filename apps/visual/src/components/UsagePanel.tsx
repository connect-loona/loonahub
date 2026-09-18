import { useEffect, useMemo, useState } from "react";
import { usageReport, type UsageReport } from "../lib/api";

function money(value?: number | null) { return value == null ? "—" : `$${value.toFixed(2)}`; }

export function UsagePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = (showSpinner = false) => {
      if (showSpinner) setLoading(true);
      setError(null);
      usageReport(month).then((value) => {
        if (!alive) return;
        setReport(value); setLastUpdated(new Date());
      }).catch((e) => alive && setError(e instanceof Error ? e.message : String(e))).finally(() => alive && setLoading(false));
    };
    load(true);
    const timer = window.setInterval(() => load(false), 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [open, month]);

  const csv = useMemo(() => {
    if (!report) return "";
    const rows = [["Person", "Email", "Operations", "Images", "Generations", "Magnific enhancements", "Strategy stages", "Chosen", "Reviews", "BB questions", "Mani questions", "Failures", "Selection rate"]]
      .concat(report.users.map((r) => [r.name || r.key, r.email || "", ...[r.requests, r.outputs, r.generations, r.enhancements, r.strategyRuns, r.picks, r.reviews, r.bbQuestions, r.maniQuestions, r.failures].map(String), r.outputs ? `${Math.round((r.picks / r.outputs) * 100)}%` : "—"]));
    return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  }, [report]);

  function downloadCsv() {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `loona-api-usage-${month}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return <div className={`vs-usage-drawer${open ? " is-open" : ""}`} aria-hidden={!open}>
    <div className="vs-usage-head"><div><h2>API Control Room</h2><p>Continuous spend, adoption and coaching signals</p></div><button type="button" onClick={onClose}>Close</button></div>
    <div className="vs-usage-filter"><label>Month <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>{report && <button type="button" onClick={downloadCsv}>Export CSV</button>}</div>
    {loading && <p className="vs-muted">Loading usage…</p>}
    {error && <p className="vs-ref-error">{error}</p>}
    {report && <>
      <div className="vs-usage-cards">
        <div><span>Hub operations</span><b>{report.totals.requests}</b></div>
        <div><span>Images produced</span><b>{report.totals.outputs}</b></div>
        <div><span>OpenAI spend</span><b>{money(report.accounts.openai.spendUsd)}</b></div>
        <div><span>Budget remaining</span><b>{money(report.accounts.openai.remainingBudgetUsd)}</b></div>
      </div>
      {!report.accounts.openai.connected && <p className="vs-usage-callout">OpenAI balance not connected: {report.accounts.openai.reason}</p>}
      <section><h3>Usage by person</h3><p className="vs-muted vs-muted-sm">Use this for coaching. A high total is not automatically waste; compare attempts with chosen outputs.</p>
        <div className="vs-usage-table"><table><thead><tr><th>Person</th><th>Operations</th><th>Images</th><th>Strategy stages</th><th>Chosen</th><th>Selection</th><th>Magnific</th><th>BB questions</th><th>Mani questions</th><th>Failures</th></tr></thead><tbody>
          {report.users.map((r) => <tr key={r.key}><td>{r.name}{!r.verified && <small>identity not verified</small>}</td><td>{r.requests}</td><td>{r.outputs}</td><td>{r.strategyRuns}</td><td>{r.picks}</td><td>{r.outputs ? `${Math.round((r.picks / r.outputs) * 100)}%` : "—"}</td><td>{r.enhancements}</td><td>{r.bbQuestions}</td><td>{r.maniQuestions}</td><td>{r.failures}</td></tr>)}
          {!report.users.length && <tr><td colSpan={10}>No attributed usage recorded for this month.</td></tr>}
        </tbody></table></div>
      </section>
      <section><h3>Provider accounts</h3><div className="vs-provider-account"><strong>OpenAI</strong><span>{report.accounts.openai.connected ? `${money(report.accounts.openai.spendUsd)} spent · ${report.accounts.openai.imageCount || 0} provider-reported images` : "Usage key required"}</span></div><div className="vs-provider-account"><strong>Magnific</strong><span>{report.accounts.magnific.analyticsConnected ? `${report.accounts.magnific.creditsUsed || 0} credits used · ${report.accounts.magnific.remainingCredits == null ? "monthly allowance not set" : `${report.accounts.magnific.remainingCredits} remaining`}` : `${report.accounts.magnific.operations} Hub operations · ${report.accounts.magnific.reason || "team analytics unavailable"}`}</span></div><p className="vs-muted vs-muted-sm">{report.accounts.magnific.note}</p></section>
      <p className="vs-usage-foot">{report.coverage}{lastUpdated ? ` Auto-refreshes every minute · Last updated ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : ""}</p>
    </>}
  </div>;
}
