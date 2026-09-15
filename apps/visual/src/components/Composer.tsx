// The composer: a prompt, the references it works from, how many takes, and what shape.
//
// References are the part that makes this usable rather than a novelty. Every one of the real
// ChatGPT threads this replaces starts the same way — upload the base scene, upload the exact
// product, then say "keep the label, change the background". Text-to-image alone can't do
// that, because there's no way to hand it the thing that must stay identical.
//
// What's deliberately absent: strength sliders. The prototypes offered "composition match 72%"
// and "art-direction strength 84%"; no image API this app talks to accepts anything of the
// kind, so those would be sent and silently ignored. A control that does nothing is worse than
// no control, because people plan around it.
import { useEffect, useRef, useState } from "react";
import type { PendingReference } from "../lib/types";

// Named by ratio, and by the placement the ratio is actually for.
//
// These used to be "Portrait (reel, story)", "Square (feed)" and "Landscape (banner)" — which
// generated 2:3, 1:1 and 3:2. Only the square was honest: a reel is 9:16, not 2:3, and a banner
// is 16:9, not 3:2. Nothing cropped afterwards, so the wrong shape is what got posted and the
// platform cropped it however it liked. Keep the ratio in the label so that can't quietly
// happen again. Must stay in step with SHAPES in netlify/functions/lib/strategy/image-shapes.js.
const SIZES = [
  { key: "9x16", label: "Story / Reel (9:16)" },
  { key: "4x5", label: "Feed portrait (4:5)" },
  { key: "3x4", label: "Portrait (3:4)" },
  { key: "1x1", label: "Square (1:1)" },
  { key: "16x9", label: "Landscape (16:9)" },
];

// Matches MAX_REFERENCES / MAX_REFERENCE_BYTES in image-providers.js. Checked here too so an
// oversized file is refused before it's read and posted, rather than after a slow upload.
const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;

