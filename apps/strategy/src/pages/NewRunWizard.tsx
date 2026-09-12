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
type Provider = "openai" | "claude";

// Which model writes each stage. The picked one goes FIRST — if it's unreachable (no
// credits, outage, key not configured) the run falls over to the other one rather than
// failing, so this is a preference, not a hard binding. See runtime-failover.js.
const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "ChatGPT",
  claude: "Claude",
};

// Same five stages strategy-run-start.js accepts in its `runtimes` map, with the names the
// rail already shows people.
const STAGES: { key: string; label: string }[] = [
  { key: "research", label: "Research" },
  { key: "strategy", label: "Strategy" },
  { key: "copy", label: "Copy" },
  { key: "creative-direction", label: "Creative direction" },
  { key: "deck-builder", label: "Deck" },
];

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

  // Model preferences. `runtime` is the whole run's default; `stageRuntimes` overrides it
  // for individual stages ("" = follow the run default). Both are optional — leaving the
  // Advanced block untouched sends exactly what the wizard sent before this existed.
  const [runtime, setRuntime] = useState<Provider>("openai");
  const [stageRuntimes, setStageRuntimes] = useState<Record<string, Provider | "">>({});

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
    // A campaign has no brief the way a monthly plan does (that comes from the brand's own
    // month calendar/deliverables) — the details box IS the only place its objective (a
    // festival, a launch, an event) gets written down anywhere. Leave it blank and the run
    // still starts, just with nothing for Research to actually build the campaign around —
    // a real person hit exactly this by forgetting to fill it in before submitting. The
    // monthly path doesn't need this: its notes box is optional context on top of an
    // otherwise well-defined monthly brief, not the run's only stated purpose.
    if (isCampaign && !notes.trim()) {
      setError("Explain what this campaign is for before starting it — that's the only place its objective (a festival, a launch, an event) gets recorded for Research to build on.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Only send stages that were actually overridden — an empty map means "every stage
      // runs on the run default", which is what the server already assumes.
      const runtimes: Record<string, Provider> = {};
      for (const { key } of STAGES) {
        const choice = stageRuntimes[key];
        if (choice) runtimes[key] = choice;
      }
      const { runId } = await startRun({
        brandId,
        month,
        actor,
        runType,
        runtime,
        runtimes: Object.keys(runtimes).length ? runtimes : undefined,
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
            <label className="st-field-label">Explain the details of this campaign (required)</label>
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

        <details className="st-advanced" style={{ marginTop: 16 }}>
          <summary className="st-field-label" style={{ cursor: "pointer" }}>Advanced — which model writes this run</summary>
          <div style={{ marginTop: 10 }}>
            <div className="st-note" style={{ marginBottom: 10 }}>
              Whichever model you pick goes first. If it's out of credits or unreachable, the run automatically
              falls over to the other one instead of failing.
            </div>
            <label className="st-field-label">Default model</label>
            <select
              className="st-form-control"
              aria-label="Default model"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value as Provider)}
            >
              {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>

            <div className="st-field-label" style={{ marginTop: 12 }}>Per stage</div>
            {STAGES.map((stage) => (
              <div key={stage.key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div style={{ flex: 1 }}>{stage.label}</div>
                <select
                  className="st-form-control"
                  style={{ flex: 1, marginBottom: 0 }}
                  aria-label={`${stage.label} model`}
                  value={stageRuntimes[stage.key] || ""}
                  onChange={(e) => setStageRuntimes({ ...stageRuntimes, [stage.key]: e.target.value as Provider | "" })}
                >
                  <option value="">Same as default ({PROVIDER_LABELS[runtime]})</option>
                  {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                    <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </details>

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
