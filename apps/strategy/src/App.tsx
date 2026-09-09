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

  // Status accent — the one color that actually needs to vary by state. Everything else
  // below comes from design-tokens.css (the shared file index.html also links), proving
  // the wiring works rather than just declaring it.
  const accent = status === "authenticated" ? "var(--green)" : status === "signed-out" ? "var(--red)" : "var(--muted)";

  return (
    <div style={{ fontFamily: "var(--font)", minHeight: "100vh", background: "var(--bg)", color: "var(--text)", padding: "var(--space-2xl)" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", background: "var(--surface)", border: "1px solid var(--border)", borderLeft: `4px solid ${accent}`, borderRadius: "var(--radius-lg)", padding: "var(--space-2xl)" }}>
        <h1 style={{ marginTop: 0, fontSize: "var(--text-2xl)" }}>Strategy OS — auth spike</h1>
        <p style={{ color: "var(--muted)", fontSize: "var(--text-base)" }}>
          This page is not the real Strategy OS. It exists only to answer one question: does a
          session already established by logging into Hub (the legacy compat SDK) show up here,
          in a brand-new app using the modular Firebase SDK, on this same origin?
        </p>

        {status === "checking" && <p style={{ fontSize: "var(--text-md)" }}>Checking auth state…</p>}

        {status === "signed-out" && (
          <div>
            <p style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: accent }}>❌ No user detected.</p>
            <p style={{ fontSize: "var(--text-base)" }}>
              If you're already logged into Hub at this same URL's origin and still see this,
              the spike has failed — the session isn't shared across SDKs/versions as hoped.
            </p>
          </div>
        )}

        {status === "authenticated" && user && (
          <div>
            <p style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: accent }}>✅ User detected.</p>
            <dl style={{ fontSize: "var(--text-base)" }}>
              <dt style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>uid</dt>
              <dd>{user.uid}</dd>
              <dt style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>email</dt>
              <dd>{user.email ?? "(none)"}</dd>
              <dt style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>displayName</dt>
              <dd>{user.displayName ?? "(none)"}</dd>
              <dt style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>ID token</dt>
              <dd>
                {idTokenPreview && <span>{idTokenPreview} (fetched successfully)</span>}
                {idTokenError && <span style={{ color: "var(--red)" }}>Failed: {idTokenError}</span>}
                {!idTokenPreview && !idTokenError && <span>fetching…</span>}
              </dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
