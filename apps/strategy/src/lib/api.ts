// Calls the existing Netlify Functions backend — the "shared backend" layer the target
// architecture already has (see docs/strategy-os-touchpoints.md's endpoint list). Every
// call sends this app's own Firebase ID token as a bearer header, per the
// working-instructions doc's auth boundary rule ("obtains the current user's ID token for
// API requests") — the endpoints themselves still only verify the legacy loona_auth
// cookie today (which the browser attaches automatically on this same origin regardless,
// so calls succeed either way), but sending the token now means nothing here needs to
// change when server-side ID-token verification is added as its own follow-up.
import { getIdTokenOrNull } from "./firebase";
import type { DeliverablesCount, DriveBrandFolder } from "./types";

async function post(path: string, body: unknown): Promise<unknown> {
  const token = await getIdTokenOrNull();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/.netlify/functions/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await res.text();
  let data: { error?: string; reason?: string } = {};
  try { data = JSON.parse(raw); } catch { /* not JSON — handled below */ }
  if (!res.ok) {
    // A response with no parseable .error means the platform itself rejected this before
    // this endpoint's own error handling ever ran (a raw gateway error, a timeout, a body
    // that isn't JSON at all) — "Request failed." alone gave no way to tell that apart from
    // an ordinary validation rejection, so surface exactly what came back instead of hiding
    // it behind one fixed string every time.
    if (data.error) throw new Error(data.reason ? `${data.error} — ${data.reason}` : data.error);
    if (/inactivity timeout|<title>/i.test(raw)) throw new Error("BB took too long to answer. Please send that message once more.");
    throw new Error(`Request failed (HTTP ${res.status}): ${raw.slice(0, 300) || "empty response"}`);
  }
  return data;
}

// runType/deliverablesOverride/sourceContext come from the new-run wizard (NewRunWizard) —
// see strategy-run-start.js's own header comment for what each does server-side.
// runtime picks which model writes the run; runtimes overrides that per stage (keys are the
// five pipeline stage names). Both are preferences, not bindings — an unreachable provider
// falls over to the other one server-side (runtime-failover.js).
export function startRun(args: {
  brandId: string;
  month: string;
  actor: string;
  runType?: "monthly" | "campaign";
  chatMode?: boolean;
  runtime?: "openai" | "claude";
  runtimes?: Record<string, "openai" | "claude">;
  deliverablesOverride?: DeliverablesCount;
  sourceContext?: string[];
  campaignBrief?: Record<string, string>;
}): Promise<{ runId: string }> {
  return post("strategy-run-start", args) as Promise<{ runId: string }>;
}

export type CampaignAction = "generate_identities" | "save_identity" | "lock_identity" | "generate_thought" | "lock_thought" | "generate_routes" | "lock_route" | "generate_assets";

export function campaignAction(args: {
  runId: string;
  action: CampaignAction;
  actor: string;
  optionId?: string;
  routeId?: string;
  instruction?: string;
  assetRequest?: string;
  customIdentity?: { name: string; tagline: string; objective?: string; territory?: string };
  thought?: Record<string, unknown>;
}): Promise<{ ok: true; status?: string }> {
  return post("strategy-campaign-action", args) as Promise<{ ok: true; status?: string }>;
}

export function saveStrategyChatMessage(args: { runId: string; role: "user" | "assistant"; text: string; actor: string }): Promise<{ ok: true; id: string }> {
  return post("strategy-chat-message", args) as Promise<{ ok: true; id: string }>;
}

