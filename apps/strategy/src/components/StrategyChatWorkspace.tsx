import { useEffect, useMemo, useState } from "react";
import { useAllHubBrands, useBrands, useRun, useRuns, type HubBrandOption } from "../lib/useRuns";
import { askMani, discardConcept, proposeConcept, retryStage, saveStrategyChatMessage, startRun, toggleAssetLock } from "../lib/api";
import { listenPath } from "../lib/firebase";
import type { CopyCheckpoint, StrategyAsset, StrategyBrand, StrategyCheckpoint, StrategyRun } from "../lib/types";
import { CampaignBrief, CampaignRunChat } from "./CampaignPlanning";

type Mode = "home" | "monthly" | "campaign" | "mani";
type ChatMessage = { role: "user" | "assistant"; text: string; actor?: string; createdAt?: string };

const DEFAULT_COUNTS = { reel: 6, carousel: 4, static: 3 };

function initials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function tint(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 42% 34%)`;
}

function monthLabel(month?: string) {
  if (!month) return "New strategy chat";
  const [year, value] = month.split("-").map(Number);
  return Number.isFinite(year) && Number.isFinite(value)
    ? new Date(year, value - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : month;
}

function strategyAssets(run: StrategyRun | null): StrategyAsset[] {
  const checkpoint = run?.stages.strategy?.checkpoint as StrategyCheckpoint | undefined;
  return Array.isArray(checkpoint?.assets) ? checkpoint.assets : [];
}

function captionFor(run: StrategyRun | null, assetId: string): string | null {
  const checkpoint = run?.stages.copy?.checkpoint as CopyCheckpoint | undefined;
  const asset = checkpoint?.assets?.find((item) => item.assetId === assetId);
  const caption = asset?.captions?.[0]?.copy;
  return caption ? String(caption) : null;
}

function stageStatus(run: StrategyRun | null, stage: string) {
  return run?.stages[stage as keyof StrategyRun["stages"]]?.status || "queued";
}

// The Mani panel's "Plan status" line used to always read the monthly pipeline's concept
// count, so a campaign run — which never populates strategy.checkpoint.assets — sat at
// "0 concepts available" for its entire lifetime, through locking an identity, a thought,
// a route and building assets. This mirrors the same locked-so-far state CampaignRunChat
// itself renders, just condensed to one line.
function planStatusText(run: StrategyRun | undefined): string {
  if (!run) return "No active plan";
  if (run.runType === "campaign") {
    const campaign = run.campaign || {};
    const assetCount = campaign.assets?.length || 0;
    if (assetCount) return `${assetCount} campaign asset${assetCount === 1 ? "" : "s"} ready`;
    if (campaign.lockedRoute) return "Creative route locked · building assets";
    if (campaign.lockedThought) return "Campaign thought locked · choosing a route";
    if (campaign.lockedIdentity) return "Campaign identity locked · developing the thought";
    return "Campaign identities in progress";
  }
  const conceptCount = strategyAssets(run).length;
  return `${conceptCount} concept${conceptCount === 1 ? "" : "s"} available`;
}

function StatusLine({ run }: { run: StrategyRun | null }) {
  if (!run) return null;
  const research = stageStatus(run, "research");
  const strategy = stageStatus(run, "strategy");
  if (research === "running" || research === "queued") return <div className="sc-status">Research is happening in the background <span className="sc-dots">•••</span></div>;
  if (research.includes("failed")) return <div className="sc-status is-error">Research needs attention before concepts can be shown.</div>;
  if (strategy === "running" || strategy === "queued") return <div className="sc-status">Turning the research into concepts <span className="sc-dots">•••</span></div>;
  return <div className="sc-status is-ready">Research is ready · concepts are appearing below</div>;
}

function BrandSidebar({ brands, active, runs, open, onBrand, onNew, onOpen }: {
  brands: HubBrandOption[];
  active: HubBrandOption | undefined;
  runs: StrategyRun[];
  onBrand: (brand: HubBrandOption) => void;
  onNew: () => void;
  onOpen: (runId: string) => void;
  open?: boolean;
}) {
  return <aside className={`vs-sidebar sc-sidebar${open ? " is-open" : ""}`}>
    <div className="vs-logo"><a href="/"><span className="sc-wordmark">LOONA</span></a></div>
    <nav className="vs-topnav">
      <a href="/">Hub</a>
      <span className="is-active">Strategy OS</span>
      <a href="/visual/">Visual Studio</a>
    </nav>
    <p className="vs-section-label">Brand projects</p>
    <div className="vs-projects">
      {brands.map((brand) => {
        const brandRuns = runs.filter((run) => run.brandId === brand.id).slice(0, 8);
        const isActive = active?.id === brand.id;
        return <div key={brand.id} className={`vs-project-block${isActive ? " is-open" : ""}`}>
          <button type="button" className={`vs-project${isActive ? " is-active" : ""}`} onClick={() => onBrand(brand)}>
            <span className="vs-project-icon" style={{ background: tint(brand.id) }}>{initials(brand.name)}</span>
            <span className="vs-project-name">{brand.name}</span>
          </button>
          {isActive && <div className="vs-chatlist">
            <button type="button" className="vs-newchat" onClick={onNew}>+ New strategy chat</button>
            {brandRuns.map((run) => <button key={run.runId} type="button" className="vs-chatlink" onClick={() => onOpen(run.runId)}>
              {run.runType === "campaign" ? (run.campaign?.lockedIdentity?.name || run.campaign?.brief?.occasion || "Campaign planning") : monthLabel(run.month)}
              <span>{run.status === "complete" ? "Complete" : (run.status || "In progress")}</span>
            </button>)}
            {!brandRuns.length && <span className="vs-muted vs-muted-sm">No strategy chats yet.</span>}
          </div>}
        </div>;
      })}
    </div>
    <div className="vs-spacer" />
    <a className="vs-usage-link" href="/visual/">API usage</a>
  </aside>;
}

function Welcome({ onMode }: { onMode: (mode: Mode) => void }) {
  return <div className="sc-welcome">
    <p className="sc-eyebrow">Strategy OS</p>
    <h2>What are we building today?</h2>
    <p className="sc-muted">A conversation with the brand, its memory and the Loona strategy agents.</p>
    <div className="sc-suggestions">
      <button type="button" onClick={() => onMode("monthly")}><b>Monthly planning</b><span>Build this month’s content one concept at a time.</span></button>
      <button type="button" onClick={() => onMode("campaign")}><b>Campaign planning</b><span>Shape a launch, event or campaign through conversation.</span></button>
      <button type="button" onClick={() => onMode("mani")}><b>Chat with Mani</b><span>Ask what the brand has learned, approved or rejected.</span></button>
    </div>
  </div>;
}

function Brief({ mode, brand, actor, onStarted, onCancel }: { mode: "monthly" | "campaign"; brand: HubBrandOption; actor: string; onStarted: (runId: string) => void; onCancel: () => void }) {
  const [counts, setCounts] = useState(DEFAULT_COUNTS);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  async function submit() {
    if (mode === "campaign" && !notes.trim()) { setError("Tell me what this campaign is for before we begin."); return; }
    setBusy(true); setError(null);
    try {
      const { runId } = await startRun({
        brandId: brand.id, month, actor, runType: mode, chatMode: true,
        deliverablesOverride: mode === "monthly" ? counts : undefined,
        sourceContext: notes.trim() ? [notes.trim()] : [],
      });
      onStarted(runId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  return <div className="sc-brief">
    <div className="sc-user-bubble">{mode === "monthly" ? "Let’s plan this month." : "Let’s plan a campaign."}</div>
    <div className="sc-assistant-block">
      <p>Good. I’ll use {brand.name}&apos;s memory and run the research privately in the background.</p>
      {mode === "monthly" ? <>
        <p>How many creatives are we planning this month?</p>
        <div className="sc-count-grid">
          {(["reel", "carousel", "static"] as const).map((key) => <label key={key}><span>{key === "reel" ? "Reels" : key === "carousel" ? "Carousels" : "Statics"}</span><input type="number" min={0} value={counts[key]} onChange={(e) => setCounts({ ...counts, [key]: Math.max(0, Number(e.target.value) || 0) })} /></label>)}
        </div>
      </> : <p>Tell me what this campaign is for, what it needs to achieve and anything that must be included.</p>}
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={mode === "monthly" ? "Important dates, launches, offers or priorities…" : "Campaign objective, launch, audience and mandatory messages…"} />
      {error && <p className="sc-error">{error}</p>}
      <div className="sc-actions"><button type="button" className="sc-secondary" onClick={onCancel}>Back</button><button type="button" className="sc-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Starting research…" : "Submit and begin research"}</button></div>
    </div>
  </div>;
}

function ConceptCard({ asset, caption, candidate, index, total, logged, busy, onRefine, onLog, onReject }: { asset: StrategyAsset; caption?: string | null; candidate?: { status?: string; detail?: string; candidate?: Partial<StrategyAsset> } | null; index: number; total: number; logged: boolean; busy: boolean; onRefine: (value: string) => void; onLog: () => void; onReject: (value: string) => void }) {
  const [refining, setRefining] = useState(false);
  const [draft, setDraft] = useState("");
  return <div className="sc-concept-wrap">
    <div className="sc-concept-meta">Concept {index + 1} of {total} · {asset.format}</div>
    <article className={`sc-concept${logged ? " is-logged" : ""}`}>
      <h3>{asset.conceptName}</h3>
      {candidate?.status === "running" && <p className="sc-status">The refined version is being written <span className="sc-dots">•••</span></p>}
      {candidate?.status === "failed" && <p className="sc-error">The refinement could not be completed: {candidate.detail || "try again"}</p>}
      {candidate?.status === "ready" && candidate.candidate && <div className="sc-candidate"><p className="sc-candidate-label">Refined candidate</p><h4>{candidate.candidate.conceptName || asset.conceptName}</h4><p>{candidate.candidate.hook || asset.hook}</p><button type="button" className="sc-primary" onClick={onLog}>Use refined version</button></div>}
      <div className="sc-pills"><span>{asset.portfolioId || "Brand portfolio"}</span><span>{logged ? "Logged" : "Awaiting review"}</span></div>
      <dl><div><dt>Tension</dt><dd>{asset.tension}</dd></div><div><dt>Hook</dt><dd>“{asset.hook}”</dd></div><div><dt>Send to</dt><dd>{asset.sendTo}</dd></div></dl>
      {logged && caption && <div className="sc-caption"><dt>Caption</dt><p>{caption}</p></div>}
      {!logged && <div className="sc-actions"><button type="button" className="sc-secondary" onClick={() => setRefining(!refining)}>Refine</button><button type="button" className="sc-secondary" onClick={() => onReject(prompt("Why are we rejecting this concept?") || "Rejected by team")}>Reject</button><button type="button" className="sc-primary" disabled={busy} onClick={onLog}>{busy ? "Logging…" : "Use this"}</button></div>}
      {logged && <p className="sc-logged-note">This concept and its caption are saved to the monthly plan.</p>}
      {refining && <div className="sc-refine"><textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What should change?" /><button type="button" className="sc-primary" disabled={!draft.trim()} onClick={() => { onRefine(draft.trim()); setDraft(""); setRefining(false); }}>Send refinement</button></div>}
    </article>
  </div>;
}

function ManiChat({ brand }: { brand: HubBrandOption }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask() { if (!question.trim() || busy) return; setBusy(true); setAnswer(null); try { const result = await askMani({ brandId: brand.id, question: question.trim() }); setAnswer(result.answer || result.detail || "Nothing recorded for this brand yet."); } catch (e) { setAnswer(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  return <div className="sc-mani-chat"><div className="sc-assistant-block"><p>Ask me anything about what {brand.name} has learned.</p></div>{answer && <div className="sc-assistant-block sc-answer"><p>{answer}</p></div>}<div className="sc-input-row"><textarea value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }} placeholder="What has this brand rejected before?" /><button type="button" className="sc-primary" disabled={busy || !question.trim()} onClick={() => void ask()}>{busy ? "Asking…" : "Ask Mani"}</button></div></div>;
}

function RunChat({ runId, actor }: { runId: string; actor: string }) {
  const { run } = useRun(runId);
  const assets = useMemo(() => strategyAssets(run), [run]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [logged, setLogged] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [finished, setFinished] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const asset = assets[cursor];
  // Whichever of the two stages a fresh concept depends on actually failed — unlike the
  // campaign flow's per-step retry buttons, this used to leave a failed research or
  // strategy stage with no way back into the chat at all beyond "check the run status".
  const failedStage = stageStatus(run, "research").includes("failed") ? "research"
    : stageStatus(run, "strategy").includes("failed") ? "strategy" : null;
  async function retryFailedStage() {
    if (!failedStage || retrying) return;
    setRetrying(true); setRetryError(null);
    try { await retryStage({ runId, stage: failedStage, actor }); }
    catch (e) { setRetryError(e instanceof Error ? e.message : String(e)); }
    finally { setRetrying(false); }
  }
  useEffect(() => {
    const locks = run?.stages.strategy?.locks || {};
    setLogged(Object.keys(locks));
  }, [run]);
  useEffect(() => listenPath<Record<string, ChatMessage>>(`strategy_runs/${runId}/chatMessages`, (value) => {
    setMessages(Object.values(value || {}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
  }), [runId]);
  async function record(role: "user" | "assistant", text: string) {
    setMessages((items) => items.concat({ role, text, actor, createdAt: new Date().toISOString() }));
    try { await saveStrategyChatMessage({ runId, role, text, actor }); } catch { /* the strategy checkpoint remains safe if transcript writing is unavailable */ }
  }
  async function logAsset() {
    if (!asset || busy) return;
    setBusy(true); setNote(null);
    try { await toggleAssetLock({ runId, stage: "strategy", assetId: asset.assetId, actor, locked: true }); setLogged((items) => items.includes(asset.assetId) ? items : items.concat(asset.assetId)); setNote("Concept logged. Its caption will stay attached to this plan."); void record("assistant", `Concept ${cursor + 1} logged: ${asset.conceptName}`); }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function refineAsset(value: string) {
    if (!asset || busy) return;
    setBusy(true); setNote(null);
    try {
      await proposeConcept({ runId, stage: "strategy", assetId: asset.assetId, action: "refine", notes: value });
      setNote("Refinement sent. The candidate will appear here when the strategy agent finishes."); void record("user", value);
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function rejectAsset(value: string) {
    if (!asset || busy) return;
    setBusy(true); setNote(null);
    try {
      await discardConcept({ runId, stage: "strategy", assetId: asset.assetId, notes: value, actor });
      setNote("Rejected and recorded in the brand learnings."); void record("assistant", `Concept rejected: ${asset.conceptName}`);
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="sc-run-chat">
    {messages.filter((message) => message.role === "user").map((message, index) => <div className="sc-user-bubble" key={`user-${index}`}>{message.text}</div>)}
    {!messages.length && <div className="sc-user-bubble">I’ve submitted the brief. Start the monthly planning.</div>}
    <StatusLine run={run} />
    {!asset && <div className="sc-assistant-block">
      <p>{stageStatus(run, "strategy").includes("running") || stageStatus(run, "research").includes("running")
        ? "I’m working through the research now. The concepts will appear here as soon as they are ready."
        : failedStage ? `The ${failedStage} stage needs attention before concepts can be shown.` : "No concepts are available yet."}</p>
      {failedStage && <button type="button" className="sc-secondary" disabled={retrying} onClick={() => void retryFailedStage()}>{retrying ? "Retrying…" : `Retry ${failedStage}`}</button>}
      {retryError && <p className="sc-error">{retryError}</p>}
    </div>}
    {asset && <>
      <div className="sc-assistant-block"><p>Here’s the next concept. Read it, refine it, or log it when it feels right.</p></div>
      <ConceptCard asset={asset} caption={captionFor(run, asset.assetId)} candidate={run?.stages.strategy?.candidates?.[asset.assetId] as { status?: string; detail?: string; candidate?: Partial<StrategyAsset> } | undefined} index={cursor} total={assets.length} logged={logged.includes(asset.assetId)} busy={busy} onLog={() => void logAsset()} onRefine={(value) => void refineAsset(value)} onReject={(value) => void rejectAsset(value)} />
      {note && <div className="sc-assistant-block sc-note-block"><p>{note}</p></div>}
      <div className="sc-next-row">{cursor > 0 && <button type="button" className="sc-secondary" onClick={() => setCursor(cursor - 1)}>Previous</button>}{cursor < assets.length - 1 ? <button type="button" className="sc-secondary" disabled={!logged.includes(asset.assetId)} onClick={() => setCursor(cursor + 1)}>Move to next</button> : <button type="button" className="sc-primary" disabled={logged.length < assets.length} onClick={() => { setFinished(true); void record("assistant", "Monthly planning is complete. All concepts are logged."); }}>Finish monthly planning</button>}</div>
    </>}
    {finished && <FinalPlan run={run} assets={assets} />}
  </div>;
}

function FinalPlan({ run, assets }: { run: StrategyRun | null; assets: StrategyAsset[] }) {
  const [copied, setCopied] = useState(false);
  const text = assets.map((asset, index) => `${index + 1}. ${asset.conceptName}\nFormat: ${asset.format}\nHook: ${asset.hook}\nTension: ${asset.tension}\nCaption: ${captionFor(run, asset.assetId) || "Caption not available"}`).join("\n\n");
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }
  return <section className="sc-final-plan"><div className="sc-concept-meta">Final monthly plan</div><h3>Everything logged for this brand</h3><p className="sc-muted">Copy this into Canva, the content calendar or your production brief.</p>{assets.map((asset, index) => <article key={asset.assetId} className="sc-final-item"><b>{index + 1}. {asset.conceptName}</b><span>{asset.format} · {asset.hook}</span><p>{captionFor(run, asset.assetId) || "Caption not available yet."}</p></article>)}<button type="button" className="sc-primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy complete plan"}</button></section>;
}

export function StrategyChatWorkspace({ actor }: { actor: string }) {
  const { brands: allBrands, loading: brandsLoading } = useAllHubBrands();
  const { brands: configuredBrands } = useBrands();
  const { runs } = useRuns();
  const [brand, setBrand] = useState<HubBrandOption | undefined>();
  const [mode, setMode] = useState<Mode>("home");
  const [runId, setRunId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeRun = runId ? runs.find((run) => run.runId === runId) : undefined;
  const selectedBrand = brand || (allBrands.length ? allBrands[0] : undefined);
  const strategyBrand = configuredBrands.find((item: StrategyBrand) => item.id === selectedBrand?.id);

  function chooseBrand(next: HubBrandOption) { setBrand(next); setMode("home"); setRunId(null); setSidebarOpen(false); }
  function newChat() { setRunId(null); setMode("home"); setSidebarOpen(false); }

  if (brandsLoading) return <div className="vs-shell"><main className="vs-main sc-loading">Loading brands…</main></div>;
  return <div className="vs-shell sc-shell">
    <BrandSidebar brands={allBrands} active={selectedBrand} runs={runs} open={sidebarOpen} onBrand={chooseBrand} onNew={newChat} onOpen={(id) => { const opened = runs.find((item) => item.runId === id); setRunId(id); setMode(opened?.runType === "campaign" ? "campaign" : "monthly"); setSidebarOpen(false); }} />
    <main className="vs-main">
      <header className="vs-header"><button type="button" className="vs-mobile-tool" aria-label="Open projects" onClick={() => setSidebarOpen(true)}>☰</button><div><h1>{selectedBrand?.name || "Strategy OS"}</h1><p>{activeRun ? (activeRun.runType === "campaign" ? "Campaign planning" : monthLabel(activeRun.month)) : mode === "home" ? "New strategy chat" : mode === "mani" ? "Chat with Mani" : mode === "campaign" ? "Campaign planning" : "Monthly planning"}</p></div><button type="button" className="vs-header-tool" onClick={() => setMode("mani")}>Mani</button></header>
      <section className="vs-thread sc-thread">
        {!selectedBrand && <div className="sc-assistant-block"><p>Add a brand in Hub before starting a strategy chat.</p></div>}
        {selectedBrand && !selectedBrand.configured && <div className="sc-assistant-block sc-warning"><p>{selectedBrand.name} needs a completed Strategy OS brand configuration before research can start.</p></div>}
        {selectedBrand && !runId && mode === "home" && <Welcome onMode={setMode} />}
        {selectedBrand && !runId && mode === "monthly" && <Brief mode="monthly" brand={selectedBrand} actor={actor} onStarted={(id) => setRunId(id)} onCancel={() => setMode("home")} />}
        {selectedBrand && !runId && mode === "campaign" && <CampaignBrief brand={selectedBrand} actor={actor} onStarted={(id) => setRunId(id)} onCancel={() => setMode("home")} />}
        {selectedBrand && !runId && mode === "mani" && <ManiChat brand={selectedBrand} />}
        {runId && (mode === "campaign" || activeRun?.runType === "campaign") ? <CampaignRunChat runId={runId} actor={actor} /> : null}
        {runId && mode !== "campaign" && activeRun?.runType !== "campaign" ? <RunChat runId={runId} actor={actor} /> : null}
      </section>
      <div className="sc-bottom-hint">Everything logged here stays with {selectedBrand?.name || "this brand"} and is available to Mani and the next strategy run.</div>
    </main>
    <aside className="vs-memory-drawer sc-memory-static"><h2>Mani · Brand memory agent</h2><p className="vs-muted vs-muted-sm">Mani reads stored choices, feedback and rejected directions when supporting Strategy OS.</p><p className="vs-section-label">Plan status</p><p className="vs-muted vs-muted-sm">{planStatusText(activeRun)}</p><p className="vs-section-label">Brand configuration</p><p className="vs-muted vs-muted-sm">{strategyBrand ? "Ready for planning" : "Needs setup"}</p></aside>
  </div>;
}
