// The Brand memory sidebar — ported from strategy-ui.js's brandMemory(), part of the
// decorated run-detail workspace that's actually live on Hub today.
import { useState } from "react";
import { useBrandLibrary } from "../lib/useRuns";
import { scanBrandLibrary } from "../lib/api";
import type { StrategyBrand } from "../lib/types";
import { fmtDateTime } from "../lib/format";

interface ApprovedWork { title: string; url: string; month: string; type: string }

// Every stage agent actually reads a brand's Drive folder as reference material (see
// google-drive.js/pipeline.js) — but that's invisible from this screen otherwise, and the
// only other way to check is Netlify's function logs or the Firebase console. This turns
// "is it actually reading our brand folder?" into something anyone can see right here.
// Re-reads the Drive folder on demand. Without this the only way to pick up a newly uploaded
// file is to start a whole strategy run, which is the wrong price for "did that re-export
// work?". Each file is only read once and remembered, so scanning repeatedly is cheap after
// the first time.
function ScanButton({ brandId, scanning }: { brandId: string; scanning: boolean }) {
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = scanning || queued;

  async function handleScan() {
    setError(null);
    setQueued(true);
    try {
      await scanBrandLibrary({ brandId, actor: "Hub" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setQueued(false);
    }
  }

  return (
    <>
      <button
        className="st-btn st-btn-ghost st-btn-sm"
        style={{ marginTop: 8 }}
        disabled={busy}
        onClick={handleScan}
      >
        {busy ? "Scanning Drive…" : "Scan Drive now"}
      </button>
      {error && <div className="st-error-text" style={{ fontSize: 12, marginTop: 4 }}>{error}</div>}
    </>
  );
}

function DriveLibraryStatus({ brandId }: { brandId?: string }) {
  const { library } = useBrandLibrary(brandId);
  // Before anything has ever been indexed there's no library doc at all — but the folder can
  // still be scanned, so offer that rather than showing nothing.
  if (!library) {
    return brandId ? (
      <>
        <div className="st-memory-value" style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
          This brand&apos;s Drive folder hasn&apos;t been read yet.
        </div>
        <ScanButton brandId={brandId} scanning={false} />
      </>
    ) : null;
  }

  if (library.scanning) {
    return (
      <div className="st-memory-value" style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
        ⏳ Reading the Drive folder… new files are read once and remembered, so this is slowest the first time.
      </div>
    );
  }

  if (library.scanError) {
    return (
      <>
        <div className="st-memory-value" style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
          ⚠️ The last scan failed: {library.scanError}
        </div>
        {brandId && <ScanButton brandId={brandId} scanning={false} />}
      </>
    );
  }

  if (library.refreshError) {
    return (
      <div className="st-memory-value" style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
        ⚠️ Drive folder not connected{library.stale ? " (showing the last successful read)" : ""}: {library.refreshError}
      </div>
    );
  }
  // A folder can index perfectly and still hand the agents nothing: files whose text
  // couldn't be read are counted but contribute no content. Saying only "20 files indexed"
  // makes that look like success, so when nothing was readable, say so instead.
  // Only on an explicit zero — a doc that carries no textFileCount at all says nothing about
  // readability, and treating a missing field as "none readable" would cry wolf.
  const fileCount = library.fileCount ?? 0;
  const textFileCount = library.textFileCount;
  if (fileCount > 0 && textFileCount === 0) {
    return (
      <div className="st-memory-value" style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
        ⚠️ {fileCount} file{fileCount === 1 ? "" : "s"} found in {library.folderName || "Drive"}, but none could be read —
        the agents are getting filenames only. Check that the service account has access to the files themselves.
      </div>
    );
  }
  const unread = library.unreadFiles || [];
  return (
    <>
      <div className="st-memory-value" style={{ color: "var(--green)", fontSize: 12, marginTop: 6 }}>
        📁 {fileCount} file{fileCount === 1 ? "" : "s"} indexed from {library.folderName || "Drive"}
        {typeof textFileCount === "number" && textFileCount < fileCount ? ` · ${textFileCount} readable` : ""}
        {library.indexedAt ? ` · ${fmtDateTime(library.indexedAt)}` : ""}
      </div>
      {unread.length > 0 && (
        // Naming them is the point: "3 files unread" tells you there's a problem, but the
        // only way to act on it is knowing which deck is too big to read.
        <details className="st-memory-value" style={{ fontSize: 12, marginTop: 4 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)" }}>
            {unread.length} file{unread.length === 1 ? "" : "s"} the agents can&apos;t read
          </summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--muted)" }}>
            {unread.map((file) => (
              <li key={file.name} style={{ marginBottom: 3 }}>
                <strong style={{ fontWeight: 600 }}>{file.name}</strong> — {file.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {brandId && <ScanButton brandId={brandId} scanning={false} />}
    </>
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
