// The conversation: each round is what somebody asked for, followed by what came back.
//
// Two honesty rules run through this file.
//
// An expired preview says so. Provider image URLs die after about an hour (see
// visual-memory.js). Rounds generated before Visual Studio kept its own copies have only such
// a URL, and it has long since died. Rendering a dead URL
// would show a broken image and quietly imply the record is damaged — when in fact the prompt,
// the pick and the reasoning are all intact and are the parts that actually compound.
//
// A picked image is marked as picked, by name. The pick is the single most valuable thing this
// app records, so it has to be visible in the thread rather than only in the database.
import { useState } from "react";
import type { Generation } from "../lib/types";

const PICK_SIGNALS = ["Product is accurate", "Strong composition", "On-brand colour", "Natural lighting", "Client-ready"];

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Round({ generation, onPick, onUseAsReference, onSuggestion, onReview, onEnhance }: {
  generation: Generation;
  onPick: (g: Generation, i: number, note?: string, tags?: string[]) => void;
  onUseAsReference: (g: Generation, i: number) => void;
  onSuggestion: (prompt: string) => void;
  onReview: (g: Generation, i: number) => Promise<void>;
  onEnhance: (g: Generation, i: number) => Promise<void>;
}) {
  const images = generation.images || [];
  const picked = generation.pickedIndex;
  const [feedbackFor, setFeedbackFor] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState<number | null>(null);

  return (
    <article className="vs-round">
      <div className="vs-ask">
        <p>{generation.prompt}</p>
        {/* What this round was built from remains attached to the permanent record. */}
        {generation.referenceCount ? (
          <span className="vs-meta">
            Worked from {generation.referenceCount} reference{generation.referenceCount === 1 ? "" : "s"}
            {generation.referenceNote ? ` · ${generation.referenceNote}` : ""}
          </span>
        ) : null}
        <span className="vs-meta">{generation.actor} · {when(generation.createdAt)}</span>
      </div>

      <div className="vs-reply">
        {generation.expandedPrompt && (
          // Collapsed by default: nobody needs this most of the time, but when an image comes
          // back wrong it's the first thing worth reading — it tells you whether the model
          // misunderstood, or whether it did exactly what it was asked.
          <details className="vs-expanded">
            <summary>What the model was actually asked for</summary>
            <p>{generation.expandedPrompt}</p>
          </details>
        )}

        {generation.appliedRules && generation.appliedRules.length > 0 && (
          // Exactly the rules that were prepended to the prompt — not a set of toggles that
          // look like they did something. See visual-rules.js.
          <div className="vs-rules">
            {generation.appliedRules.map((rule) => (
              <span key={rule.key} className={`vs-rule vs-rule-${rule.source}`} title={rule.label}>
                {rule.label}
              </span>
            ))}
          </div>
        )}

        {generation.previewExpired ? (
          <p className="vs-expired">
            This older preview was created before permanent image storage was enabled. Its prompt and choice are kept permanently.
          </p>
        ) : (
          <div className="vs-images" data-count={images.length}>
            {images.map((image, i) => (
              <figure key={i} className={`vs-image${picked === i ? " is-picked" : ""}`}>
                {image.url
                  ? <img src={image.url} alt={`Option ${i + 1} for: ${generation.prompt}`} loading="lazy" />
                  : <div className="vs-image-missing">No image returned</div>}
                <figcaption>
                  {/* "Use this" opens the panel and records NOTHING. Recording here as well as
                      on Save wrote the pick twice — once bare, once with the tags — and Cancel
                      still left the bare one behind, so "I changed my mind" silently taught the
                      brand's memory the wrong take. The write happens on Save, once. */}
                  {picked === i ? (
                    <span className="vs-picked-flag">✓ Chosen{generation.pickedBy ? ` by ${generation.pickedBy}` : ""}</span>
                  ) : (
                    <button type="button" onClick={() => { setFeedbackFor(i); setTags([]); setNote(""); }}>Use this</button>
                  )}
                  {image.url && (
                    <>
                      {/* Carrying a take back up as the next reference is the iteration loop —
                          "now make the table warmer" without re-uploading anything.
                          It needs the stored image, though: rounds made before Visual Studio
                          kept its own copies have only a provider URL that has long since
                          expired, and nothing to send a model. Offering the button there fails
                          at send time with "no longer available to upload", which reads like a
                          bug. Say why instead. */}
                      {image.assetKey ? (
                        <button type="button" className="vs-useref" onClick={() => onUseAsReference(generation, i)}>
                          Build on this
                        </button>
                      ) : (
                        <span className="vs-useref-unavailable" title="This round was made before Visual Studio kept its own copies of generated images.">
                          Re-upload to build on this
                        </span>
                      )}
                      {image.assetKey && generation.operation !== "magnific_precision" && (
                        <button type="button" className="vs-useref" disabled={enhancing !== null} onClick={async () => {
                          setEnhancing(i); setReviewError(null);
                          try { await onEnhance(generation, i); } catch (e) { setReviewError(e instanceof Error ? e.message : String(e)); }
                          finally { setEnhancing(null); }
                        }}>{enhancing === i ? "Enhancing…" : "Enhance in Magnific"}</button>
                      )}
                      <a href={image.url} download={`${generation.id}-${i + 1}.png`} target="_blank" rel="noopener noreferrer">
                        Download
                      </a>
                    </>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        )}

        {feedbackFor !== null && (
          <div className="vs-feedback">
            {/* "Choosing" rather than "Chosen": nothing is recorded until Save, and saying
                otherwise would make Cancel read like it undoes something. */}
            <strong>Choosing take {feedbackFor + 1}. Why does it work?</strong>
            <p>This becomes evidence Mani can reuse, not just a thumbs-up.</p>
            <div className="vs-feedback-tags">
              {PICK_SIGNALS.map((tag) => <button key={tag} type="button" className={tags.includes(tag) ? "is-active" : ""} onClick={() => setTags((old) => old.includes(tag) ? old.filter((x) => x !== tag) : old.concat(tag))}>{tag}</button>)}
            </div>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional: what should Mani remember?" />
            <div className="vs-feedback-actions">
              <button type="button" onClick={() => setFeedbackFor(null)}>Cancel</button>
              <button type="button" className="is-primary" onClick={() => { onPick(generation, feedbackFor, note, tags); setFeedbackFor(null); }}>Save choice</button>
            </div>
          </div>
        )}

        {(generation.images || []).some((image) => image.assetKey) && (
          <div className="vs-qc">
            <button type="button" disabled={reviewing} onClick={async () => {
              setReviewing(true); setReviewError(null);
              try { await onReview(generation, picked ?? 0); } catch (e) { setReviewError(e instanceof Error ? e.message : String(e)); }
              finally { setReviewing(false); }
            }}>{reviewing ? "Reviewing…" : generation.qc ? "Run review again" : "Run AI quality review"}</button>
            {reviewError && <span className="vs-ref-error">{reviewError}</span>}
            {generation.qc && <div className="vs-qc-result"><strong>{generation.qc.summary}</strong>{Object.entries(generation.qc.checks).map(([name, check]) => <span key={name} className={`is-${check.status}`}>{name.replaceAll("_", " ")} · {check.status}{check.issues[0] ? ` — ${check.issues[0]}` : ""}</span>)}</div>}
          </div>
        )}

        {generation.suggestions && generation.suggestions.length > 0 && (
          <div className="vs-suggestions">
            <span>Continue from here</span>
            {generation.suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => onSuggestion(suggestion)}>{suggestion}</button>)}
          </div>
        )}

        {picked === null && !generation.previewExpired && images.length > 1 && (
          <p className="vs-hint">Pick the one that works — that choice is what teaches this brand&apos;s memory.</p>
        )}
        {generation.pickNote && <p className="vs-hint">Chosen because: {generation.pickNote}</p>}
      </div>
    </article>
  );
}

export function ChatThread({ generations, onPick, onUseAsReference, onSuggestion, onReview, onEnhance, busy }: {
  generations: Generation[];
  onPick: (g: Generation, i: number, note?: string, tags?: string[]) => void;
  onUseAsReference: (g: Generation, i: number) => void;
  onSuggestion: (prompt: string) => void;
  onReview: (g: Generation, i: number) => Promise<void>;
  onEnhance: (g: Generation, i: number) => Promise<void>;
  busy: boolean;
}) {
  if (!generations.length && !busy) {
    return (
      <div className="vs-thread vs-thread-empty">
        <p>Describe the image you want, or drop a reference into the box below and say what to change about it.</p>
        <p className="vs-muted vs-muted-sm">
          Everything generated here — the prompt, the model, and which take you choose — is saved into this
          brand&apos;s memory and read by Strategy OS on its next run.
        </p>
      </div>
    );
  }

  return (
    <div className="vs-thread">
      {generations.map((g) => <Round key={g.id} generation={g} onPick={onPick} onUseAsReference={onUseAsReference} onSuggestion={onSuggestion} onReview={onReview} onEnhance={onEnhance} />)}
      {busy && <p className="vs-working">The image job is running and saved. You can refresh safely.</p>}
    </div>
  );
}
