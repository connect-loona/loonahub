// The continuous "chat" refine experience for a concept/copy card. Renders the growing
// `history` transcript (see pipeline.js's proposeAssetCandidate — each "refine" while a
// "ready" candidate is already sitting there chains onto THAT candidate instead of
// restarting from the checkpoint, so "make it warmer" then "now add a CTA" compounds
// rather than losing the first round) as alternating user/assistant lines, plus a single
// compose box to keep sending more notes. Once a candidate is "ready", Finalize commits it
// into the checkpoint (acceptCandidate) and Discard suggestion abandons the whole thread
// (rejectCandidate) — both close the chat.
//
// `section`, when set ("captions" | "script"), scopes the WHOLE panel to just that part of
// a copy asset — its own independent thread, candidate and lock (see CopyReview.tsx and
// pipeline.js's ASSET_STAGE_CONFIG.copy.sections), so refining captions and refining the
// script can run at the same time without one clobbering the other. `showVariations`, when
// set, adds a "Get variations" button next to Send — up to four fresh takes at once, two
// from each configured model provider (the "variations" request type; see pipeline.js's
// proposeAssetVariations), scoped to this section. Distinct from Send/"similar": those
// produce ONE alternative to review and finalize; variations produces several to pick
// between (VariationsPicker below), and a provider that's down just means fewer than four
// rather than a failure.
//
// Supersedes ConceptCandidatePreview.tsx: same running/failed/ready rendering, but always
// alongside the transcript and always with a way to send the next message rather than a
// one-off textarea that got thrown away after each round.
import { useState } from "react";
import type { ConceptCandidate } from "../lib/types";
import { AGENT_LINEUP, STAGE_AGENT_EMOJI } from "../lib/format";
import { acceptCandidate, discardConcept, proposeConcept, rejectCandidate } from "../lib/api";

function providerLabel(name: string): string {
  return name === "openai" ? "ChatGPT" : name === "claude" ? "Claude" : name;
}

function claimChipStyle(status?: string) {
  const color = status === "ready" ? "var(--green)" : status === "flagged" ? "var(--yellow)" : "var(--red)";
  const bg = status === "ready" ? "#12291d" : status === "flagged" ? "#3a2c12" : "#2c1414";
  return { color, background: bg };
}

function ReadyPreview({ stage, section, c }: { stage: "strategy" | "copy"; section?: "captions" | "script"; c: NonNullable<ConceptCandidate["candidate"]> }) {
  if (stage === "copy" && section === "captions") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
        {(c.captions || []).map((cap, i) => (
          <div key={i} style={{ fontSize: 12 }}>
            <div style={{ color: "var(--muted)", textTransform: "uppercase", fontSize: 10 }}>{cap.version} &middot; {cap.angle}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{cap.copy}</div>
          </div>
        ))}
      </div>
    );
  }
  if (stage === "copy" && section === "script") {
    const script = c.script as { durationSeconds?: number; scenes?: { timing: string; visual: string; voiceover: string }[] } | undefined;
    return (
      <div style={{ fontSize: 12 }}>
        {(script?.scenes || []).map((sc, i) => (
          <div key={i} style={{ color: "var(--muted)", marginTop: i ? 4 : 0 }}>{sc.timing} — {sc.visual} &middot; VO: "{sc.voiceover}"</div>
        ))}
      </div>
    );
  }
  if (stage === "copy") {
    return (
      <>
        <div style={{ margin: "4px 0", fontStyle: "italic" }}>&ldquo;{c.hook}&rdquo;</div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>{c.captions?.[0]?.copy || ""}</div>
        {c.claimAudit?.status && (
          <div style={{ marginTop: 4 }}><span className="st-chip" style={claimChipStyle(c.claimAudit.status)}>{c.claimAudit.status}</span></div>
        )}
      </>
    );
  }
  return (
    <>
      <div style={{ fontWeight: 700 }}>{c.conceptName}</div>
      <div style={{ margin: "4px 0", fontStyle: "italic" }}>&ldquo;{c.hook}&rdquo;</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Tension:</b> {c.tension}</div>
    </>
  );
}

