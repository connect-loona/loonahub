// Calls the existing Netlify Functions backend — the "shared backend" layer the target
// architecture already has (see docs/strategy-os-touchpoints.md's endpoint list). Every
// call sends this app's own Firebase ID token as a bearer header, per the
// working-instructions doc's auth boundary rule. The backend verifies both this token and
// the Hub perimeter cookie, and resolves the acting team member from the verified token.
import { getIdTokenOrNull } from "./firebase";
import type { DeliverablesCount } from "./types";

async function post(path: string, body: unknown): Promise<unknown> {
  const token = await getIdTokenOrNull();
  if (!token) throw new Error("Sign in again before changing Strategy OS.");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/.netlify/functions/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string; reason?: string }).error || "Request failed.";
    const reason = (data as { error?: string; reason?: string }).reason;
    throw new Error(reason ? `${message} — ${reason}` : message);
  }
  return data;
}

// runType/deliverablesOverride/sourceContext come from the new-run wizard (NewRunWizard) —
// see strategy-run-start.js's own header comment for what each does server-side.
export function startRun(args: {
  brandId: string;
  month: string;
  actor: string;
  runType?: "monthly" | "campaign";
  deliverablesOverride?: DeliverablesCount;
  sourceContext?: string[];
}): Promise<{ runId: string }> {
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

export function decideStage(args: { runId: string; stage: string; decision: "approved" | "changes_requested"; actor: string; notes?: string }): Promise<{ ok: true }> {
  return post("strategy-stage-approve", args) as Promise<{ ok: true }>;
}

export function retryStage(args: { runId: string; stage: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-stage-retry", args) as Promise<{ ok: true }>;
}

export function reopenStage(args: { runId: string; stage: string; notes?: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-stage-reopen", args) as Promise<{ ok: true }>;
}

// "refine" (with notes) or "similar"/"suggest another" (strategy and copy) — kicks off a
// candidate replacement for one concept/copy card, reviewed before it's committed (see
// conceptCandidateHtml in the legacy app). `focus` optionally points at the specific part
// of the asset being refined (e.g. "Caption B", "Script" — copy only, see CopyReview.tsx).
export function proposeConcept(args: { runId: string; stage: string; assetId: string; action: "refine" | "similar"; notes?: string; focus?: string }): Promise<{ ok: true }> {
  return post("strategy-concept-propose", args) as Promise<{ ok: true }>;
}

// "discard"/"replace" — each stage's own "kill it, no review needed" type; auto-accepts,
// so there's no separate accept step for this one.
export function discardConcept(args: { runId: string; stage: string; assetId: string; notes?: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-concept-discard", args) as Promise<{ ok: true }>;
}

export function acceptCandidate(args: { runId: string; stage: string; assetId: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-concept-accept", args) as Promise<{ ok: true }>;
}

export function rejectCandidate(args: { runId: string; stage: string; assetId: string }): Promise<{ ok: true }> {
  return post("strategy-concept-candidate-reject", args) as Promise<{ ok: true }>;
}

export function toggleAssetLock(args: { runId: string; stage: string; assetId: string; actor: string; locked: boolean }): Promise<{ ok: true; locked: boolean }> {
  return post("strategy-asset-lock", args) as Promise<{ ok: true; locked: boolean }>;
}

export function updateDeckPage(args: { runId: string; pageIndex: number; field: "owner" | "productionStatus"; value: string }): Promise<{ ok: true }> {
  return post("strategy-deck-page-update", args) as Promise<{ ok: true }>;
}

export function createTeamTasks(args: { runId: string; actor: string }): Promise<{ ok: true; tasksCreated: number }> {
  return post("strategy-team-tasks-create", args) as Promise<{ ok: true; tasksCreated: number }>;
}

export async function downloadDeck(runId: string, format: "json" | "pptx"): Promise<void> {
  const token = await getIdTokenOrNull();
  if (!token) throw new Error("Sign in again before exporting this deck.");
  const res = await fetch("/.netlify/functions/strategy-deck-download", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId, format }),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || "Could not export this deck.");
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `strategy-deck.${format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// Not routed through post() — strategy-brand-save.js's 422 response carries a per-field
// `issues` array (see strategy-app.js's soSubmitBrandForm), which the generic error
// message post() builds doesn't surface. Same bearer-token attachment as post(), just with
// its own error formatting.
export async function saveBrand(args: { brandId: string; config: Record<string, unknown> }): Promise<{ ok: true }> {
  const token = await getIdTokenOrNull();
  if (!token) throw new Error("Sign in again before saving this brand.");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${token}`;
  const res = await fetch("/.netlify/functions/strategy-brand-save", { method: "POST", headers, body: JSON.stringify(args) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data as { error?: string; issues?: { path: string; message: string }[] };
    let msg = d.error || "Could not save this brand.";
    if (Array.isArray(d.issues) && d.issues.length) msg += "\n\n" + d.issues.map((i) => `• ${i.path}: ${i.message}`).join("\n");
    throw new Error(msg);
  }
  return data as { ok: true };
}
