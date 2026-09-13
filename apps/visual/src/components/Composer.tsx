// The composer. Deliberately small: a prompt, how many takes, and what shape.
//
// What's missing is missing on purpose. The prototypes this is based on offered "composition
// match 72%" and "art-direction strength 84%" sliders; no image API this app talks to accepts
// anything of the kind, so those controls would have been sent and silently ignored. A control
// that does nothing is worse than no control, because people plan around it.
//
// Sizes are named for what they're for rather than in pixels — somebody making a reel cover
// shouldn't have to remember 1024x1536. The names match image-providers.js's own presets.
import { useState } from "react";

const SIZES = [
  { key: "portrait", label: "Portrait (reel, story)" },
  { key: "square", label: "Square (feed)" },
  { key: "landscape", label: "Landscape (banner)" },
];

export function Composer({ onSend, busy, disabled }: {
  onSend: (prompt: string, count: number, size: string) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(2);
  const [size, setSize] = useState("portrait");

  function submit() {
    const clean = prompt.trim();
    if (!clean || busy || disabled) return;
    onSend(clean, count, size);
    setPrompt("");
  }

  return (
    <div className="vs-composer">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={disabled ? "Pick a brand to start" : "Describe the image, or what to change about the last one…"}
        rows={3}
        disabled={disabled}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line — the convention every chat tool uses,
          // and these prompts are usually one or two sentences.
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
        }}
      />
      <div className="vs-composer-foot">
        <label>
          Takes
          <select value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={disabled}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          Shape
          <select value={size} onChange={(e) => setSize(e.target.value)} disabled={disabled}>
            {SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <button type="button" className="vs-send" onClick={submit} disabled={busy || disabled || !prompt.trim()}>
          {busy ? "Generating…" : "Generate"}
        </button>
      </div>
    </div>
  );
}
