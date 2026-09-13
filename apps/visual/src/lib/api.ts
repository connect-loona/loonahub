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
import type { Generation, VisualChat } from "./types";

async function post(path: string, body: unknown): Promise<unknown> {
  const token = await getIdTokenOrNull();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/.netlify/functions/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const payload = data as { error?: string; reason?: string };
    const message = payload.error || "Request failed.";
    throw new Error(payload.reason ? `${message} — ${payload.reason}` : message);
  }
  return data;
}

export function listChats(brandId: string): Promise<{ chats: VisualChat[] }> {
  return post("visual-chat", { action: "list", brandId }) as Promise<{ chats: VisualChat[] }>;
}

export function createChat(brandId: string, actor: string, title?: string): Promise<{ id: string; chat: VisualChat }> {
  return post("visual-chat", { action: "create", brandId, actor, title }) as Promise<{ id: string; chat: VisualChat }>;
}

export function chatHistory(chatId: string): Promise<{ chat: VisualChat; generations: Generation[] }> {
  return post("visual-chat", { action: "history", chatId }) as Promise<{ chat: VisualChat; generations: Generation[] }>;
}

export function generate(args: {
  chatId: string;
  prompt: string;
  count?: number;
  size?: string;
  actor: string;
}): Promise<Generation & { recorded: boolean; brandId: string }> {
  return post("visual-generate", args) as Promise<Generation & { recorded: boolean; brandId: string }>;
}

export function pickImage(args: {
  brandId: string;
  generationId: string;
  index: number;
  actor: string;
  note?: string;
}): Promise<{ ok: true }> {
  return post("visual-pick", args) as Promise<{ ok: true }>;
}