// What a reference is FOR. Six months later "2 references" says nothing, but "kept the
// product, took the lighting from the second" explains the entire round — and it's the half
// that reaches Loona Brain.
const ROLES = ["Product identity", "Composition", "Lighting", "Style", "Background"];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export function Composer({
  onSend, busy, disabled, references, setReferences, suggestedPrompt, onSuggestionUsed, seedShape, onSeedUsed,
}: {
  onSend: (prompt: string, count: number, size: string, quality: string, provider: "openai" | "magnific") => void;
  busy: boolean;
  disabled: boolean;
  references: PendingReference[];
  setReferences: (next: PendingReference[]) => void;
  suggestedPrompt?: string | null;
  onSuggestionUsed?: () => void;
  // Carries a prior round's shape and quality in when a follow-up starts from it — a designer
  // continuing a 9:16 story shouldn't have to remember to reselect 9:16 on every turn just
  // because the composer defaults to something else. Either field may be absent (an old record
  // has no stored shape), so each is applied independently rather than as one all-or-nothing
  // pair.
  seedShape?: { size?: string | null; quality?: string | null } | null;
  onSeedUsed?: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(2);
  // 4:5 rather than the story cut: it is the highest-reach feed placement, and it's the one
  // most rounds here are actually for.
  const [size, setSize] = useState("4x5");
  // Draft by default, on purpose. Most rounds are somebody working out what they want, and
  // generating four takes at production quality to reject three of them is how this gets both
  // expensive and slow.
  const [quality, setQuality] = useState("draft");
  const [provider, setProvider] = useState<"openai" | "magnific">("openai");
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!suggestedPrompt) return;
    setPrompt(suggestedPrompt);
    onSuggestionUsed?.();
  }, [suggestedPrompt, onSuggestionUsed]);

  useEffect(() => {
    if (!seedShape) return;
    if (seedShape.size) setSize(seedShape.size);
    if (seedShape.quality) setQuality(seedShape.quality);
    onSeedUsed?.();
  }, [seedShape, onSeedUsed]);

  async function addFiles(files: FileList | File[]) {
    setFileError(null);
    const incoming = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!incoming.length) return;
    const room = MAX_REFERENCES - references.length;
    if (room <= 0) {
      setFileError(`Up to ${MAX_REFERENCES} references at a time.`);
      return;
    }
    const next: PendingReference[] = [];
    for (const file of incoming.slice(0, room)) {
      if (file.size > MAX_REFERENCE_BYTES) {
        // Caught here rather than after a slow upload that fails as an opaque 502.
        setFileError(`${file.name} is ${Math.round(file.size / (1024 * 1024))}MB — the limit is ${Math.round(MAX_REFERENCE_BYTES / (1024 * 1024))}MB.`);
        continue;
      }
      try {
        next.push({ dataUrl: await readAsDataUrl(file), name: file.name, role: "", file, contentType: file.type });
      } catch (e) {
        setFileError(e instanceof Error ? e.message : String(e));
      }
    }
    if (incoming.length > room) setFileError(`Only the first ${room} were added — up to ${MAX_REFERENCES} at a time.`);
    if (next.length) setReferences([...references, ...next]);
  }

  function submit() {
    const clean = prompt.trim();
    if (!clean || busy || disabled) return;
    onSend(clean, provider === "magnific" ? 1 : count, size, quality, provider);
    setPrompt("");
  }

  return (
    <div
      className="vs-composer"
      // Dropping and pasting are how people actually get an image out of Slack or a folder and
      // into a prompt; making them hunt for a file picker every time is friction they'd feel
      // on every single round.
      onDragOver={(e) => { if (!disabled) e.preventDefault(); }}
      onDrop={(e) => { if (disabled) return; e.preventDefault(); void addFiles(e.dataTransfer.files); }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files || []);
        if (files.length) { e.preventDefault(); void addFiles(files); }
      }}
    >
      {references.length > 0 && (
        <div className="vs-refs">
          {references.map((reference, i) => (
            <div key={i} className="vs-ref">
              <img src={reference.dataUrl} alt={reference.name || `Reference ${i + 1}`} />
              <div className="vs-ref-body">
                <span className="vs-ref-name" title={reference.name}>{reference.name || `Reference ${i + 1}`}</span>
                {reference.warnings?.map((warning) => <span key={warning} className="vs-ref-warning">{warning}</span>)}
                {/* Free text, with the common answers offered — the role is what makes this
                    record readable later, but a fixed list would be wrong the first time
                    somebody needs "keep the model's face". */}
                <input
                  className="vs-ref-role"
                  list="vs-ref-roles"
                  placeholder="What to take from it…"
                  value={reference.role}
                  onChange={(e) => setReferences(references.map((r, j) => (j === i ? { ...r, role: e.target.value } : r)))}
                />
              </div>
              <button
                type="button"
                className="vs-ref-remove"
                aria-label={`Remove ${reference.name || `reference ${i + 1}`}`}
                onClick={() => setReferences(references.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <datalist id="vs-ref-roles">
            {ROLES.map((role) => <option key={role} value={role} />)}
          </datalist>
        </div>
      )}

      {fileError && <div className="vs-ref-error">{fileError}</div>}

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={disabled
          ? "Pick a brand to start"
          : references.length
            ? "What should change? The references above stay as they are unless you say otherwise…"
            : "Describe the image, or drop in a reference to work from…"}
        rows={3}
        disabled={disabled}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line — the convention every chat tool uses,
          // and these prompts are usually one or two sentences.
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
        }}
      />

      <div className="vs-composer-foot">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => { void addFiles(e.target.files || []); e.target.value = ""; }}
        />
        <button type="button" className="vs-attach" disabled={disabled} onClick={() => fileInput.current?.click()}>
          + Reference
        </button>
        <label>
          Create with
          <select value={provider} onChange={(e) => { const next = e.target.value as "openai" | "magnific"; setProvider(next); if (next === "magnific") setCount(1); }} disabled={disabled}>
            <option value="openai">ChatGPT</option>
            <option value="magnific">Magnific Mystic</option>
          </select>
        </label>
        <label>
          Takes
          <select value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={disabled || provider === "magnific"}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {provider === "magnific" && <span className="vs-provider-note">Mystic creates one paid take at a time.</span>}
        <label>
          Quality
          <select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={disabled}>
            <option value="draft">Draft — fast</option>
            <option value="final">Final — production</option>
          </select>
        </label>
        <label>
          Shape
          <select value={size} onChange={(e) => setSize(e.target.value)} disabled={disabled}>
            {SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <button type="button" className="vs-send" onClick={submit} disabled={busy || disabled || !prompt.trim()}>
          {busy ? "Generating…" : references.length ? "Edit" : "Generate"}
        </button>
      </div>
    </div>
  );
}
