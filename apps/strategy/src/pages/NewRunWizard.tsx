// The "start a new strategy run" intake flow, replacing the old single-screen
// NewRunModal. Three screens:
//   1. "intake" — headline, brand + run-type + month, all picked together up front.
//   2. "monthly-details" (runType: monthly) — the brand's agreed deliverables, shown
//      editable (a per-run-only override — see DeliverablesCount in lib/types.ts and
//      strategy-run-start.js), plus a free-text box for this month's priorities.
//   3. "campaign-details" (runType: campaign) — campaign details free-text, plus the same
//      deliverables picker. Submits through the exact same pipeline as monthly, just
//      tagged runType: "campaign" (a campaign-specific pipeline is separate, later work).
//
// Both detail screens' free-text box is sent as sourceContext — the field pipeline.js
// already threads into every stage's AI prompt, so "this month's priorities"/"campaign
// details" reach Research with no new backend plumbing.
import { useState } from "react";
import type { DeliverablesCount, StrategyBrand } from "../lib/types";
import { startRun } from "../lib/api";
import { DeliverablesFields, deliverablesToMap, rowsFromDeliverables, type Row } from "../components/DeliverablesFields";

type RunType = "monthly" | "campaign";
type Step = "intake" | "details";

function defaultMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function NewRunWizard({
  actor,
  brands,
  onCancel,
  onCreated,
}: {
  actor: string;
  brands: StrategyBrand[];
  onCancel: () => void;
  onCreated: (runId: string) => void;
}) {
  const [step, setStep] = useState<Step>("intake");
  const [brandId, setBrandId] = useState(brands[0]?.id || "");
  const [runType, setRunType] = useState<RunType>("monthly");
  const [month, setMonth] = useState(defaultMonth());

  const [deliverableRows, setDeliverableRows] = useState<Row[]>(() => rowsFromDeliverables(brands[0]?.deliverables as DeliverablesCount | undefined));
  const [notes, setNotes] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedBrand = brands.find((b) => b.id === brandId);

  function handleContinue() {
    if (!brandId) { setError("Pick a brand."); return; }
    if (!month) { setError("Pick a month."); return; }
    setError(null);
    // Re-seed the deliverables editor from the brand's stored config every time this
    // screen is reached — matches "show the current deliverables that we set as
    // default" from a fresh pick, rather than carrying over a stale edit from a
    // previously-selected brand.
    setDeliverableRows(rowsFromDeliverables(selectedBrand?.deliverables as DeliverablesCount | undefined));
    setStep("details");
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const { runId } = await startRun({
        brandId,
        month,
        actor,
        runType,
        deliverablesOverride: deliverablesToMap(deliverableRows),
        sourceContext: notes.trim() ? [notes.trim()] : [],
      });
      onCreated(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "intake") {
    return (
      <div>
        <div className="st-section-header" style={{ marginTop: 0 }}>
          <div className="st-section-title">Are you ready to build the strategy in Loona way?</div>
        </div>

        <div className="st-board" style={{ marginTop: 0 }}>
          {brands.length === 0 ? (
            <div className="st-note">No brands configured yet — add one from Manage brands first.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                  <label className="st-field-label">Brand</label>
                  <select className="st-form-control" aria-label="Brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label className="st-field-label">Type</label>
                  <select className="st-form-control" aria-label="Type" value={runType} onChange={(e) => setRunType(e.target.value as RunType)}>
                    <option value="monthly">Monthly strategy</option>
                    <option value="campaign">Campaign</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label className="st-field-label">Month</label>
                  <input className="st-form-control" aria-label="Month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
                </div>
              </div>

              {error && <div className="st-error-text">{error}</div>}

              <div style={{ display: "flex", gap: 8 }}>
                <button className="st-btn st-btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
                <button className="st-btn st-btn-primary" style={{ flex: 1 }} onClick={handleContinue}>Continue</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // step === "details"
  const isCampaign = runType === "campaign";
  return (
    <div>
      <div className="st-section-header" style={{ marginTop: 0 }}>
        <div>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ marginBottom: 8 }} onClick={() => setStep("intake")}>&larr; Back</button>
          <div className="st-section-title">
            {isCampaign ? `Campaign details — ${selectedBrand?.name || brandId}` : `Agreed deliverables for the monthly plan — ${selectedBrand?.name || brandId}`}
          </div>
        </div>
      </div>

      <div className="st-board" style={{ marginTop: 0 }}>
        {isCampaign ? (
          <>
            <label className="st-field-label">Explain the details of this campaign</label>
            <textarea
              className="st-form-control"
              aria-label="Notes"
              style={{ minHeight: 100, marginBottom: 16 }}
              placeholder="What's this campaign for, and what matters most?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <label className="st-field-label">Deliverables for this campaign</label>
            <DeliverablesFields rows={deliverableRows} onChange={setDeliverableRows} />
          </>
        ) : (
          <>
            <div className="st-note" style={{ marginBottom: 10 }}>
              Below are the agreed deliverables for the monthly plan — the default is this brand's own configured
              count, but you can edit it for this run only; it won't change the brand's saved settings.
            </div>
            <DeliverablesFields rows={deliverableRows} onChange={setDeliverableRows} />
            <label className="st-field-label">Explain your details and priorities for this month's plan</label>
            <textarea
              className="st-form-control"
              aria-label="Notes"
              style={{ minHeight: 100 }}
              placeholder="Anything Research should know before it starts…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </>
        )}

        {error && <div className="st-error-text" style={{ marginTop: 16 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="st-btn st-btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
          <button className="st-btn st-btn-primary" style={{ flex: 1 }} disabled={submitting} onClick={handleSubmit}>
            {submitting ? "Starting…" : "Submit & start research"}
          </button>
        </div>
      </div>
    </div>
  );
}
