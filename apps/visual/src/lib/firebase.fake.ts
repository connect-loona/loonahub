// Test-mode-only fake for firebase.ts's three wrapper functions, backed by the same
// fake-rtdb-server.js every other test in this repo already uses (see tests/harness/).
// Only ever imported when import.meta.env.MODE === "test" — see firebase.ts.
import type { CurrentUser } from "./firebase";

const RTDB_URL = (import.meta.env.VITE_FAKE_RTDB_URL as string | undefined) || "http://127.0.0.1:9030";
const FAKE_USER_KEY = "__fakeAuthUser";

// Tests sign in by writing this key directly (page.evaluate) before the app mounts —
// e.g. localStorage.setItem("__fakeAuthUser", JSON.stringify({ uid, email, displayName })).
// Absent/invalid -> signed out, matching a real Firebase Auth "no session" state.
function readFakeUser(): CurrentUser | null {
  try {
    const raw = localStorage.getItem(FAKE_USER_KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  } catch {
    return null;
  }
}

export function onAuthChange(cb: (user: CurrentUser | null) => void): () => void {
  // Real onAuthStateChanged always fires at least once, asynchronously — matching that
  // shape (rather than calling back synchronously) catches components that assume it.
  const timer = setTimeout(() => cb(readFakeUser()), 0);
  return () => clearTimeout(timer);
}

export async function getIdTokenOrNull(): Promise<string | null> {
  const user = readFakeUser();
  return user ? `fake-id-token-${user.uid}` : null;
}

export function listenPath<T>(path: string, cb: (value: T | null) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const url = `${RTDB_URL}/${path.replace(/^\/+/, "")}.json`;

  async function poll() {
    if (stopped) return;
    try {
      const res = await fetch(url);
      const val = (await res.json()) as T | null;
      if (!stopped) cb(val ?? null);
    } catch {
      // Same as the legacy combinedInit's fake shim — a transient poll failure is silently
      // skipped, not surfaced, matching how a real Firebase listener would just retry.
    }
    if (!stopped) timer = setTimeout(poll, 200);
  }
  poll();

  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
