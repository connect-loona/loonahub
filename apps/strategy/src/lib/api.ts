// Calls the existing Netlify Functions backend — the "shared backend" layer the target
// architecture already has (see docs/strategy-os-touchpoints.md's endpoint list). Every
// call sends this app's own Firebase ID token as a bearer header, per the
// working-instructions doc's auth boundary rule ("obtains the current user's ID token for
// API requests") — the endpoints themselves still only verify the legacy loona_auth
// cookie today (which the browser attaches automatically on this same origin regardless,
// so calls succeed either way), but sending the token now means nothing here needs to
// change when server-side ID-token verification is added as its own follow-up.
import { getIdTokenOrNull } from "./firebase";

async function post(path: string, body: unknown): Promise<unknown> {
  const token = await getIdTokenOrNull();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/.netlify/functions/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string; reason?: string }).error || "Request failed.";
    const reason = (data as { error?: string; reason?: string }).reason;
    throw new Error(reason ? `${message} — ${reason}` : message);
  }
  return data;
}

export function startRun(args: { brandId: string; month: string; actor: string }): Promise<{ runId: string }> {
  return post("strategy-run-start", args) as Promise<{ runId: string }>;
}

export function archiveRun(args: { runId: string; actor: string; reason?: string }): Promise<{ ok: true }> {
  return post("strategy-run-archive", { ...args, action: "archive" }) as Promise<{ ok: true }>;
}

export function restoreRun(args: { runId: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-run-archive", { ...args, action: "restore" }) as Promise<{ ok: true }>;
}

export function purgeRun(args: { runId: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-run-archive", { ...args, action: "purge" }) as Promise<{ ok: true }>;
}
