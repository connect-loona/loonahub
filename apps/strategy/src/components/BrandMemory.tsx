// The Brand memory sidebar — ported from strategy-ui.js's brandMemory(), part of the
// decorated run-detail workspace that's actually live on Hub today.
import { useBrandLibrary } from "../lib/useRuns";
import type { StrategyBrand } from "../lib/types";
import { fmtDateTime } from "../lib/format";

interface ApprovedWork { title: string; url: string; month: string; type: string }

// Every stage agent actually reads a brand's Drive folder as reference material (see
// google-drive.js/pipeline.js) — but that's invisible from this screen otherwise, and the
// only other way to check is Netlify's function logs or the Firebase console. This turns
// "is it actually reading our brand folder?" into something anyone can see right here.
function DriveLibraryStatus({ brandId }: { brandId?: string }) {
  const { library } = useBrandLibrary(brandId);
  if (!library) return null; // no stage has run for this brand yet — nothing to report

  if (library.refreshError) {
    return (
      <div className="st-memory-value" style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
        ⚠️ Drive folder not connected{library.stale ? " (showing the last successful read)" : ""}: {library.refreshError}
      </div>
    );
  }
  return (
    <div className="st-memory-value" style={{ color: "var(--green)", fontSize: 12, marginTop: 6 }}>
      📁 {library.fileCount ?? 0} file{library.fileCount === 1 ? "" : "s"} indexed from {library.folderName || "Drive"}
      {library.indexedAt ? ` · ${fmtDateTime(library.indexedAt)}` : ""}
    </div>
  );
}

export function BrandMemory({ brand }: { brand: StrategyBrand | undefined }) {
  const b = (brand || {}) as StrategyBrand & { oneLineTruth?: string; audiences?: { description: string }[]; approvedWork?: ApprovedWork[]; driveFolderUrl?: string };
  const works = (b.approvedWork || []).slice().sort((a, b2) => (b2.month || "").localeCompare(a.month || "")).slice(0, 4);
  const audienceLine = (b.audiences || []).map((a) => a.description).slice(0, 2).join(" · ") || "Not configured";

  return (
    <aside className="st-workspace-side">
      <div className="st-board-header" style={{ marginBottom: 0 }}>Brand memory</div>
      <div className="st-memory-label">Brand truth</div>
      <div className="st-memory-value">{b.oneLineTruth || "Add the brand truth in Manage brands."}</div>
      <div className="st-memory-label">Audience</div>
      <div className="st-memory-value">{audienceLine}</div>
      <div className="st-memory-label">Approved work</div>
      {works.length ? (
        works.map((w, i) => (
          <a key={i} className="st-memory-link" href={w.url} target="_blank" rel="noopener noreferrer">
            {w.title}
            <span>{w.month} · {w.type}</span>
          </a>
        ))
      ) : (
        <div className="st-memory-value" style={{ color: "var(--muted)" }}>Add final decks, designs and videos in Manage brands.</div>
      )}
      <DriveLibraryStatus brandId={b.id} />
      {b.driveFolderUrl && (
        <a className="st-btn st-btn-ghost" href={b.driveFolderUrl} target="_blank" rel="noopener noreferrer" style={{ marginTop: 14, width: "100%", textAlign: "center", display: "block", textDecoration: "none" }}>
          Open brand folder
        </a>
      )}
    </aside>
  );
}
