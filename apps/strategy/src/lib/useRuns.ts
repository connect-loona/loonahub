import { useEffect, useState } from "react";
import { listenPath } from "./firebase";
import type { BrandDraftRecord, BrandLibraryStatus, StrategyBrand, StrategyRun } from "./types";

// React equivalents of strategy-app.js's soListenRuns()/soListenBrands() — a live
// Firebase Realtime Database listener kept as component state, instead of the legacy
// window._soRunsCache/window._soBrandsCache globals (see docs/strategy-os-touchpoints.md).

export function useRuns(): { runs: StrategyRun[]; loading: boolean } {
  const [runs, setRuns] = useState<StrategyRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return listenPath<Record<string, StrategyRun>>("strategy_runs", (val) => {
      const list = Object.values(val || {}).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      setRuns(list);
      setLoading(false);
    });
  }, []);

  return { runs, loading };
}

// React equivalent of strategy-app.js's soOpenRun() — a live listener on one run's own
// path, used by the run detail view.
export function useRun(runId: string): { run: StrategyRun | null; loading: boolean } {
  const [run, setRun] = useState<StrategyRun | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    return listenPath<StrategyRun>(`strategy_runs/${runId}`, (val) => {
      setRun(val);
      setLoading(false);
    });
  }, [runId]);

  return { run, loading };
}

export function useBrands(): { brands: StrategyBrand[]; loading: boolean } {
  const [brands, setBrands] = useState<StrategyBrand[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return listenPath<Record<string, StrategyBrand>>("strategy_brands", (val) => {
      setBrands(Object.values(val || {}));
      setLoading(false);
    });
  }, []);

  return { brands, loading };
}

function slug(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// One entry per active Hub brand — Hub's own `brands` node (added to/removed from as
// clients come and go, not this app's own config store) is the source of truth for "which
// brands does Loona manage," so every one of them shows up here, whether or not it's been
// onboarded into Strategy OS yet. `configured` says which: only a brand with a real
// strategy_brands entry (truth, voice, pillars, claim rules — built via Manage Brands'
// "Draft from Drive" flow) can actually have a run started for it, since a run against
// Hub's bare name-and-lead record alone would fail at the very first stage. See
// NewRunWizard.tsx for how the two states render differently.
export interface HubBrandOption {
  id: string; // the real strategy_brands id once configured; a slug of the Hub name until then
  name: string;
  configured: boolean;
  deliverables?: unknown; // only meaningful once configured — see DeliverablesFields
}

export function useAllHubBrands(): { brands: HubBrandOption[]; loading: boolean } {
  const [hubBrands, setHubBrands] = useState<Record<string, { brand?: string; inactive?: boolean }> | null>(null);
  const [configured, setConfigured] = useState<Record<string, StrategyBrand> | null>(null);

  useEffect(() => listenPath<Record<string, { brand?: string; inactive?: boolean }>>("brands", setHubBrands), []);
  useEffect(() => listenPath<Record<string, StrategyBrand>>("strategy_brands", setConfigured), []);

  const loading = hubBrands === null || configured === null;
  if (loading) return { brands: [], loading: true };

  const configuredBySlug = new Map<string, StrategyBrand>();
  for (const brand of Object.values(configured || {})) {
    if (!brand || !brand.id) continue;
    configuredBySlug.set(slug(brand.id), brand);
    if (brand.name) configuredBySlug.set(slug(brand.name), brand);
  }

  const seen = new Set<string>();
  const merged: HubBrandOption[] = [];
  for (const record of Object.values(hubBrands || {})) {
    if (!record || !record.brand || record.inactive) continue;
    const brandSlug = slug(record.brand);
    if (!brandSlug || seen.has(brandSlug)) continue; // dedupe; Hub can carry stray duplicate rows
    seen.add(brandSlug);
    const match = configuredBySlug.get(brandSlug);
    merged.push(
      match
        ? { id: match.id, name: match.name || record.brand, configured: true, deliverables: match.deliverables }
        : { id: brandSlug, name: record.brand, configured: false },
    );
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return { brands: merged, loading: false };
}

// Live status of a brand's Drive folder read — see BrandLibraryStatus's own comment
// (types.ts) and BrandMemory.tsx, which is what actually shows this to a reviewer instead
// of leaving "is it reading our brand folder?" as a question only Netlify's function logs
// or the Firebase console could answer.
export function useBrandLibrary(brandId: string | undefined): { library: BrandLibraryStatus | null; loading: boolean } {
  const [library, setLibrary] = useState<BrandLibraryStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!brandId) { setLibrary(null); setLoading(false); return; }
    setLoading(true);
    return listenPath<BrandLibraryStatus>(`strategy_brand_library/${brandId}`, (val) => {
      setLibrary(val);
      setLoading(false);
    });
  }, [brandId]);

  return { library, loading };
}

// Watches one brand's Drive draft as it's prepared (see strategy-brand-draft.js). The
// drafting itself runs in a background function, so the app follows it the same way it
// follows a run: a live listener on the record, not a polled request.
export function useBrandDraft(brandId: string | undefined): BrandDraftRecord | null {
  const [draft, setDraft] = useState<BrandDraftRecord | null>(null);

  useEffect(() => {
    if (!brandId) { setDraft(null); return; }
    return listenPath<BrandDraftRecord>(`strategy_brand_drafts/${brandId}`, (val) => setDraft(val));
  }, [brandId]);

  return draft;
}
