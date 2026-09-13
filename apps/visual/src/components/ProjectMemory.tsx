// The right-hand panel: what this project has actually accumulated.
//
// This is where both prototypes put a QC panel reading "5 of 6 checks passed · Identity Pass ·
// Palette Pass". Nothing computed any of it. Shipping that would put a confident green tick
// next to a real client asset on the strength of nothing at all, and somebody would rely on
// it — so it isn't here, and it isn't here in a weaker form either.
//
// What IS here is counted from the rounds on screen. Every number below is derived from real
// records, and the panel says plainly that a human does the judging.
import type { Generation, VisualBrand } from "../lib/types";

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
