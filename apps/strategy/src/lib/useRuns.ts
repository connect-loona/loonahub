import { useEffect, useState } from "react";
import { listenPath } from "./firebase";
import type { BrandLibraryStatus, StrategyBrand, StrategyRun } from "./types";

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
