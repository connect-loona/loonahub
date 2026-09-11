// The Add/Edit brand form — ported field-for-field from strategy-app.js's
// soRenderBrandForm()/soSubmitBrandForm()/soDefaultBrandTemplate(). Loads the brand's
// existing config once at mount (matching the legacy app's one-time render — this never
// re-syncs from a live listener mid-edit, so someone else's concurrent edit can't blow
// away an in-progress form), and posts the same BrandConfigSchema-shaped object
// strategy-brand-save.js validates.
import { useState } from "react";
import type { DeliverablesCount, StrategyBrand } from "../lib/types";
import { saveBrand } from "../lib/api";
import { DeliverablesFields, deliverablesToMap, useDeliverablesRows } from "../components/DeliverablesFields";

interface AudienceRow { id: string; description: string; buyingSituation: string; trigger: string }
interface PillarRow { id: string; name: string; description: string; targetShare: number }

function csvLine(arr?: string[]): string { return (arr || []).join(", "); }
function linesText(arr?: string[]): string { return (arr || []).join("\n"); }
function splitCsv(s: string): string[] { return s.split(",").map((x) => x.trim()).filter(Boolean); }
function splitLines(s: string): string[] { return s.split("\n").map((x) => x.trim()).filter(Boolean); }

// Everything strategy-brand-save.js validates but this form doesn't expose its own
// fields for — round-tripped untouched through the Advanced JSON textarea, same as the
// legacy app (portfolios/claimRules/copyStructure/sourceVectorStoreIds).
interface AdvancedFields {
  portfolios?: unknown[];
  claimRules?: unknown[];
  copyStructure?: unknown;
  sourceVectorStoreIds?: string[];
}

