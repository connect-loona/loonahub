import { useState } from "react";
import { BrandForm } from "./BrandForm";
import { useBrandDraft, useBrands } from "../lib/useRuns";
import { draftBrandFromManiMemory } from "../lib/api";
import type { StrategyBrand } from "../lib/types";

// Brand Directory is intentionally entered from a selected brand workspace. Existing
// Strategy brands open for editing; a Hub-only brand opens a prefilled new configuration.
// The complete brand form remains the single place that writes a configuration.
export function BrandDirectory({ brandId, brandName, onClose }: { brandId: string; brandName: string; onClose: () => void }) {
  const { brands, loading } = useBrands();
  const [showDirectory, setShowDirectory] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const existing = brands.find((brand) => brand.id === brandId);
  const memoryDraft = useBrandDraft(brandId);
  const fromMemory = memoryDraft?.status === "ready" && memoryDraft.draft ? memoryDraft.draft as Record<string, unknown> : null;
  // A Mani draft fills the form even when a brand already has a directory. It is a
  // reviewable overlay only: nothing is persisted until the team presses Save.
  const seed = { ...(existing || {}), ...(fromMemory || {}), id: existing?.id || brandId, name: existing?.name || brandName } as StrategyBrand;
  async function draftFromMemory() {
    setDrafting(true); setDraftError(null);
    try { await draftBrandFromManiMemory({ brandId, name: brandName, actor: "Hub team" }); }
    catch (error) { setDraftError(error instanceof Error ? error.message : String(error)); setDrafting(false); }
  }

  if (loading) return <div className="vs-shell sc-shell sc-full-shell"><main className="vs-main sc-loading">Opening Brand Directory…</main></div>;

  if (showDirectory) return <div className="vs-shell sc-shell sc-full-shell"><main className="vs-main sc-directory">
    <header className="vs-header"><div><h1>Brand Directory</h1><p>Choose a brand to review its Strategy OS configuration.</p></div><button type="button" className="vs-header-tool" onClick={onClose}>Close</button></header>
    <section className="vs-thread">
      <div className="st-board"><div className="st-board-header">Configured brands</div>
        {brands.length ? brands.slice().sort((a, b) => a.name.localeCompare(b.name)).map((brand) => <button key={brand.id} type="button" className="sc-directory-brand" onClick={() => window.location.assign(`/strategy/?directory=1&brandId=${encodeURIComponent(brand.id)}&brandName=${encodeURIComponent(brand.name)}`)}><b>{brand.name}</b><span>{String(brand.category || brand.id)}</span></button>) : <p>No brands configured yet.</p>}
      </div>
    </section>
  </main></div>;

  return <div className="vs-shell sc-shell sc-full-shell"><main className="vs-main sc-directory">
    <header className="vs-header"><div><h1>Brand Directory</h1><p>{existing ? `Review ${brandName}'s configuration.` : `Set up ${brandName} so planning and brand memory can begin.`}</p></div><button type="button" className="vs-header-tool" disabled={drafting} onClick={() => void draftFromMemory()}>{drafting ? "Starting draft…" : memoryDraft?.status === "drafting" ? "Restart draft" : fromMemory ? "Refresh from Mani" : "Draft from Mani"}</button><button type="button" className="vs-header-tool" onClick={() => setShowDirectory(true)}>All brands</button><button type="button" className="vs-header-tool" onClick={onClose}>Close</button></header>
    <section className="vs-thread"><p className="sc-directory-note">Pasted Mani memory automatically starts a draft. Review and edit every generated field, then save it when it is correct.</p>{memoryDraft?.status === "drafting" && <p className="sc-directory-note">Mani is reading the latest pasted memory and updating this form…</p>}{memoryDraft?.status === "ready" && <p className="sc-directory-note">Mani’s latest draft is loaded below. Review it, then save the configuration.</p>}{memoryDraft?.status === "failed" && <p className="sc-error">{memoryDraft.error || "Mani could not draft this configuration."}</p>}{draftError && <p className="sc-error">{draftError}</p>}<BrandForm key={`${existing?.id || `new-${brandId}`}-${memoryDraft?.status === "ready" ? "ready" : "blank"}`} brandId={existing?.id || "__new__"} initialBrand={seed} onCancel={onClose} onSaved={onClose} /></section>
  </main></div>;
}