// Clears only the visible transcript for one monthly or campaign run. The run brief,
// research and approved work remain intact, so a team can tidy the conversation without
// deleting the actual plan.
export function clearStrategyChat(args: { runId: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-chat-message", { ...args, action: "clear" }) as Promise<{ ok: true }>;
}

// Re-reads a brand's Drive folder now, instead of waiting for the next strategy run to do it
// as a side effect. Returns as soon as the scan is queued — the work happens in a background
// function and progress shows up on the strategy_brand_library/<brandId> listener.
export function scanBrandLibrary(args: { brandId: string; actor: string }): Promise<{ ok: true; brandId: string }> {
  return post("strategy-brand-library-scan", args) as Promise<{ ok: true; brandId: string }>;
}

// Asking 🧠 Mani about a brand. `nothingRecorded` is a real answer rather than a failure —
// see lib/strategy/mani.js for why an honest gap beats a confident guess.
export function askMani(args: { brandId: string; question: string }): Promise<{
  answer?: string | null;
  grounded?: boolean;
  nothingRecorded?: boolean;
  detail?: string;
}> {
  return post("strategy-mani-ask", args) as Promise<{
    answer?: string | null; grounded?: boolean; nothingRecorded?: boolean; detail?: string;
  }>;
}

// Deliberate human-supplied context: notes or prior ChatGPT conversation excerpts are
// kept as a source record for the selected brand, rather than being mistaken for a question.
export function saveManiMemory(args: { brandId: string; content: string; actor: string }): Promise<{ ok: true; id: string }> {
  return post("strategy-mani-memory", args) as Promise<{ ok: true; id: string }>;
}

export function draftBrandFromManiMemory(args: { brandId: string; name: string; actor: string }): Promise<{ ok: true; brandId: string }> {
  return post("strategy-mani-config-draft", args) as Promise<{ ok: true; brandId: string }>;
}

// BB is the team-facing conversational strategist. The endpoint supplies Mani's composed
// brand memory server-side, so the browser never has to assemble or transmit that context.
export function askBB(args: { brandId?: string; scope?: "global"; threadId?: string; message: string; actor: string; attachments?: Array<{ assetKey: string; url: string; filename?: string }> }): Promise<{ answer: string }> {
  return post("strategy-bb-chat", args) as Promise<{ answer: string }>;
}

export function clearBB(args: { brandId?: string; scope?: "global"; threadId?: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-bb-chat", { ...args, action: "clear", message: "clear" }) as Promise<{ ok: true }>;
}

export async function uploadBBAttachment(brandId: string | undefined, scope: "brand" | "global", file: File): Promise<{ assetKey: string; url: string; filename?: string }> {
  const token = await getIdTokenOrNull();
  const headers: Record<string, string> = { "Content-Type": file.type };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/.netlify/functions/bb-upload?scope=${scope}&brandId=${encodeURIComponent(brandId || "")}&filename=${encodeURIComponent(file.name)}`, { method: "POST", headers, body: file });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not upload attachment.");
  return data.asset;
}

// The brand folders sitting in Drive, and whether each already has a brand in Hub. The Drive
// folder is where a new client actually starts, so this is what "which brands exist?" should
// be answered from.
export function discoverBrandFolders(): Promise<{ folders: DriveBrandFolder[] }> {
  return post("strategy-brand-discover", {}) as Promise<{ folders: DriveBrandFolder[] }>;
}

// Drafts a brand config from its Drive folder. Returns once drafting has been queued — the
// work runs in a background function and the result lands on
// strategy_brand_drafts/<brandId>, which useBrandDraft watches.
export function draftBrandFromDrive(args: { brandId: string; name: string; folderId: string }): Promise<{ ok: true }> {
  return post("strategy-brand-draft", args) as Promise<{ ok: true }>;
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

// "refine" (with notes), "similar"/"suggest another" (one alternative), or "variations"
// (up to four at once — two per configured model provider, see pipeline.js's
// proposeAssetVariations) — kicks off a candidate replacement for one concept/copy card,
// reviewed before it's committed (see conceptCandidateHtml in the legacy app). `focus`
// optionally points at the specific part of the asset being refined (e.g. "Caption B",
// "Script" — copy only, see CopyReview.tsx). `section` ("captions" | "script", copy only)
// scopes this to a fully independent thread — see ConceptChatPanel.tsx's own header comment.
export function proposeConcept(args: { runId: string; stage: string; assetId: string; action: "refine" | "similar" | "variations"; notes?: string; focus?: string; section?: string }): Promise<{ ok: true }> {
  return post("strategy-concept-propose", args) as Promise<{ ok: true }>;
}

// "discard"/"replace" — each stage's own "kill it, no review needed" type; auto-accepts,
// so there's no separate accept step for this one. Always whole-asset (no `section`) —
// it's a deliberate "throw it all out" action, not a scoped continuation.
export function discardConcept(args: { runId: string; stage: string; assetId: string; notes?: string; actor: string }): Promise<{ ok: true }> {
  return post("strategy-concept-discard", args) as Promise<{ ok: true }>;
}

// `variationIndex` picks which of a "variations" request's (up to four) options to commit —
// required for that request type, ignored for every other one (see
// pipeline.js's acceptAssetCandidate).
export function acceptCandidate(args: { runId: string; stage: string; assetId: string; actor: string; section?: string; variationIndex?: number }): Promise<{ ok: true }> {
  return post("strategy-concept-accept", args) as Promise<{ ok: true }>;
}

export function rejectCandidate(args: { runId: string; stage: string; assetId: string; section?: string }): Promise<{ ok: true }> {
  return post("strategy-concept-candidate-reject", args) as Promise<{ ok: true }>;
}

export function toggleAssetLock(args: { runId: string; stage: string; assetId: string; actor: string; locked: boolean; section?: string }): Promise<{ ok: true; locked: boolean }> {
  return post("strategy-asset-lock", args) as Promise<{ ok: true; locked: boolean }>;
}

export function updateDeckPage(args: { runId: string; pageIndex: number; field: "owner" | "productionStatus"; value: string }): Promise<{ ok: true }> {
  return post("strategy-deck-page-update", args) as Promise<{ ok: true }>;
}

export function createTeamTasks(args: { runId: string; actor: string }): Promise<{ ok: true; tasksCreated: number }> {
  return post("strategy-team-tasks-create", args) as Promise<{ ok: true; tasksCreated: number }>;
}

// Not routed through post() — strategy-brand-save.js's 422 response carries a per-field
// `issues` array (see strategy-app.js's soSubmitBrandForm), which the generic error
// message post() builds doesn't surface. Same bearer-token attachment as post(), just with
// its own error formatting.
export async function saveBrand(args: { brandId: string; config: Record<string, unknown> }): Promise<{ ok: true }> {
  const token = await getIdTokenOrNull();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
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