export function BrandForm({ brandId, initialBrand, onCancel, onSaved }: {
  brandId: string; initialBrand: StrategyBrand | undefined; onCancel: () => void; onSaved: () => void;
}) {
  const isNew = brandId === "__new__";
  const b = initialBrand as (StrategyBrand & Record<string, any>) | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any

  const [id, setId] = useState(isNew ? "" : brandId);
  const [name, setName] = useState(b?.name || "");
  const [category, setCategory] = useState(b?.category || "");
  const [market, setMarket] = useState(csvLine(b?.market));
  const [aspirational, setAspirational] = useState(csvLine(b?.aspirationalMarkets));
  const [website, setWebsite] = useState(b?.website || "");
  const [drive, setDrive] = useState(b?.driveFolderUrl || "");
  const [truth, setTruth] = useState(b?.oneLineTruth || "");

  const [deliverableRows, setDeliverableRows] = useDeliverablesRows(b?.deliverables as DeliverablesCount | undefined);
  const [confirmed, setConfirmed] = useState(!!b?.deliverables?.confirmed);

  const [descriptors, setDescriptors] = useState(csvLine(b?.voice?.descriptors));
  const [principles, setPrinciples] = useState(linesText(b?.voice?.principles));
  const [bannedWords, setBannedWords] = useState(csvLine(b?.voice?.bannedWords));
  const [bannedMoves, setBannedMoves] = useState(linesText(b?.voice?.bannedMoves));
  const [emojiRule, setEmojiRule] = useState(b?.voice?.emojiRule || "");
  const [languageRule, setLanguageRule] = useState(b?.voice?.languageRule || "");

  const [audiences, setAudiences] = useState<AudienceRow[]>(
    b?.audiences?.length ? b.audiences : [{ id: "", description: "", buyingSituation: "", trigger: "" }],
  );

  const [feel, setFeel] = useState(csvLine(b?.visual?.feel));
  const [palette, setPalette] = useState(csvLine(b?.visual?.palette));
  const [visPrinciples, setVisPrinciples] = useState(linesText(b?.visual?.principles));
  const [visAvoid, setVisAvoid] = useState(linesText(b?.visual?.avoid));

  const [pillars, setPillars] = useState<PillarRow[]>(
    b?.pillars?.length ? b.pillars : [{ id: "", name: "", description: "", targetShare: 0.1 }],
  );

  const [competitors, setCompetitors] = useState(csvLine(b?.competitors));
  const [knownUnknowns, setKnownUnknowns] = useState(linesText(b?.knownUnknowns));

  const [advanced, setAdvanced] = useState(() => JSON.stringify(
    { portfolios: b?.portfolios || [], claimRules: b?.claimRules || [], copyStructure: b?.copyStructure ?? null, sourceVectorStoreIds: b?.sourceVectorStoreIds || [] },
    null, 2,
  ));

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function updateAudience(i: number, field: keyof AudienceRow, value: string) {
    setAudiences((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }
  function updatePillar(i: number, field: keyof PillarRow, value: string) {
    setPillars((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: field === "targetShare" ? parseFloat(value) || 0 : value } : r)));
  }

  async function handleSubmit() {
    setError(null);
    const trimmedId = id.trim();
    if (!/^[a-z0-9-]+$/.test(trimmedId)) {
      setError("Brand id must be lowercase letters, numbers or hyphens.");
      return;
    }

    let parsedAdvanced: AdvancedFields;
    try {
      parsedAdvanced = JSON.parse(advanced || "{}");
    } catch (e) {
      setError(`The Advanced JSON isn't valid: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const config = {
      schemaVersion: "1.0",
      id: trimmedId,
      name: name.trim(),
      category: category.trim(),
      market: splitCsv(market),
      aspirationalMarkets: splitCsv(aspirational),
      website: website.trim() || null,
      driveFolderUrl: drive.trim() || null,
      oneLineTruth: truth.trim(),
      deliverables: {
        ...deliverablesToMap(deliverableRows),
        confirmed,
      },
      voice: {
        descriptors: splitCsv(descriptors),
        principles: splitLines(principles),
        bannedWords: splitCsv(bannedWords),
        bannedMoves: splitLines(bannedMoves),
        emojiRule: emojiRule.trim(),
        languageRule: languageRule.trim(),
      },
      audiences: audiences.filter((a) => a.id.trim()).map((a) => ({ id: a.id.trim(), description: a.description.trim(), buyingSituation: a.buyingSituation.trim(), trigger: a.trigger.trim() })),
      visual: {
        feel: splitCsv(feel),
        palette: splitCsv(palette),
        principles: splitLines(visPrinciples),
        avoid: splitLines(visAvoid),
      },
      pillars: pillars.filter((p) => p.id.trim()).map((p) => ({ id: p.id.trim(), name: p.name.trim(), description: p.description.trim(), targetShare: p.targetShare })),
      competitors: splitCsv(competitors),
      knownUnknowns: splitLines(knownUnknowns),
      portfolios: parsedAdvanced.portfolios || [],
      claimRules: parsedAdvanced.claimRules || [],
      copyStructure: parsedAdvanced.copyStructure || null,
      sourceVectorStoreIds: parsedAdvanced.sourceVectorStoreIds || [],
    };

    setSaving(true);
    try {
      await saveBrand({ brandId: trimmedId, config });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="st-section-header" style={{ marginTop: 0 }}>
        <div>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ marginBottom: 8 }} onClick={onCancel}>&larr; Brands</button>
          <div className="st-section-title">{isNew ? "Add brand" : `Edit ${name || brandId}`}</div>
        </div>
      </div>

      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">Basics</div>
        <label className="st-field-label" style={{ marginTop: 6 }}>Brand id (slug — lowercase, hyphens, cannot be changed later)</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={id} placeholder="e.g. rro" disabled={!isNew} onChange={(e) => setId(e.target.value)} />
        <label className="st-field-label">Name</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="st-field-label">Category</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={category} onChange={(e) => setCategory(e.target.value)} />
        <label className="st-field-label">Market(s) — comma-separated</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={market} onChange={(e) => setMarket(e.target.value)} />
        <label className="st-field-label">Aspirational market(s) — comma-separated</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={aspirational} onChange={(e) => setAspirational(e.target.value)} />
        <label className="st-field-label">Website</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={website} onChange={(e) => setWebsite(e.target.value)} />
        <label className="st-field-label">Google Drive folder link</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={drive} placeholder="Not read by Research yet — see the integration notes" onChange={(e) => setDrive(e.target.value)} />
        <label className="st-field-label">One-line truth (what this brand actually is)</label>
        <textarea className="st-form-control" style={{ minHeight: 50 }} value={truth} onChange={(e) => setTruth(e.target.value)} />
      </div>

      <div className="st-board">
        <div className="st-board-header">Deliverables (per month)</div>
        <DeliverablesFields rows={deliverableRows} onChange={setDeliverableRows} />
        <div className="st-note" style={{ margin: "6px 0 10px" }}>
          Reels, Carousels, Static and Story are generated by the strategy pipeline. Any other deliverable you add here
          (Blog, WhatsApp message, or a custom one) is recorded for planning, but isn't generated yet.
        </div>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Deliverable counts confirmed with client
        </label>
      </div>

      <div className="st-board">
        <div className="st-board-header">Voice</div>
        <label className="st-field-label">Descriptors (comma-separated, at least 3 — e.g. warm, trustworthy, practical)</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={descriptors} onChange={(e) => setDescriptors(e.target.value)} />
        <label className="st-field-label">Principles (one per line)</label>
        <textarea className="st-form-control" style={{ minHeight: 60, marginBottom: 10 }} value={principles} onChange={(e) => setPrinciples(e.target.value)} />
        <label className="st-field-label">Banned words (comma-separated)</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={bannedWords} onChange={(e) => setBannedWords(e.target.value)} />
        <label className="st-field-label">Banned moves (one per line)</label>
        <textarea className="st-form-control" style={{ minHeight: 60, marginBottom: 10 }} value={bannedMoves} onChange={(e) => setBannedMoves(e.target.value)} />
        <label className="st-field-label">Emoji rule</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={emojiRule} onChange={(e) => setEmojiRule(e.target.value)} />
        <label className="st-field-label">Language rule</label>
        <input className="st-form-control" value={languageRule} onChange={(e) => setLanguageRule(e.target.value)} />
      </div>

      <div className="st-board">
        <div className="st-board-header">Audiences <span className="st-tag">at least 1</span></div>
        {audiences.map((a, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <input className="st-form-control" style={{ flex: 1 }} placeholder="id (e.g. household-cook)" value={a.id} onChange={(e) => updateAudience(i, "id", e.target.value)} />
              <button className="st-btn st-btn-ghost" onClick={() => setAudiences((rows) => rows.filter((_, idx) => idx !== i))}>&#10005;</button>
            </div>
            <textarea className="st-form-control" style={{ marginBottom: 6, minHeight: 40 }} placeholder="Description" value={a.description} onChange={(e) => updateAudience(i, "description", e.target.value)} />
            <textarea className="st-form-control" style={{ marginBottom: 6, minHeight: 40 }} placeholder="Buying situation" value={a.buyingSituation} onChange={(e) => updateAudience(i, "buyingSituation", e.target.value)} />
            <textarea className="st-form-control" style={{ minHeight: 40 }} placeholder="Trigger" value={a.trigger} onChange={(e) => updateAudience(i, "trigger", e.target.value)} />
          </div>
        ))}
        <button className="st-btn st-btn-ghost st-btn-sm" onClick={() => setAudiences((rows) => [...rows, { id: "", description: "", buyingSituation: "", trigger: "" }])}>+ Add audience</button>
      </div>

      <div className="st-board">
        <div className="st-board-header">Visual</div>
        <label className="st-field-label">Feel (comma-separated, at least 3)</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={feel} onChange={(e) => setFeel(e.target.value)} />
        <label className="st-field-label">Palette (comma-separated)</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={palette} onChange={(e) => setPalette(e.target.value)} />
        <label className="st-field-label">Principles (one per line, at least 1)</label>
        <textarea className="st-form-control" style={{ minHeight: 60, marginBottom: 10 }} value={visPrinciples} onChange={(e) => setVisPrinciples(e.target.value)} />
        <label className="st-field-label">Avoid (one per line, at least 1)</label>
        <textarea className="st-form-control" style={{ minHeight: 60 }} value={visAvoid} onChange={(e) => setVisAvoid(e.target.value)} />
      </div>

      <div className="st-board">
        <div className="st-board-header">Content pillars <span className="st-tag">at least 1</span></div>
        {pillars.map((p, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <input className="st-form-control" style={{ flex: 1 }} placeholder="id" value={p.id} onChange={(e) => updatePillar(i, "id", e.target.value)} />
              <input className="st-form-control" style={{ flex: 2 }} placeholder="Name" value={p.name} onChange={(e) => updatePillar(i, "name", e.target.value)} />
              <input className="st-form-control" style={{ width: 110 }} type="number" step="0.01" min={0} max={1} placeholder="Target share (0-1)" value={p.targetShare} onChange={(e) => updatePillar(i, "targetShare", e.target.value)} />
              <button className="st-btn st-btn-ghost" onClick={() => setPillars((rows) => rows.filter((_, idx) => idx !== i))}>&#10005;</button>
            </div>
            <textarea className="st-form-control" style={{ minHeight: 40 }} placeholder="Description" value={p.description} onChange={(e) => updatePillar(i, "description", e.target.value)} />
          </div>
        ))}
        <button className="st-btn st-btn-ghost st-btn-sm" onClick={() => setPillars((rows) => [...rows, { id: "", name: "", description: "", targetShare: 0.1 }])}>+ Add pillar</button>
      </div>

      <div className="st-board">
        <div className="st-board-header">Other</div>
        <label className="st-field-label">Competitors (comma-separated — research only, never named in copy)</label>
        <input className="st-form-control" style={{ marginBottom: 10 }} value={competitors} onChange={(e) => setCompetitors(e.target.value)} />
        <label className="st-field-label">Known unknowns (one per line)</label>
        <textarea className="st-form-control" style={{ minHeight: 60 }} value={knownUnknowns} onChange={(e) => setKnownUnknowns(e.target.value)} />
      </div>

      <details className="st-board">
        <summary className="st-board-header" style={{ cursor: "pointer", listStyle: "none", display: "block" }}>Advanced (portfolios, claim rules, copy structure) &#9662;</summary>
        <div className="st-note" style={{ margin: "8px 0" }}>Most brands don't need this — RRO is the one that does. Edit as JSON; it's validated the same as everything else on save.</div>
        <textarea className="st-form-control" style={{ minHeight: 220, fontFamily: "monospace", fontSize: 12 }} value={advanced} onChange={(e) => setAdvanced(e.target.value)} />
      </details>

      <div className="st-board">
        {error && <div className="st-error-text" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="st-btn st-btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
          <button className="st-btn st-btn-primary" style={{ flex: 1 }} disabled={saving} onClick={handleSubmit}>{saving ? "Saving…" : "Save brand"}</button>
        </div>
      </div>
    </div>
  );
}
