import { useState } from "react";
import type { StrategyBrand } from "../lib/types";

// Faithful port of strategy-app.js's #so-new-run-modal — same fields, same empty-state
// copy, same default month (next month). Brand-adding ("no brands yet -> add one") is
// deferred to the brand-management phase; this modal just tells you to add one first.
export function NewRunModal({
  brands,
  onCancel,
  onSubmit,
}: {
  brands: StrategyBrand[];
  onCancel: () => void;
  onSubmit: (brandId: string, month: string) => Promise<void>;
}) {
  const defaultMonth = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();

  const [brandId, setBrandId] = useState(brands[0]?.id || "");
  const [month, setMonth] = useState(defaultMonth);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!month) { setError("Pick a month."); return; }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(brandId, month);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="st-modal-backdrop" onClick={onCancel}>
      <div className="st-modal" onClick={(e) => e.stopPropagation()}>
        <div className="st-modal-title">New monthly strategy</div>

        {brands.length > 0 ? (
          <>
            <label className="st-field-label">Client</label>
            <select className="st-form-control" style={{ marginBottom: 12 }} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </>
        ) : (
          <div className="st-note" style={{ marginBottom: 12 }}>No brands configured yet — add one from Manage brands first.</div>
        )}

        <label className="st-field-label">Strategy month</label>
        <input className="st-form-control" style={{ marginBottom: 16 }} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />

        {error && <div className="st-error-text">{error}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button className="st-btn st-btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
          {brands.length > 0 && (
            <button className="st-btn st-btn-primary" style={{ flex: 1 }} disabled={submitting} onClick={handleSubmit}>
              {submitting ? "Starting…" : "Start research"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
