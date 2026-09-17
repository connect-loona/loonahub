import { useEffect, useState } from "react";
import { onAuthChange, type CurrentUser } from "./lib/firebase";
import { StrategyChatWorkspace } from "./components/StrategyChatWorkspace";
// Strategy OS deliberately reuses Visual Studio's shell primitives. Import the actual
// source of those primitives so the shared vs-* class names have their layout, spacing,
// navigation and mobile-drawer rules—not only Strategy's sc-* colour overrides.
import "../../visual/src/styles.css";
import "./styles/components.css";
import "./styles/strategy-chat.css";

type AuthStatus = "checking" | "authenticated" | "signed-out";

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    // Confirmed live on a real deploy (the Step 1 auth spike): a session the legacy
    // compat SDK already established shows up here with zero shared code.
    return onAuthChange((nextUser) => {
      setUser(nextUser);
      setAuthStatus(nextUser ? "authenticated" : "signed-out");
    });
  }, []);

  if (authStatus === "checking") return <div className="vs-shell sc-shell"><main className="vs-main sc-loading">Checking your Hub session…</main></div>;
  if (authStatus === "signed-out") return <div className="vs-shell sc-shell"><main className="vs-main sc-signed-out"><h1>Strategy OS</h1><p>You’re not signed into Hub on this device yet.</p><a href="/">Go to Hub</a></main></div>;

  const actor = user?.displayName || user?.email?.split("@")[0] || "Hub";
  return <StrategyChatWorkspace actor={actor} />;
}
