import { useEffect, useState } from "react";
import { listenPath } from "./firebase";
import type { StrategyBrand, StrategyRun } from "./types";

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
