import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "./firebase";

type Status = "checking" | "authenticated" | "signed-out";

export default function App() {
  const [status, setStatus] = useState<Status>("checking");
  const [user, setUser] = useState<User | null>(null);
  const [idTokenPreview, setIdTokenPreview] = useState<string | null>(null);
  const [idTokenError, setIdTokenError] = useState<string | null>(null);

  useEffect(() => {
    // This is the actual spike: does a session the legacy compat SDK already established
    // (by logging into Hub normally, at this exact origin) show up here, in a completely
    // separate app using the modular SDK with no shared code and no legacy globals read?
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setStatus(nextUser ? "authenticated" : "signed-out");
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) { setIdTokenPreview(null); setIdTokenError(null); return; }
    user.getIdToken().then(
      (token) => setIdTokenPreview(token.slice(0, 24) + "…"),
      (err) => setIdTokenError(String(err)),
    );
  }, [user]);

  const bg = status === "authenticated" ? "#1a4d2e" : status === "signed-out" ? "#5c1a1a" : "#333";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: bg, color: "#fff", padding: 32 }}>
      <h1 style={{ marginTop: 0 }}>Strategy OS — auth spike</h1>
      <p style={{ opacity: 0.8 }}>
        This page is not the real Strategy OS. It exists only to answer one question: does a
        session already established by logging into Hub (the legacy compat SDK) show up here,
        in a brand-new app using the modular Firebase SDK, on this same origin?
      </p>

      {status === "checking" && <p>Checking auth state…</p>}

      {status === "signed-out" && (
        <div>
          <p style={{ fontSize: 20, fontWeight: 700 }}>❌ No user detected.</p>
          <p>
            If you're already logged into Hub at this same URL's origin and still see this,
            the spike has failed — the session isn't shared across SDKs/versions as hoped.
          </p>
        </div>
      )}

      {status === "authenticated" && user && (
        <div>
          <p style={{ fontSize: 20, fontWeight: 700 }}>✅ User detected.</p>
          <dl>
            <dt style={{ opacity: 0.7 }}>uid</dt>
            <dd>{user.uid}</dd>
            <dt style={{ opacity: 0.7 }}>email</dt>
            <dd>{user.email ?? "(none)"}</dd>
            <dt style={{ opacity: 0.7 }}>displayName</dt>
            <dd>{user.displayName ?? "(none)"}</dd>
            <dt style={{ opacity: 0.7 }}>ID token</dt>
            <dd>
              {idTokenPreview && <span>{idTokenPreview} (fetched successfully)</span>}
              {idTokenError && <span style={{ color: "#ffb3b3" }}>Failed: {idTokenError}</span>}
              {!idTokenPreview && !idTokenError && <span>fetching…</span>}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}
