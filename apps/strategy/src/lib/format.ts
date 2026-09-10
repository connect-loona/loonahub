// Ported verbatim (same logic, same output) from strategy-app.js's fmtDateTime/monthLabel/
// statusLabel — see docs/strategy-os-touchpoints.md. Faithful port, not a redesign.
import { STAGE_LABELS, STAGE_ORDER } from "./types";

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function monthLabel(m?: string | null): string {
  if (!m) return "—";
  const parts = m.split("-");
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", queued: "Queued", locked: "Locked",
  running: "Running", repairing: "Repairing", needs_review: "Needs review",
  approved: "Approved", failed: "Failed", changes_requested: "Changes requested",
};
for (const s of STAGE_ORDER) {
  STATUS_LABELS[`${s}_running`] = `${STAGE_LABELS[s]} running`;
  STATUS_LABELS[`${s}_needs_review`] = "Needs review";
  STATUS_LABELS[`${s}_changes_requested`] = "Changes requested";
  STATUS_LABELS[`${s}_approved`] = `${STAGE_LABELS[s]} approved`;
}

export function statusLabel(s?: string | null): string {
  return (s && STATUS_LABELS[s]) || s || "—";
}

// Plain-language phrase for the "Your next action" card — ported verbatim from
// strategy-app.js's plainActionPhrase().
const PLAIN_RUNNING_LABELS: Record<string, string> = {
  research: "Researching", strategy: "Writing strategy", copy: "Creating copy",
  "creative-direction": "Directing the shoot", "deck-builder": "Building deck",
};
export const STAGE_AGENT_EMOJI: Record<string, string> = {
  research: "👨🏻‍✈️", strategy: "🧕🏻", copy: "👩‍🎨",
  "creative-direction": "👩🏼‍🎤", "deck-builder": "👷🏾",
};
export function plainActionPhrase(stage: string, status?: string | null): string {
  if (status === "running") return PLAIN_RUNNING_LABELS[stage] || "Working";
  if (status === "repairing") return `${PLAIN_RUNNING_LABELS[stage] || "Working"} — fixing an issue`;
  if (status === "needs_review") return "Ready for review";
  if (status === "changes_requested") return "Changes requested";
  if (status === "failed") return "Something went wrong";
  if (status === "locked") return "Waiting";
  if (status === "approved") return "Approved";
  return statusLabel(status);
}
