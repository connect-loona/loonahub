// The right-hand panel: what this project has actually accumulated.
//
// Every number is derived from a real record. AI review is shown only after the review
// endpoint has actually inspected a stored image and its available evidence.
import type { Generation, VisualBrand } from "../lib/types";

export function ProjectMemory({ brand, generations }: { brand: VisualBrand | null; generations: Generation[] }) {
  if (!brand) return <aside className="vs-memory" />;

  const picked = generations.filter((g) => g.pickedIndex !== null && g.pickedIndex !== undefined);
  const awaiting = generations.filter((g) => (g.pickedIndex === null || g.pickedIndex === undefined) && !g.previewExpired);
  // The rules that shaped the most recent round — the live answer to "what is being enforced
  // right now?", rather than a static list of switches.
  const latestRules = generations.length ? (generations[generations.length - 1].appliedRules || []) : [];
  const reviewed = generations.filter((g) => g.qc).length;

  return (
    <aside className="vs-memory">
      <h2>Mani · Brand memory agent</h2>
      <p className="vs-muted vs-muted-sm">
        Mani reads {brand.name}&apos;s stored choices, feedback and visual reviews when answering the team or supporting Strategy OS.
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
      <p className="vs-muted vs-muted-sm">
        A person decides which image is usable; AI review is supporting evidence, never approval. {reviewed ? `${reviewed} round${reviewed === 1 ? " has" : "s have"} been reviewed.` : "No AI quality review has been run in this chat yet."}
      </p>
    </aside>
  );
}
