// A generic, extensible deliverables editor: one row per deliverable type (a dropdown to
// pick the type, a number box for the count), with a "+ Add deliverable" button to add more
// rows and a remove button on each. Used by both BrandForm.tsx (a brand's own stored
// config) and NewRunWizard.tsx (a per-run override) — see DeliverablesCount in lib/types.ts
// and contracts.js's BrandConfigSchema.deliverables for why this is an open map rather than
// a fixed reel/carousel/static shape: reel/carousel/static/story are what the pipeline can
// actually generate today, but anything else named here (a custom label picked via
// "Other…", or a brand config saved with a name this list doesn't know about) is still
// recorded as a plain count.
import { useState } from "react";
import type { DeliverablesCount } from "../lib/types";

const PRESET_TYPES: { slug: string; label: string }[] = [
  { slug: "reel", label: "Reels" },
  { slug: "carousel", label: "Carousels" },
  { slug: "static", label: "Static" },
  { slug: "story", label: "Story" },
  { slug: "blog", label: "Blog" },
  { slug: "whatsapp", label: "WhatsApp message" },
];
const CUSTOM = "__custom__";

function labelFor(slug: string): string {
  return PRESET_TYPES.find((p) => p.slug === slug)?.label || slug;
}

function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

export interface Row {
  key: number; // stable React key, independent of the (possibly still-being-typed) slug
  slug: string; // a PRESET_TYPES slug, a custom slug already committed, or CUSTOM while mid-edit
  customLabel: string; // only used while slug === CUSTOM
  count: number;
}

let nextKey = 1;

// Exported (not just wrapped in the hook below) so a caller can reseed rows on demand —
// e.g. NewRunWizard.tsx recomputes rows from whichever brand was just selected, which a
// useState initializer (run once, at mount) can't do on its own.
export function rowsFromDeliverables(deliverables: DeliverablesCount | undefined): Row[] {
  const entries = Object.entries(deliverables || {}).filter(([k, v]) => k !== "confirmed" && typeof v === "number");
  if (entries.length === 0) {
    return [
      { key: nextKey++, slug: "reel", customLabel: "", count: 6 },
      { key: nextKey++, slug: "carousel", customLabel: "", count: 4 },
      { key: nextKey++, slug: "static", customLabel: "", count: 3 },
    ];
  }
  return entries.map(([slug, count]) => {
    const isPreset = PRESET_TYPES.some((p) => p.slug === slug);
    // An unknown stored key (not one of PRESET_TYPES) has no matching <option> to select —
    // represent it as the CUSTOM row with its name carried in customLabel instead, so the
    // dropdown shows "Other…" selected and the text input shows the actual name.
    return { key: nextKey++, slug: isPreset ? slug : CUSTOM, customLabel: isPreset ? "" : slug, count };
  });
}

export function deliverablesToMap(rows: Row[]): DeliverablesCount {
  const map: DeliverablesCount = {};
  for (const row of rows) {
    const key = row.slug === CUSTOM ? slugify(row.customLabel) : row.slug;
    if (!key) continue;
    map[key] = row.count;
  }
  return map;
}

export function useDeliverablesRows(initial: DeliverablesCount | undefined) {
  return useState<Row[]>(() => rowsFromDeliverables(initial));
}

export function DeliverablesFields({ rows, onChange }: { rows: Row[]; onChange: (rows: Row[]) => void }) {
  function update(key: number, patch: Partial<Row>) {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function remove(key: number) {
    onChange(rows.filter((r) => r.key !== key));
  }
  function add() {
    const used = new Set(rows.map((r) => r.slug));
    const nextPreset = PRESET_TYPES.find((p) => !used.has(p.slug));
    onChange([...rows, { key: nextKey++, slug: nextPreset ? nextPreset.slug : CUSTOM, customLabel: "", count: 0 }]);
  }

  return (
    <div>
      {rows.map((row) => {
        const usedElsewhere = new Set(rows.filter((r) => r.key !== row.key).map((r) => r.slug));
        return (
          <div key={row.key} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 2 }}>
              {row.key === rows[0].key && <label className="st-field-label">Type</label>}
              <select
                className="st-form-control"
                aria-label="Deliverable type"
                value={row.slug}
                onChange={(e) => update(row.key, { slug: e.target.value, customLabel: e.target.value === CUSTOM ? row.customLabel : "" })}
              >
                {PRESET_TYPES.filter((p) => p.slug === row.slug || !usedElsewhere.has(p.slug)).map((p) => (
                  <option key={p.slug} value={p.slug}>{p.label}</option>
                ))}
                <option value={CUSTOM}>Other…</option>
              </select>
              {row.slug === CUSTOM && (
                <input
                  className="st-form-control"
                  aria-label="Custom deliverable name"
                  style={{ marginTop: 6 }}
                  placeholder="Name this deliverable"
                  value={row.customLabel}
                  onChange={(e) => update(row.key, { customLabel: e.target.value })}
                />
              )}
            </div>
            <div style={{ flex: 1 }}>
              {row.key === rows[0].key && <label className="st-field-label">Count</label>}
              <input
                className="st-form-control"
                aria-label={`Count — ${row.slug === CUSTOM ? row.customLabel || "custom" : labelFor(row.slug)}`}
                type="number"
                min={0}
                value={row.count}
                onChange={(e) => update(row.key, { count: parseInt(e.target.value, 10) || 0 })}
              />
            </div>
            <button className="st-btn st-btn-ghost st-btn-sm" disabled={rows.length <= 1} onClick={() => remove(row.key)}>&#10005;</button>
          </div>
        );
      })}
      <button className="st-btn st-btn-ghost st-btn-sm" disabled={rows.length >= PRESET_TYPES.length + 1} onClick={add}>+ Add deliverable</button>
    </div>
  );
}
