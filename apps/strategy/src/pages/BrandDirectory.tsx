import { useState } from "react";
import { BrandForm } from "./BrandForm";
import { useBrands } from "../lib/useRuns";
import type { StrategyBrand } from "../lib/types";

// Brand Directory is intentionally entered from a selected brand workspace. Existing
// Strategy brands open for editing; a Hub-only brand opens a prefilled new configuration.
// The complete brand form remains the single place that writes a configuration.
export function BrandDirectory({ brandId, brandName, onClose }: { brandId: string; brandName: string; onClose: () => void }) {
  const { brands, loading } = useBrands();
  const [showDirectory, setShowDirectory] = useState(false);
  const existing = brands.find((brand) => brand.id === brandId);
  const seed = existing || ({ id: brandId, name: brandName } as StrategyBrand);

  if (loading) return <div className="vs-shell sc-shell"><main className="vs-main sc-loading">Opening Brand Directory…</main></div>;

  if (showDirectory) return <div className="vs-shell sc-shell"><main className="vs-main sc-directory">
    <header className="vs-header"><div><h1>Brand Directory</h1><p>Choose a brand to review its Strategy OS configuration.</p></div><button type="button" className="vs-header-tool" onClick={onClose}>Close</button></header>
    <section className="vs-thread">
      <div className="st-board"><div className="st-board-header">Configured brands</div>
        {brands.length ? brands.slice().sort((a, b) => a.name.localeCompare(b.name)).map((brand) => <button key={brand.id} type="button" className="sc-directory-brand" onClick={() => window.location.assign(`/strategy/?directory=1&brandId=${encodeURIComponent(brand.id)}&brandName=${encodeURIComponent(brand.name)}`)}><b>{brand.name}</b><span>{String(brand.category || brand.id)}</span></button>) : <p>No brands configured yet.</p>}
      </div>
    </section>
  </main></div>;

  return <div className="vs-shell sc-shell"><main className="vs-main sc-directory">
    <header className="vs-header"><div><h1>Brand Directory</h1><p>{existing ? `Review ${brandName}'s configuration.` : `Set up ${brandName} so planning and brand memory can begin.`}</p></div><button type="button" className="vs-header-tool" onClick={() => setShowDirectory(true)}>All brands</button><button type="button" className="vs-header-tool" onClick={onClose}>Close</button></header>
    <section className="vs-thread"><BrandForm key={existing?.id || `new-${brandId}`} brandId={existing?.id || "__new__"} initialBrand={seed} onCancel={onClose} onSaved={onClose} /></section>
  </main></div>;
}
