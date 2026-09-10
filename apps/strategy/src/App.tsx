import { useEffect, useState } from "react";
import { onAuthChange, type CurrentUser } from "./lib/firebase";
import { RunList } from "./pages/RunList";
import { RunDetail } from "./pages/RunDetail";
import "./styles/components.css";

type AuthStatus = "checking" | "authenticated" | "signed-out";

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  useEffect(() => {
    // Confirmed live on a real deploy (the Step 1 auth spike): a session the legacy
    // compat SDK already established shows up here with zero shared code.
    return onAuthChange((nextUser) => {
      setUser(nextUser);
      setAuthStatus(nextUser ? "authenticated" : "signed-out");
    });
  }, []);

  if (authStatus === "checking") {
    return <div style={{ padding: 32, color: "var(--muted)" }}>Checking your Hub session…</div>;
  }

  if (authStatus === "signed-out") {
    return (
      <div style={{ padding: 32, color: "var(--text)" }}>
        <h1>Strategy OS</h1>
        <p style={{ color: "var(--muted)" }}>
          You're not signed into Hub on this device/browser yet. Log into Hub at the root of
          this site first, then come back to this page.
        </p>
        <a href="/" style={{ color: "var(--accent)" }}>Go to Hub</a>
      </div>
    );
  }

  const actor = (user?.displayName || user?.email?.split("@")[0] || "Unknown") as string;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", padding: 32 }}>
      {openRunId ? (
        <RunDetail runId={openRunId} actor={actor} onBack={() => setOpenRunId(null)} />
      ) : (
        <RunList actor={actor} onOpenRun={setOpenRunId} />
      )}
    </div>
  );
}
