// The conversation: each round is what somebody asked for, followed by what came back.
//
// Two honesty rules run through this file.
//
// An expired preview says so. Provider image URLs die after about an hour (see
// visual-memory.js), and Visual Studio deliberately doesn't host copies. Rendering a dead URL
// would show a broken image and quietly imply the record is damaged — when in fact the prompt,
// the pick and the reasoning are all intact and are the parts that actually compound.
//
// A picked image is marked as picked, by name. The pick is the single most valuable thing this
// app records, so it has to be visible in the thread rather than only in the database.
import type { Generation } from "../lib/types";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Round({ generation, onPick }: { generation: Generation; onPick: (g: Generation, i: number) => void }) {
  const images = generation.images || [];
  const picked = generation.pickedIndex;

  return (
    <article className="vs-round">
      <div className="vs-ask">
        <p>{generation.prompt}</p>
        <span className="vs-meta">{generation.actor} · {when(generation.createdAt)}</span>
      </div>

      <div className="vs-reply">
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
            The previews for this round have expired — provider image links only last about an hour, and
            Visual Studio doesn&apos;t keep copies. The prompt and the choice below are kept permanently.
          </p>
        ) : (
          <div className="vs-images" data-count={images.length}>
            {images.map((image, i) => (
              <figure key={i} className={`vs-image${picked === i ? " is-picked" : ""}`}>
                {image.url
                  ? <img src={image.url} alt={`Option ${i + 1} for: ${generation.prompt}`} loading="lazy" />
                  : <div className="vs-image-missing">No image returned</div>}
                <figcaption>
                  {picked === i ? (
                    <span className="vs-picked-flag">✓ Chosen{generation.pickedBy ? ` by ${generation.pickedBy}` : ""}</span>
                  ) : (
                    <button type="button" onClick={() => onPick(generation, i)}>Use this</button>
                  )}
                  {image.url && (
                    // Download is the only way anything survives, since nothing is hosted —
                    // so it sits on every option, not just the chosen one.
                    <a href={image.url} download={`${generation.id}-${i + 1}.png`} target="_blank" rel="noopener noreferrer">
                      Download
                    </a>
                  )}
                </figcaption>
              </figure>
            ))}
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

export function ChatThread({ generations, onPick, busy }: {
  generations: Generation[];
  onPick: (g: Generation, i: number) => void;
  busy: boolean;
}) {
  if (!generations.length && !busy) {
    return (
      <div className="vs-thread vs-thread-empty">
        <p>Describe the image you want, or start from a reference you paste in below.</p>
        <p className="vs-muted vs-muted-sm">
          Everything generated here — the prompt, the model, and which take you choose — is saved into this
          brand&apos;s memory and read by Strategy OS on its next run.
        </p>
      </div>
    );
  }

  return (
    <div className="vs-thread">
      {generations.map((g) => <Round key={g.id} generation={g} onPick={onPick} />)}
      {busy && <p className="vs-working">Generating…</p>}
    </div>
  );
}
