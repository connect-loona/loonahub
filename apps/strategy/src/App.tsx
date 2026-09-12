import { useEffect, useState } from "react";
import { onAuthChange, type CurrentUser } from "./lib/firebase";
import { useBrands } from "./lib/useRuns";
import type { StrategyBrand } from "./lib/types";
import { RunList } from "./pages/RunList";
import { RunDetail } from "./pages/RunDetail";
import { BrandList } from "./pages/BrandList";
import { BrandForm } from "./pages/BrandForm";
import { NewRunWizard } from "./pages/NewRunWizard";
import "./styles/components.css";

type AuthStatus = "checking" | "authenticated" | "signed-out";

// Mirrors strategy-app.js's own view state (_soOpenRunId / _soBrandView) — one screen
// visible at a time, no routing library (matching the working-instructions doc's "no
// Next.js" boundary rule).
type View =
  | { kind: "runs" }
  | { kind: "new-run" }
  | { kind: "run"; runId: string }
  | { kind: "brands" }
  // `seed` carries a Drive-drafted config into the form for a NEW brand. BrandForm reads
  // its initialBrand once at mount by design, so the seed has to arrive with the view
  // change rather than turning up afterwards.
  | { kind: "brand-form"; brandId: string; seed?: StrategyBrand };

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [view, setView] = useState<View>({ kind: "runs" });
  const { brands } = useBrands();

  useEffect(() => {
    // Confirmed live on a real deploy (the Step 1 auth spike): a session the legacy
    // compat SDK already established shows up here with zero shared code.
    return onAuthChange((nextUser) => {
      setUser(nextUser);
      setAuthStatus(nextUser ? "authenticated" : "signed-out");
    });
  }, []);

  if (authStatus === "checking") {
    return <div className="st-app"><div className="st-app-body st-note">Checking your Hub session…</div></div>;
  }

  if (authStatus === "signed-out") {
    return (
      <div className="st-app">
        <div className="st-app-body">
          <h1 className="st-section-title">Strategy OS</h1>
          <p className="st-note">
            You're not signed into Hub on this device/browser yet. Log into Hub at the root of
            this site first, then come back to this page.
          </p>
          <a href="/" style={{ color: "var(--accent)" }}>Go to Hub</a>
        </div>
      </div>
    );
  }

  const actor = (user?.displayName || user?.email?.split("@")[0] || "Unknown") as string;

  let body;
  if (view.kind === "run") {
    body = <RunDetail runId={view.runId} actor={actor} onBack={() => setView({ kind: "runs" })} />;
  } else if (view.kind === "new-run") {
    body = (
      <NewRunWizard
        actor={actor}
        brands={brands}
        onCancel={() => setView({ kind: "runs" })}
        onCreated={(runId) => setView({ kind: "run", runId })}
      />
    );
  } else if (view.kind === "brands") {
    body = (
      <BrandList
        onBack={() => setView({ kind: "runs" })}
        onEditBrand={(brandId) => setView({ kind: "brand-form", brandId })}
        onAddBrand={() => setView({ kind: "brand-form", brandId: "__new__" })}
        onUseDraft={(brandId, seed) => setView({ kind: "brand-form", brandId, seed })}
      />
    );
  } else if (view.kind === "brand-form") {
    body = (
      <BrandForm
        brandId={view.brandId}
        // A Drive draft wins when one was carried in; otherwise this is an ordinary edit of
        // an existing brand.
        initialBrand={view.seed || brands.find((b) => b.id === view.brandId)}
        onCancel={() => setView({ kind: "brands" })}
        onSaved={() => setView({ kind: "brands" })}
      />
    );
  } else {
    body = (
      <RunList
        actor={actor}
        onOpenRun={(runId) => setView({ kind: "run", runId })}
        onManageBrands={() => setView({ kind: "brands" })}
        onStartNewRun={() => setView({ kind: "new-run" })}
      />
    );
  }

  return (
    <div className="st-app">
      <div className="st-app-bar">
        <a className="st-app-logo" href="/">LOONA</a>
        <a href="/">Overview</a>
        <a href="/">Task Board</a>
        <span className="st-app-nav-active">Strategy OS</span>
        <div className="st-app-spacer" />
        <a className="st-app-legacy" href="/?so=legacy" title="Open legacy Strategy OS tab in Hub">Legacy UI</a>
        <span className="st-app-actor" title={user?.email || ""}>{actor}</span>
      </div>
      <div className="st-app-body">{body}</div>
    </div>
  );
}
