// The continuous "chat" refine experience for a concept/copy card. Renders the growing
// `history` transcript (see pipeline.js's proposeAssetCandidate — each "refine" while a
// "ready" candidate is already sitting there chains onto THAT candidate instead of
// restarting from the checkpoint, so "make it warmer" then "now add a CTA" compounds
// rather than losing the first round) as alternating user/assistant lines, plus a single
// compose box to keep sending more notes. Once a candidate is "ready", Finalize commits it
// into the checkpoint (acceptCandidate) and Discard suggestion abandons the whole thread
// (rejectCandidate) — both close the chat.
//
// Supersedes ConceptCandidatePreview.tsx: same running/failed/ready rendering, but always
// alongside the transcript and always with a way to send the next message rather than a
// one-off textarea that got thrown away after each round.
import { useState } from "react";
import type { ConceptCandidate } from "../lib/types";
import { AGENT_LINEUP, STAGE_AGENT_EMOJI } from "../lib/format";
import { acceptCandidate, discardConcept, proposeConcept, rejectCandidate } from "../lib/api";

function claimChipStyle(status?: string) {
  const color = status === "ready" ? "var(--green)" : status === "flagged" ? "var(--yellow)" : "var(--red)";
  const bg = status === "ready" ? "#12291d" : status === "flagged" ? "#3a2c12" : "#2c1414";
  return { color, background: bg };
}

export function ConceptChatPanel({ runId, stage, assetId, candidate, actor, open, onOpenChange, focus, onFocusClear, onError }: {
  runId: string; stage: "strategy" | "copy"; assetId: string; candidate: ConceptCandidate | undefined; actor: string;
  // `open`: the reviewer clicked "Refine" and wants to start a first message. Once a
  // candidate/thread already exists the panel shows regardless of `open` — there's already
  // something to look at.
  open: boolean; onOpenChange: (open: boolean) => void;
  focus?: string | null; onFocusClear?: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const visible = open || !!candidate;
  if (!visible) return null;

  const agent = AGENT_LINEUP.find((a) => a.stage === stage);
  const agentName = agent?.name || "The agent";
  const agentEmoji = STAGE_AGENT_EMOJI[stage] || "🤖";
  const history = candidate?.history || [];
  const running = candidate?.status === "running";
  const ready = candidate?.status === "ready" && !!candidate.candidate;
  const c = ready ? candidate!.candidate! : null;

  async function withBusy(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    const trimmed = notes.trim();
    if (!trimmed) { alert("Say what should change first."); return; }
    await withBusy(async () => {
      await proposeConcept({ runId, stage, assetId, action: "refine", notes: trimmed, focus: focus || undefined });
      setNotes("");
    });
  }

  async function handleFinalize() {
    await withBusy(() => acceptCandidate({ runId, stage, assetId, actor }));
    onOpenChange(false);
  }

  async function handleDiscardSuggestion() {
    await withBusy(() => rejectCandidate({ runId, stage, assetId }));
    onOpenChange(false);
  }

  async function handleRetry() {
    if (!candidate) return;
    await withBusy(() => (candidate.requestType === "discard" || candidate.requestType === "replace")
      ? discardConcept({ runId, stage, assetId, notes: candidate.notes, actor })
      : proposeConcept({ runId, stage, assetId, action: (candidate.requestType as "refine" | "similar") || "refine", notes: candidate.notes, focus: candidate.focus || undefined }));
  }

  return (
    <div className="st-chat-panel">
      {focus && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
          Focused on: <b>{focus}</b>
          {onFocusClear && <a href="#" style={{ marginLeft: 6, color: "var(--accent)" }} onClick={(e) => { e.preventDefault(); onFocusClear(); }}>clear</a>}
        </div>
      )}

      {history.length > 0 && (
        <div className="st-chat-thread">
          {history.map((turn, i) => (
            <div key={i} className={`st-chat-turn st-chat-turn-${turn.role}`}>
              {turn.role === "user"
                ? <><b>You{turn.focus ? ` (${turn.focus})` : ""}:</b> {turn.notes || "Suggest another take."}</>
                : <><b>{agentEmoji} {agentName}:</b> {turn.summary}</>}
            </div>
          ))}
        </div>
      )}

      {running && (
        <div className="st-note" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <span className="st-working" aria-hidden><span /><span /><span /></span>
          <span>{candidate?.detail || "Working on a replacement…"}</span>
        </div>
      )}

      {candidate?.status === "failed" && (
        <>
          <div className="st-note" style={{ marginTop: 8, color: "var(--red)" }}>Couldn't generate a replacement: {candidate.detail || "Unknown error"}</div>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ marginTop: 6 }} disabled={busy} onClick={handleRetry}>Try again</button>
        </>
      )}

      {ready && c && (
        <div className="st-candidate-box">
          <div className="st-candidate-label">Proposed replacement{focus ? ` — ${focus}` : ""}</div>
          {stage === "copy" ? (
            <>
              <div style={{ margin: "4px 0", fontStyle: "italic" }}>&ldquo;{c.hook}&rdquo;</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{c.captions?.[0]?.copy || ""}</div>
              {c.claimAudit?.status && (
                <div style={{ marginTop: 4 }}><span className="st-chip" style={claimChipStyle(c.claimAudit.status)}>{c.claimAudit.status}</span></div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontWeight: 700 }}>{c.conceptName}</div>
              <div style={{ margin: "4px 0", fontStyle: "italic" }}>&ldquo;{c.hook}&rdquo;</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Tension:</b> {c.tension}</div>
            </>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="st-btn st-btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={handleDiscardSuggestion}>Discard suggestion</button>
            <button className="st-btn st-btn-primary" style={{ flex: 1 }} disabled={busy} onClick={handleFinalize}>Finalize</button>
          </div>
        </div>
      )}

      {!running && (
        <div style={{ marginTop: 8 }}>
          <textarea
            className="st-form-control"
            placeholder={history.length > 0 ? "Keep chatting — what else should change?" : focus ? `What should change about ${focus.toLowerCase()}?` : "What should change about this concept?"}
            style={{ minHeight: 50, fontSize: 12, marginBottom: 6 }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button className="st-btn st-btn-primary st-btn-sm" disabled={busy} onClick={handleSend}>Send</button>
            {!candidate && (
              <button className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
