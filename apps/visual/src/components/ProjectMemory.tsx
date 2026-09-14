// The right-hand panel: what this project has actually accumulated.
//
// This is where both prototypes put a QC panel reading "5 of 6 checks passed · Identity Pass ·
// Palette Pass". Nothing computed any of it. Shipping that would put a confident green tick
// next to a real client asset on the strength of nothing at all, and somebody would rely on
// it — so it isn't here, and it isn't here in a weaker form either.
//
// What IS here is counted from the rounds on screen. Every number below is derived from real
// records, and the panel says plainly that a human does the judging.
import { useState } from "react";
import { askMani } from "../lib/api";
import type { Generation, VisualBrand } from "../lib/types";

// 🧠 Mani, in the room where the work is being made.
//
// He is already in Hub and in Strategy OS. Putting him here is not a third Mani — it is the
// same endpoint and the same composed memory. What changes is that the question can be asked
// at the moment it actually occurs to somebody: halfway through a chat, before typing the next
// prompt, when the useful question is "have we already tried this for them?"
//
// And the memory he reads includes THIS: every round generated in Visual Studio, who wrote the
// prompt, and which take was chosen (see visual-memory.js). So the studio is not just a place
// to ask him from — it is one of the things he knows about.
//
// The answer that matters most is the one that says nothing is recorded. Mani refuses to guess
// (see mani.js), and that refusal is rendered as a legitimate answer rather than an error,
// because a confident invention about a client is the outcome worth engineering against.
function AskMani({ brand }: { brand: VisualBrand }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [gap, setGap] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const asked = question.trim();
    if (!asked || busy) return;
    setBusy(true);
    setAnswer(null);
    setGap(null);
    setError(null);
    try {
      const result = await askMani({ brandId: brand.id, question: asked });
      if (result.nothingRecorded) setGap(result.detail || "Nothing in this brand's memory answers that.");
      else setAnswer(result.answer || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vs-mani">
      <p className="vs-section-label">🧠 Ask Mani</p>
      <p className="vs-muted vs-muted-sm">
        Everything Loona has recorded about {brand.name} — including every round made here, and who made it.
        He answers from that only, and says so when it doesn&apos;t cover your question.
      </p>
      <textarea
        className="vs-mani-input"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Have we shot this angle before? What did they reject last time?"
        rows={2}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
      />
      <button type="button" className="vs-mani-ask" disabled={busy || !question.trim()} onClick={() => void submit()}>
        {busy ? "Remembering…" : "Ask"}
      </button>
      {answer && <div className="vs-mani-answer">{answer}</div>}
      {/* Deliberately styled apart from an answer: an empty result must never read like a
          finding somebody could act on. */}
      {gap && <div className="vs-mani-gap">Nothing recorded. {gap}</div>}
      {error && <div className="vs-mani-error">{error}</div>}
    </div>
  );
}

export function ProjectMemory({ brand, generations }: { brand: VisualBrand | null; generations: Generation[] }) {
  if (!brand) return <aside className="vs-memory" />;

  const picked = generations.filter((g) => g.pickedIndex !== null && g.pickedIndex !== undefined);
  const awaiting = generations.filter((g) => (g.pickedIndex === null || g.pickedIndex === undefined) && !g.previewExpired);
  // The rules that shaped the most recent round — the live answer to "what is being enforced
  // right now?", rather than a static list of switches.
  const latestRules = generations.length ? (generations[generations.length - 1].appliedRules || []) : [];

  return (
    <aside className="vs-memory">
      <h2>Project memory</h2>
      <p className="vs-muted vs-muted-sm">
        Everything in this chat is saved to {brand.name}&apos;s memory in Loona Brain, and read by Strategy OS
        on its next run.
      </p>

      <div className="vs-stats">
        <div><b>{generations.length}</b><span>rounds in this chat</span></div>
        <div><b>{picked.length}</b><span>chosen</span></div>
      </div>

      {awaiting.length > 0 && (
        <p className="vs-hint">
          {awaiting.length} round{awaiting.length === 1 ? "" : "s"} with nothing chosen yet. Only the takes you pick
          teach the brand&apos;s visual direction — an unpicked round is kept, but not taught.
        </p>
      )}

      <p className="vs-section-label">Rules applied to the last image</p>
      {latestRules.length ? (
        <ul className="vs-rule-list">
          {latestRules.map((rule) => (
            <li key={rule.key}>
              {rule.label}
              <span>{rule.source === "brand" ? `from ${brand.name}'s guidelines` : "always applied"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vs-muted vs-muted-sm">Nothing generated in this chat yet.</p>
      )}

      <AskMani brand={brand} />

      <p className="vs-section-label">Review</p>
      {/* Said plainly, because the alternative — a fabricated pass/fail — is the one thing
          this panel must never do. */}
      <p className="vs-muted vs-muted-sm">
        Nothing here is automatically checked. A person decides which image is usable, and that choice is
        what gets recorded.
      </p>
    </aside>
  );
}
