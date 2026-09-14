// Visual Studio's calls into the Netlify Functions backend.
//
// Same auth arrangement as Strategy OS: the browser attaches the legacy loona_auth cookie
// automatically on this origin (which is what the endpoints actually verify today), and this
// also sends the Firebase ID token so nothing here changes when server-side token
// verification lands.
//
// Note what is NOT sent once a chat exists: a brandId. A chat owns its brand server-side, and
// the backend reads it from the stored chat record — see visual-chats.js's header for why
// letting the browser name the brand would be a cross-client leak waiting to happen.
import { getIdTokenOrNull } from "./firebase";
import type { Generation, PendingReference, VisualChat } from "./types";

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await getIdTokenOrNull();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const token = await getIdTokenOrNull();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/.netlify/functions/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const payload = data as { error?: string; reason?: string };
    const message = payload.error || "Request failed.";
    const err = new Error(payload.reason ? `${message} — ${payload.reason}` : message) as Error & { status?: number };
    // 429 (a burst rate limit, retry works) and 402 (out of credit, retry never works) need
    // different advice, so the status has to survive as far as the screen.
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function uploadReference(chatId: string, reference: PendingReference): Promise<PendingReference> {
  if (reference.assetKey) return reference;
  if (!reference.file) throw new Error(`${reference.name || "Reference"} is no longer available to upload.`);
  const query = new URLSearchParams({ chatId, filename: reference.name || "reference", role: reference.role || "" });
  const headers = await authHeaders({ "Content-Type": reference.file.type || "image/png" });
  const res = await fetch(`/.netlify/functions/visual-reference-upload?${query}`, {
    method: "POST", headers, body: reference.file,
  });
  const data = await res.json().catch(() => ({})) as { asset?: { assetKey: string; url: string; contentType?: string; warnings?: string[] }; error?: string };
  if (!res.ok || !data.asset) throw new Error(data.error || "Could not upload the reference.");
  return { ...reference, assetKey: data.asset.assetKey, dataUrl: data.asset.url, contentType: data.asset.contentType, warnings: data.asset.warnings, file: undefined };
}

export function listChats(brandId: string): Promise<{ chats: VisualChat[] }> {
  return post("visual-chat", { action: "list", brandId }) as Promise<{ chats: VisualChat[] }>;
}

export function createChat(brandId: string, actor: string, title?: string): Promise<{ id: string; chat: VisualChat }> {
  return post("visual-chat", { action: "create", brandId, actor, title }) as Promise<{ id: string; chat: VisualChat }>;
}

export function renameChat(chatId: string, title: string): Promise<{ ok: true; chat: VisualChat }> {
  return post("visual-chat", { action: "rename", chatId, title }) as Promise<{ ok: true; chat: VisualChat }>;
}

export function chatHistory(chatId: string, before?: string): Promise<{ chat: VisualChat; generations: Generation[]; hasMore?: boolean }> {
  return post("visual-chat", { action: "history", chatId, before, limit: 20 }) as Promise<{ chat: VisualChat; generations: Generation[]; hasMore?: boolean }>;
}

type VisualJob = { id: string; status: "queued" | "running" | "succeeded" | "failed"; progress?: string; result?: Generation & { recorded: boolean; brandId: string }; error?: string };

async function waitForJob(jobId: string): Promise<Generation & { recorded: boolean; brandId: string }> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const { job } = await post("visual-job", { action: "status", jobId }) as { job: VisualJob };
    if (job.status === "succeeded" && job.result) return job.result;
    if (job.status === "failed") throw new Error(job.error || "Image generation failed.");
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
  throw new Error("Generation is still running. It is safe to refresh; this job remains in Visual Studio.");
}

export function generate(args: {
  chatId: string;
  prompt: string;
  count?: number;
  size?: string;
  // "draft" (medium quality, JPEG — fast and cheap for exploring) or "final" (high, PNG).
  quality?: string;
  provider?: "openai" | "magnific";
  actor: string;
  // These contain durable asset keys, never multi-megabyte data URLs.
  references?: PendingReference[];
  parentGenerationId?: string | null;
  parentImageIndex?: number | null;
}): Promise<Generation & { recorded: boolean; brandId: string }> {
  return (async () => {
    // Browser tests use the deterministic synchronous fixture endpoint. Production always
    // uses recoverable jobs, which is the behaviour this branch ships.
    if (import.meta.env.MODE === "test") {
      return post("visual-generate", args) as Promise<Generation & { recorded: boolean; brandId: string }>;
    }
    const { job, workerToken } = await post("visual-job", { action: "create", request: args, actor: args.actor }) as { job: VisualJob; workerToken: string };
    const headers = await authHeaders({ "Content-Type": "application/json" });
    const started = await fetch("/.netlify/functions/visual-generate-background", {
      method: "POST", headers, body: JSON.stringify({ jobId: job.id, workerToken }),
    });
    if (!started.ok && started.status !== 202) throw new Error("Could not start the generation job.");
    return waitForJob(job.id);
  })();
}

export function enhanceImage(args: { chatId: string; generationId: string; imageIndex: number; actor: string }): Promise<Generation & { recorded: boolean; brandId: string }> {
  return (async () => {
    const request = {
      operation: "magnific_precision", chatId: args.chatId, prompt: "Enhance with Magnific Precision",
      sourceGenerationId: args.generationId, sourceImageIndex: args.imageIndex, actor: args.actor,
    };
    const { job, workerToken } = await post("visual-job", { action: "create", request, actor: args.actor }) as { job: VisualJob; workerToken: string };
    const headers = await authHeaders({ "Content-Type": "application/json" });
    const started = await fetch("/.netlify/functions/visual-generate-background", {
      method: "POST", headers, body: JSON.stringify({ jobId: job.id, workerToken }),
    });
    if (!started.ok && started.status !== 202) throw new Error("Could not start Magnific enhancement.");
    return waitForJob(job.id);
  })();
}

export interface UsageRow {
  key: string; name?: string; email?: string | null; verified?: boolean;
  requests: number; outputs: number; generations: number; enhancements: number; strategyRuns: number; picks: number; reviews: number; failures: number;
}

export interface UsageReport {
  month: string;
  coverage: string;
  totals: UsageRow;
  users: UsageRow[];
  providers: UsageRow[];
  accounts: {
    openai: { connected: boolean; spendUsd?: number; imageCount?: number; budgetUsd?: number | null; remainingBudgetUsd?: number | null; reason?: string };
    magnific: { connected: boolean; analyticsConnected?: boolean; operations: number; creditsUsed?: number; uses?: number; allowance?: number | null; remainingCredits?: number | null; reason?: string; note: string };
  };
}

export function usageReport(month?: string): Promise<UsageReport> {
  return post("api-usage", { month }) as Promise<UsageReport>;
}

// 🧠 Mani, asked from inside the studio. The brandId is sent explicitly here rather than
// inferred from a chat, because this question isn't about one chat — it's about everything
// recorded for the brand, which includes the rounds generated in every other chat.
//
// Note this is the SAME endpoint Strategy OS and Hub ask. There is one Mani and one definition
// of what Loona remembers; the studio gets a place to type, not a second memory.
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

export function pickImage(args: {
  brandId: string;
  generationId: string;
  index: number;
  actor: string;
  note?: string;
  tags?: string[];
}): Promise<{ ok: true }> {
  return post("visual-pick", args) as Promise<{ ok: true }>;
}

export function reviewImage(args: { chatId: string; generationId: string; imageIndex: number }): Promise<{ qc: import("./types").VisualQc }> {
  return post("visual-qc", args) as Promise<{ qc: import("./types").VisualQc }>;
}
