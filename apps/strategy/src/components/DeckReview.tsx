// The deck stage's review screen — ported from strategy-app.js's deckReviewHtml(). The
// Owner/Production status fields are the one editable part (per page), now going through
// strategy-deck-page-update.js instead of the legacy Hub's direct Firebase write.
import { useState } from "react";
import { PRODUCTION_STATUSES, PRODUCTION_STATUS_LABELS, type DeckCheckpoint, type StageState, type StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { updateDeckPage } from "../lib/api";

function DeckPageRow({ runId, pageIndex, page, onError }: { runId: string; pageIndex: number; page: DeckCheckpoint["pages"][number]; onError: (msg: string) => void }) {
  const [owner, setOwner] = useState(page.owner || "");
  const [status, setStatus] = useState(page.productionStatus);

  async function commitOwner() {
    if (owner === (page.owner || "")) return;
    try {
      await updateDeckPage({ runId, pageIndex, field: "owner", value: owner });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  async function changeStatus(next: string) {
    setStatus(next as typeof status);
    try {
      await updateDeckPage({ runId, pageIndex, field: "productionStatus", value: next });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "12px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Page {page.pageNumber} &middot; {page.assetId} &middot; {page.format}</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>{page.portfolioAndSku}</div>
      </div>
      <div style={{ margin: "6px 0", fontStyle: "italic" }}>&ldquo;{page.idea}&rdquo;</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Hook:</b> {page.hook}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Creative copy:</b> {page.creativeCopy}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Direction:</b> {page.direction}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Shot list:</b> {page.shotList}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}><b>Captions:</b> {page.captionOne} / {page.captionTwo} / {page.captionThree}</div>
      {page.referenceImageUrl && (
        <div style={{ fontSize: 12 }}>
          <a href={page.referenceImageUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Reference image</a>
          {page.referenceCredit ? <> &middot; {page.referenceCredit}</> : null}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <input
          className="st-form-control"
          style={{ flex: 1, fontSize: 12 }}
          placeholder="Owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          onBlur={commitOwner}
        />
        <select className="st-form-control" style={{ width: 170, fontSize: 12 }} value={status} onChange={(e) => changeStatus(e.target.value)}>
          {PRODUCTION_STATUSES.map((s) => <option key={s} value={s}>{PRODUCTION_STATUS_LABELS[s]}</option>)}
        </select>
      </div>
    </div>
  );
}

export function DeckReview({ run, stage }: { run: StrategyRun; stage: StageState }) {
  const d = stage.checkpoint as DeckCheckpoint;
  const readOnly = stage.status === "approved";
  const approval = run.approvals?.["deck-builder"];
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <div className="st-board" style={{ marginTop: 0 }}>
        <div className="st-board-header">{d.title || "Deck"} <span className="st-tag">{(d.pages || []).length} pages</span></div>
        {d.subtitle && <div className="st-note" style={{ marginBottom: 0 }}>{d.subtitle}</div>}
      </div>

      <div className="st-board">
        <div className="st-board-header">Pages</div>
        {error && <div className="st-error-text">{error}</div>}
        {(d.pages || []).map((p, i) => (
          <DeckPageRow key={p.assetId} runId={run.runId} pageIndex={i} page={p} onError={setError} />
        ))}
      </div>

      {readOnly ? (
        // The Open Canva deck / Download deck / Create team tasks actions live in the
        // "Your next action" card once the deck is approved — not duplicated here.
        <div className="st-note">Deck approved {fmtDateTime(approval?.decidedAt)} by {approval?.decidedBy}.</div>
      ) : (
        <div className="st-note">Use the "Your next action" card to approve this or send it back with notes.</div>
      )}
    </>
  );
}
