// The "Manage brands" list screen — ported from strategy-app.js's soRenderBrandList().
import { useBrands } from "../lib/useRuns";

export function BrandList({ onBack, onEditBrand, onAddBrand }: { onBack: () => void; onEditBrand: (brandId: string) => void; onAddBrand: () => void }) {
  const { brands, loading } = useBrands();
  const sorted = [...brands].sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return (
    <div>
      <div className="st-section-header" style={{ marginTop: 0 }}>
        <div>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ marginBottom: 8 }} onClick={onBack}>&larr; All runs</button>
          <div className="st-section-title">Manage brands</div>
        </div>
        <button className="st-btn st-btn-primary" onClick={onAddBrand}>+ Add brand</button>
      </div>

      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">Brands <span className="st-tag">{sorted.length}</span></div>
        {loading ? (
          <div className="st-note">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="st-note">No brands configured yet — add the first one.</div>
        ) : (
          sorted.map((b) => (
            <div key={b.id} className="pf-absrow" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
              <div>
                <b>{b.name}</b>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{(b.category as string) || "—"} &middot; {b.id}</div>
              </div>
              <button className="st-btn st-btn-ghost st-btn-sm" onClick={() => onEditBrand(b.id)}>Edit</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