// Side-by-side cards for a "variations" candidate — up to four, each tagged with the model
// that wrote it, each independently accepted. Distinct from ReadyPreview's single
// candidate + Finalize/Discard: there's no one obvious "the" replacement here, so every
// card gets its own "Use this one" rather than one shared accept action.
function VariationsPicker({ stage, section, variations, busy, onUse, onDiscardAll }: {
  stage: "strategy" | "copy"; section?: "captions" | "script";
  variations: NonNullable<ConceptCandidate["variations"]>;
  busy: boolean; onUse: (index: number) => void; onDiscardAll: () => void;
}) {
  return (
    <div className="st-candidate-box">
      <div className="st-candidate-label">
        {variations.length} variation{variations.length === 1 ? "" : "s"} ready
        {variations.length < 4 ? " (one model wasn't available, so fewer than four this time)" : ""}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginTop: 6 }}>
        {variations.map((v, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>{providerLabel(v.provider)}</div>
            <ReadyPreview stage={stage} section={section} c={v.candidate} />
            <button className="st-btn st-btn-primary st-btn-sm" style={{ width: "100%", marginTop: 8 }} disabled={busy} onClick={() => onUse(i)}>Use this one</button>
          </div>
        ))}
      </div>
      <button className="st-btn st-btn-ghost" style={{ width: "100%", marginTop: 8 }} disabled={busy} onClick={onDiscardAll}>Discard all</button>
    </div>
  );
}

export function ConceptChatPanel({ runId, stage, assetId, section, candidate, actor, open, onOpenChange, focus, onFocusClear, showVariations, showCancel = true, onError }: {
  runId: string; stage: "strategy" | "copy"; assetId: string; candidate: ConceptCandidate | undefined; actor: string;
  // `open`: the reviewer clicked "Refine" and wants to start a first message. Once a
  // candidate/thread already exists the panel shows regardless of `open` — there's already
  // something to look at. A caller can also pass `open` permanently true (with a no-op
  // onOpenChange) for an always-visible chat box — see CopyReview.tsx's captions/script
  // sections — in which case pass `showCancel={false}` too, since there's nothing to
  // cancel back to.
  open: boolean; onOpenChange: (open: boolean) => void;
  // Scopes this panel to one independently-refinable part of a copy asset — see the
  // header comment. Omit for strategy (no sections) or a whole-asset copy action.
  section?: "captions" | "script";
  focus?: string | null; onFocusClear?: () => void;
  // Adds a "Get variations" button (up to four fresh takes, scoped to `section`) — used by
  // the captions block; script has no equivalent today.
  showVariations?: boolean;
  // Hide the "Cancel" button on an empty compose box — for a permanently-open panel
  // (see `open` above) there's no toggle to cancel back to.
  showCancel?: boolean;
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
  const isVariations = candidate?.requestType === "variations";
  const ready = candidate?.status === "ready" && !!candidate.candidate;
  const c = ready ? candidate!.candidate! : null;
  const variationsReady = isVariations && candidate?.status === "ready" && !!candidate.variations?.length;

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
      await proposeConcept({ runId, stage, assetId, action: "refine", notes: trimmed, focus: focus || undefined, section });
      setNotes("");
    });
  }

  async function handleVariations() {
    await withBusy(() => proposeConcept({ runId, stage, assetId, action: "variations", focus: focus || undefined, section }));
  }

  async function handleFinalize() {
    await withBusy(() => acceptCandidate({ runId, stage, assetId, actor, section }));
    onOpenChange(false);
  }

  async function handleUseVariation(variationIndex: number) {
    await withBusy(() => acceptCandidate({ runId, stage, assetId, actor, section, variationIndex }));
    onOpenChange(false);
  }

  async function handleDiscardSuggestion() {
    await withBusy(() => rejectCandidate({ runId, stage, assetId, section }));
    onOpenChange(false);
  }

  async function handleRetry() {
    if (!candidate) return;
    await withBusy(() => (candidate.requestType === "discard" || candidate.requestType === "replace")
      ? discardConcept({ runId, stage, assetId, notes: candidate.notes, actor })
      : proposeConcept({ runId, stage, assetId, action: (candidate.requestType as "refine" | "similar" | "variations") || "refine", notes: candidate.notes, focus: candidate.focus || undefined, section }));
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
          <ReadyPreview stage={stage} section={section} c={c} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="st-btn st-btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={handleDiscardSuggestion}>Discard suggestion</button>
            <button className="st-btn st-btn-primary" style={{ flex: 1 }} disabled={busy} onClick={handleFinalize}>Finalize</button>
          </div>
        </div>
      )}

      {variationsReady && candidate!.variations && (
        <VariationsPicker
          stage={stage} section={section} variations={candidate!.variations}
          busy={busy} onUse={handleUseVariation} onDiscardAll={handleDiscardSuggestion}
        />
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
            {!!showVariations && (
              <button className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={handleVariations}>Get variations</button>
            )}
            {!candidate && showCancel && (
              <button className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
