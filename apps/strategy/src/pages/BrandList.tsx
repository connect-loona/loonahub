// The "Manage brands" list screen — ported from strategy-app.js's soRenderBrandList().
import { useEffect, useState } from "react";
import { useBrands, useBrandDraft } from "../lib/useRuns";
import { discoverBrandFolders, draftBrandFromDrive } from "../lib/api";
import type { DriveBrandFolder, StrategyBrand } from "../lib/types";

// One Drive folder that has no brand in Hub yet. Drafting reads that brand's own guidelines
// and fills in the config, but it is only ever a draft: the reviewer still saves it through
// the normal form, because a brand truth or a prohibited claim is something a client is held
// to, not something to take a model's word for.
function UnconfiguredFolder({ folder, onUseDraft }: {
  folder: DriveBrandFolder;
  onUseDraft: (brandId: string, seed: StrategyBrand) => void;
}) {
  const draft = useBrandDraft(folder.brandId);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `starting` covers the gap between clicking and the draft record appearing. Once the
  // record says it has finished — either way — it's the authority, or the progress note
  // would sit there under a finished draft.
  const settled = draft?.status === "ready" || draft?.status === "failed";
  const busy = !settled && (starting || draft?.status === "drafting");

  async function handleDraft() {
    setError(null);
    setStarting(true);
    try {
      await draftBrandFromDrive({ brandId: folder.brandId, name: folder.name, folderId: folder.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  }

  const ready = draft?.status === "ready" && draft.draft;

  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div>
          <b>{folder.name}</b>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            Not set up yet &middot; <a href={folder.folderUrl} target="_blank" rel="noopener noreferrer">Drive folder</a>
          </div>
        </div>
        {ready ? (
          <button
            className="st-btn st-btn-primary st-btn-sm"
            onClick={() => onUseDraft(folder.brandId, {
              id: folder.brandId,
              name: folder.name,
              driveFolderUrl: folder.folderUrl,
              ...(draft.draft as Record<string, unknown>),
            } as unknown as StrategyBrand)}
          >
            Review &amp; save
          </button>
        ) : (
          <button className="st-btn st-btn-ghost st-btn-sm" disabled={busy} onClick={handleDraft}>
            {busy ? "Reading Drive…" : "Draft from Drive"}
          </button>
        )}
      </div>

      {busy && (
        <div className="st-note" style={{ fontSize: 11, marginTop: 6 }}>
          Reading this brand&apos;s folder and drafting its setup. The first read of a folder is the slow one — after
          that every file is remembered.
        </div>
      )}

      {draft?.status === "failed" && (
        <div className="st-error-text" style={{ fontSize: 11, marginTop: 6 }}>{draft.error}</div>
      )}

      {ready && (
        <div className="st-note" style={{ fontSize: 11, marginTop: 6 }}>
          Drafted from {draft.readFrom?.textFileCount ?? 0} of {draft.readFrom?.fileCount ?? 0} files.
          {(draft.draft as { gaps?: string[] })?.gaps?.length
            ? ` ${(draft.draft as { gaps: string[] }).gaps.length} thing(s) the folder didn't answer — check them before saving.`
            : ""}
          {draft.readFrom?.unreadFiles?.length
            ? ` ${draft.readFrom.unreadFiles.length} file(s) were too large to read.`
            : ""}
        </div>
      )}

      {error && <div className="st-error-text" style={{ fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// Brand folders live in Drive before they're ever brands in Hub — someone makes the folder
// and drops the guidelines in. Surfacing that here means "which brands do we have?" is
// answered from the place the team actually works, rather than depending on someone
// remembering to create a matching record.
function FoundInDrive({ onUseDraft }: { onUseDraft: (brandId: string, seed: StrategyBrand) => void }) {
  const [folders, setFolders] = useState<DriveBrandFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    discoverBrandFolders()
      .then((res) => { if (!cancelled) setFolders(res.folders); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Drive not being connected isn't an error worth shouting about on this screen — the
  // brand list works perfectly well without it.
  if (error || !folders) return null;
  const unconfigured = folders.filter((f) => !f.configured);
  if (unconfigured.length === 0) return null;

  return (
    <div className="st-board">
      <div className="st-board-header">
        Found in Drive <span className="st-tag">{unconfigured.length}</span>
      </div>
      <div className="st-note" style={{ marginBottom: 6 }}>
        These brand folders don&apos;t have a brand set up in Hub yet.
      </div>
      {unconfigured.map((folder) => (
        <UnconfiguredFolder key={folder.id} folder={folder} onUseDraft={onUseDraft} />
      ))}
    </div>
  );
}

export function BrandList({ onBack, onEditBrand, onAddBrand, onUseDraft }: {
  onBack: () => void;
  onEditBrand: (brandId: string) => void;
  onAddBrand: () => void;
  onUseDraft: (brandId: string, seed: StrategyBrand) => void;
}) {
  const { brands, loading } = useBrands();
  const sorted = [...brands].sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return (
    <div>
      <div className="st-section-header" style={{ marginTop: 0 }}>
        <div>
          <button className="st-btn st-btn-ghost st-btn-sm" style={{ marginBottom: 8 }} onClick={onBack}>&larr; All runs</button>
          <div className="st-section-title">Manage brands</div>
        </div>
        <button className="st-btn st-btn-primary" onClick={onAddBrand}>+ Add brand</button>
      </div>

      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">Brands <span className="st-tag">{sorted.length}</span></div>
        {loading ? (
          <div className="st-note">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="st-note">No brands configured yet — add the first one.</div>
        ) : (
          sorted.map((b) => (
            <div key={b.id} className="pf-absrow" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
              <div>
                <b>{b.name}</b>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{(b.category as string) || "—"} &middot; {b.id}</div>
              </div>
              <button className="st-btn st-btn-ghost st-btn-sm" onClick={() => onEditBrand(b.id)}>Edit</button>
            </div>
          ))
        )}
      </div>

      <FoundInDrive onUseDraft={onUseDraft} />
    </div>
  );
}
