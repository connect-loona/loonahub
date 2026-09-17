import { useEffect, useMemo, useRef, useState } from "react";
import { useAllHubBrands, useBrands, useRun, useRuns, type HubBrandOption } from "../lib/useRuns";
import { archiveRun, askBB, clearBB, clearStrategyChat, discardConcept, proposeConcept, retryStage, saveManiMemory, saveStrategyChatMessage, startRun, toggleAssetLock, uploadBBAttachment } from "../lib/api";
import { listenPath } from "../lib/firebase";
import type { ChatMessage, CopyCheckpoint, StrategyAsset, StrategyBrand, StrategyCheckpoint, StrategyRun } from "../lib/types";
import { CampaignBrief, CampaignRunChat } from "./CampaignPlanning";
import loonaLogo from "../assets/loona-logo.png";

type Mode = "home" | "monthly" | "campaign" | "bb" | "global-bb";

const DEFAULT_COUNTS = { reel: 6, carousel: 4, static: 3 };

// The five pipeline specialists plus Mani, brand memory — the same six identities and
// emoji the backend already assigns one-to-one with a pipeline stage (or, for Mani, with
// answering questions about the brand instead of owning a stage). See
// netlify/functions/lib/strategy/agents/agent-registry.js, which this mirrors rather than
// imports: that file lives in the Netlify functions bundle, not this Vite app.
const STRATEGY_AGENTS = [
  { emoji: "👨🏻‍✈️", name: "Columbus", role: "Research" },
  { emoji: "🧕🏻", name: "Dora", role: "Strategy" },
  { emoji: "👩‍🎨", name: "Matilda", role: "Copy" },
  { emoji: "👩🏼‍🎤", name: "Barbie", role: "Creative Direction" },
  { emoji: "👷🏾", name: "Bob", role: "Deck Builder" },
  { emoji: "🧠", name: "Mani", role: "Brand Memory" },
] as const;

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

function BrandSidebar({ brands, active, runs, open, onBrand, onBrandThread, onNew, onOpen, onArchive, onGlobalBB, globalThreads, onGlobalThread }: {
  brands: HubBrandOption[];
  active: HubBrandOption | undefined;
  runs: StrategyRun[];
  onBrand: (brand: HubBrandOption) => void;
  onBrandThread: (brand: HubBrandOption, threadId: string) => void;
  onNew: () => void;
  onOpen: (runId: string) => void;
  onArchive: (run: StrategyRun) => void;
  onGlobalBB: () => void;
  globalThreads: Array<{ id: string; title?: string; updatedAt?: string }>;
  onGlobalThread: (id: string) => void;
  open?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [brandThreads, setBrandThreads] = useState<Array<{ id: string; title?: string; updatedAt?: string }>>([]);
  useEffect(() => listenPath<Record<string, { title?: string; updatedAt?: string }>>(`strategy_bb_chats/${active?.id || "none"}/threads`, (value) => setBrandThreads(Object.entries(value || {}).map(([id, thread]) => ({ id, ...thread })).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))))), [active?.id]);
  return <aside className={`vs-sidebar sc-sidebar${open ? " is-open" : ""}`}>
    <div className="vs-logo"><a href="/"><img src={loonaLogo} alt="Loona" /></a></div>
    <nav className="vs-topnav">
      <a href="/">Hub</a>
      <span className="is-active">Strategy OS</span>
      <a href="/visual/">Visual Studio</a>
    </nav>
    <p className="vs-section-label">Brand projects</p>
    <div className="vs-projects">
      {(expanded ? brands : brands.slice(0, 5)).map((brand) => {
        const brandRuns = runs.filter((run) => run.brandId === brand.id).slice(0, 8);
        const isActive = active?.id === brand.id;
        return <div key={brand.id} className={`vs-project-block${isActive ? " is-open" : ""}`}>
          <button type="button" className={`vs-project${isActive ? " is-active" : ""}`} onClick={() => onBrand(brand)}>
            {brand.logo
              ? <img className="vs-project-logo" src={brand.logo} alt="" />
              : <span className="vs-project-icon" style={{ background: tint(brand.id) }}>{initials(brand.name)}</span>}
            <span className="vs-project-name">{brand.name}</span>
          </button>
          {isActive && <div className="vs-chatlist">
            <button type="button" className="vs-newchat" onClick={() => onBrandThread(brand, `chat-${Date.now()}`)}>+ New BB chat</button>
            <button type="button" className="vs-newchat" onClick={onNew}>+ New strategy chat</button>
            {brandThreads.slice(0, 8).map((thread) => <button key={thread.id} type="button" className="vs-chatlink" onClick={() => onBrandThread(brand, thread.id)}>{thread.title || "New BB chat"}<span>BB chat</span></button>)}
            {brandRuns.map((run) => <div key={run.runId} className="sc-run-link"><button type="button" className="vs-chatlink" onClick={() => onOpen(run.runId)}>
              {run.runType === "campaign" ? (run.campaign?.lockedIdentity?.name || run.campaign?.brief?.occasion || "Campaign planning") : monthLabel(run.month)}
              <span>{run.status === "complete" ? "Complete" : (run.status || "In progress")}</span>
            </button>{(run.runType || "monthly") === "monthly" && <button type="button" className="sc-run-archive-button" onClick={() => onArchive(run)} aria-label={`Archive ${monthLabel(run.month)} monthly plan`}>Archive</button>}</div>)}
            {!brandRuns.length && <span className="vs-muted vs-muted-sm">No strategy chats yet.</span>}
          </div>}
        </div>;
      })}
      {brands.length > 5 && <button type="button" className="vs-newchat" onClick={() => setExpanded(!expanded)}>{expanded ? "Show recent brands" : "Expand brands"}</button>}
    </div>
    <button type="button" className="vs-newchat" onClick={onGlobalBB}>✦ Global BB</button>
    <div className="vs-chatlist">{globalThreads.slice(0, 8).map((thread) => <button key={thread.id} type="button" className="vs-chatlink" onClick={() => onGlobalThread(thread.id)}>{thread.title || "New chat"}</button>)}</div>
    <div className="vs-spacer" />
    <a className="vs-usage-link" href="/visual/">API usage</a>
  </aside>;
}

function Welcome({ onMode, configured }: { onMode: (mode: Mode) => void; configured: boolean }) {
  return <div className="sc-welcome">
    <p className="sc-eyebrow">Strategy OS</p>
    <h2>Welcome</h2>
    <p className="sc-muted">A conversation with the brand, its memory and the Loona strategy agents.</p>
    <div className="sc-agent-row">
      {STRATEGY_AGENTS.map((agent, index) => (
        <div key={agent.name} className="sc-agent-chip" title={agent.role}>
          <span className="sc-agent-emoji">{agent.emoji}</span>
          <span className="sc-agent-name" style={{ animationDelay: `${index * 0.25}s` }}>{agent.name}</span>
        </div>
      ))}
    </div>
    <div className="sc-suggestions">
      {/* Both of these kick off a real research run, which needs a saved Strategy OS brand
          config to read — starting one for an unconfigured brand is a guaranteed failure, so
          it isn't offered at all rather than offered and left to fail after the fact (see
          NewRunWizard, the screen this chat rework replaced, which made the same call). */}
      <button type="button" disabled={!configured} onClick={() => onMode("monthly")}><b>Monthly planning</b><span>{configured ? "Build this month’s content one concept at a time." : "Needs a completed brand configuration first."}</span></button>
      <button type="button" disabled={!configured} onClick={() => onMode("campaign")}><b>Campaign planning</b><span>{configured ? "Shape a launch, event or campaign through conversation." : "Needs a completed brand configuration first."}</span></button>
      <button type="button" onClick={() => onMode("bb")}><b>Ask BB</b><span>Think through anything with BB, grounded in this brand’s memory.</span></button>
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

function BBChat({ brand, actor, global = false, threadId = "main", onNewThread }: { brand?: HubBrandOption; actor: string; global?: boolean; threadId?: string; onNewThread?: () => void }) {
  const brandId = global ? "global" : brand?.id || "";
  const scope = global ? "global" as const : "brand" as const;
  const label = global ? "Loona Hub" : brand?.name || "this brand";
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ assetKey: string; url: string; filename?: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => listenPath<Record<string, ChatMessage>>(`strategy_bb_chats/${brandId}/${threadId}/messages`, (value) => {
    setMessages(Object.values(value || {}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
  }), [brandId, global, threadId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [messages, busy]);
  async function ask() {
    const message = question.trim();
    if ((!message && !attachments.length) || busy || uploading) return;
    setBusy(true); setError(null); setQuestion("");
    try { await askBB({ brandId: global ? undefined : brandId, scope: global ? "global" : undefined, threadId, message: message || "Please analyse the attached file.", actor, attachments }); setAttachments([]); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setQuestion(message); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!messages.length || !confirm(`Clear this ${global ? "Loona Hub" : label} BB chat? Mani’s saved memory will stay.`)) return;
    setBusy(true); setError(null);
    try { await clearBB({ brandId: global ? undefined : brandId, scope: global ? "global" : undefined, threadId, actor }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="sc-bb-chat">
    <div className="sc-bb-toolbar"><span>{global ? "Global BB conversation" : "Brand BB conversation"}</span><button type="button" onClick={onNewThread}>+ New chat</button><button type="button" onClick={() => void clear()} disabled={busy || !messages.length} aria-label="Clear chat">🗑 Clear chat</button></div>
    <div className="sc-bb-message-list">
      <div className="sc-bb-messages">
        {!messages.length && <div className="sc-bb-empty"><p>I’m BB. What are we working on today?</p><span>{global ? "I can help across Loona Hub. I’ll ask which brand matters whenever it is needed." : "I know this brand’s context through Mani, and I’ll make it clear when I’m suggesting something new."}</span></div>}
        {messages.map((message: ChatMessage & { attachments?: Array<{ url: string; filename?: string }> }, index) => message.role === "user"
          ? <div className="sc-user-bubble sc-bb-user-message" key={`${message.createdAt || index}-user`}>{message.text}{message.attachments?.map((item, i) => /\.(png|jpe?g|webp|gif)$/i.test(item.filename || "") ? <a key={i} href={item.url} target="_blank" rel="noreferrer"><img className="sc-bb-uploaded-image" src={item.url} alt={item.filename || "Uploaded image"} /></a> : <a key={i} href={item.url} target="_blank" rel="noreferrer" className="sc-bb-attachment">📎 {item.filename || "Attachment"}</a>)}<button type="button" className="sc-bb-action" onClick={() => setQuestion(message.text)}>Edit</button></div>
          : <div className="sc-bb-assistant-message" key={`${message.createdAt || index}-assistant`}><BBText text={message.text} /><button type="button" className="sc-bb-action" onClick={() => void navigator.clipboard.writeText(message.text)}>Copy</button></div>)}
        {busy && <div className="sc-bb-thinking">BB is thinking <span className="sc-dots">•••</span></div>}
        {error && <p className="sc-error">{error}</p>}
        <div ref={endRef} />
      </div>
    </div>
    <div className="sc-bb-composer-wrap">{attachments.length > 0 && <div className="sc-bb-queued">{attachments.map((item, i) => <span key={i}>📎 {item.filename || "Attachment"}<button type="button" onClick={() => setAttachments((items) => items.filter((_, index) => index !== i))}>×</button></span>)}</div>}<div className="sc-bb-composer"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json,.md,.txt,.csv,.json,.pdf" hidden onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; setUploading(true); try { const asset = await uploadBBAttachment(global ? undefined : brandId, scope, file); setAttachments((current) => [...current, asset]); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setUploading(false); e.currentTarget.value = ""; } }} /><button type="button" onClick={() => fileInput.current?.click()} aria-label="Attach image or document">+</button><textarea value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }} placeholder={`Message BB about ${label}…`} rows={1} /><button type="button" className="sc-bb-send" aria-label="Send message" disabled={busy || uploading || (!question.trim() && !attachments.length)} onClick={() => void ask()}>{busy || uploading ? "…" : "↑"}</button></div><p>{global ? "BB keeps this Loona Hub conversation separate from individual brand memory." : "BB uses Mani’s brand memory to keep the conversation grounded."}</p></div>
  </div>;
}

function StrategyHome({ onGlobalBB }: { onGlobalBB: () => void }) {
  return <div className="sc-welcome">
    <p className="sc-eyebrow">Strategy OS</p><h2>Welcome</h2>
    <p className="sc-muted">A shared home for Loona’s strategy agents, brand memory and active work.</p>
    <div className="sc-agent-row">{STRATEGY_AGENTS.map((agent, index) => <div key={agent.name} className="sc-agent-chip" title={agent.role}><span className="sc-agent-emoji">{agent.emoji}</span><span className="sc-agent-name" style={{ animationDelay: `${index * .25}s` }}>{agent.name}</span></div>)}</div>
    <div className="sc-suggestions"><button type="button" onClick={onGlobalBB}><b>Ask BB</b><span>Start a Loona-wide conversation, or choose a brand from the menu to plan with its memory.</span></button></div>
  </div>;
}

function ManiMemoryComposer({ brand, actor }: { brand: HubBrandOption; actor: string }) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true); setNotice(null); setError(null);
    try { await saveManiMemory({ brandId: brand.id, content: text, actor }); setContent(""); setNotice("Saved to Mani’s memory for this brand."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="sc-mani-composer"><p className="vs-section-label">Add to Mani memory</p><p className="vs-muted vs-muted-sm">Paste notes, decisions, client feedback, or a ChatGPT conversation excerpt. It is saved as a team source for {brand.name}.</p><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Paste brand context here…" rows={7} maxLength={40000} /><button type="button" className="vs-header-tool" disabled={busy || !content.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save to memory"}</button>{notice && <p className="sc-mani-success">{notice}</p>}{error && <p className="sc-error">{error}</p>}</div>;
}

function BBText({ text }: { text: string }) {
  const line = (value: string) => value.split(/(\*\*[^*]+\*\*)/g).map((part, i) => /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
  return <>{text.split("\n").map((value, i) => { const item = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(value); return !value.trim() ? null : item ? <div className="sc-bb-list-item" key={i}>{line(item[1])}</div> : <p key={i}>{line(value.replace(/^#{1,3}\s+/, ""))}</p>; })}</>;
}

function RunChat({ runId, actor, onArchived }: { runId: string; actor: string; onArchived: () => void }) {
  const { run } = useRun(runId);
  const assets = useMemo(() => strategyAssets(run), [run]);
  const [cursor, setCursor] = useState(0);
  const cursorInitialized = useRef(false);
  const [busy, setBusy] = useState(false);
  const [logged, setLogged] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [finished, setFinished] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [clearingChat, setClearingChat] = useState(false);
  const [archiving, setArchiving] = useState(false);
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
  // Reopening a chat with concepts already logged used to always land back on Concept 1,
  // forcing a click through everything already reviewed just to reach where the
  // conversation actually left off. Only ever runs once, the first time real assets and
  // lock state are both available — after that the cursor is purely the person's own
  // Previous/Next navigation.
  useEffect(() => {
    if (cursorInitialized.current || !run || !assets.length) return;
    const locks = run.stages.strategy?.locks || {};
    const firstUnlogged = assets.findIndex((item) => !locks[item.assetId]);
    setCursor(firstUnlogged >= 0 ? firstUnlogged : assets.length - 1);
    cursorInitialized.current = true;
  }, [run, assets]);
  useEffect(() => listenPath<Record<string, ChatMessage>>(`strategy_runs/${runId}/chatMessages`, (value) => {
    setMessages(Object.values(value || {}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
  }), [runId]);
  async function record(role: "user" | "assistant", text: string) {
    setMessages((items) => items.concat({ role, text, actor, createdAt: new Date().toISOString() }));
    try { await saveStrategyChatMessage({ runId, role, text, actor }); } catch { /* the strategy checkpoint remains safe if transcript writing is unavailable */ }
  }
  async function clearChat() {
    if (!messages.length || !confirm("Clear this strategy chat? The plan, research and approved concepts will stay.")) return;
    setClearingChat(true); setNote(null);
    try { await clearStrategyChat({ runId, actor }); }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setClearingChat(false); }
  }
  async function archivePlan() {
    if (archiving || !confirm("Archive this monthly plan? It stays safely in history, but will no longer block starting a new plan for this month.")) return;
    setArchiving(true); setNote(null);
    try { await archiveRun({ runId, actor, reason: "Archived from monthly planning" }); onArchived(); }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)); setArchiving(false); }
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
    <div className="sc-bb-toolbar"><span>Strategy conversation</span><span className="sc-run-actions"><button type="button" onClick={() => void clearChat()} disabled={clearingChat || !messages.length} aria-label="Clear strategy chat">🗑 Clear chat</button><button type="button" onClick={() => void archivePlan()} disabled={archiving} aria-label="Archive monthly plan">Archive plan</button></span></div>
    {/* The full transcript, not just the user's turns — reopening this chat used to show
        only the current concept, with every earlier exchange (what was refined, what got
        logged and why) recorded to chatMessages but never rendered back. */}
    {messages.length > 0
      ? messages.map((message, index) => message.role === "user"
        ? <div className="sc-user-bubble" key={`msg-${index}`}>{message.text}</div>
        : <div className="sc-assistant-block" key={`msg-${index}`}><p>{message.text}</p></div>)
      : <div className="sc-user-bubble">I’ve submitted the brief. Start the monthly planning.</div>}
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
  const [maniOpen, setManiOpen] = useState(false);
  const [globalThreadId, setGlobalThreadId] = useState("main");
  const [brandThreadId, setBrandThreadId] = useState("main");
  const [globalThreads, setGlobalThreads] = useState<Array<{ id: string; title?: string; updatedAt?: string }>>([]);
  useEffect(() => listenPath<Record<string, { title?: string; updatedAt?: string }>>("strategy_bb_chats/global/threads", (value) => setGlobalThreads(Object.entries(value || {}).map(([id, thread]) => ({ id, ...thread })).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))))), []);
  const activeRun = runId ? runs.find((run) => run.runId === runId) : undefined;
  // Default to the first CONFIGURED brand, not just the first in the list — an unconfigured
  // brand can't start a run yet anyway (see the NewRunWizard this chat rework replaced,
  // which made the same choice for the same reason). Landing on whichever brand happens to
  // sort first otherwise means opening Strategy OS can silently drop someone onto a brand
  // that's guaranteed to fail the moment they try to plan anything.
  // Do not drop people into the first alphabetical client. Strategy OS opens as the Loona
  // home; a client workspace is an intentional choice from the sidebar.
  const selectedBrand = brand;
  const strategyBrand = configuredBrands.find((item: StrategyBrand) => item.id === selectedBrand?.id);

  function chooseBrand(next: HubBrandOption) { setBrand(next); setBrandThreadId("main"); setMode("home"); setRunId(null); setSidebarOpen(false); }
  function newChat() { setRunId(null); setMode("home"); setSidebarOpen(false); }
  function openGlobalBB(fresh = false) { if (fresh) setGlobalThreadId(`chat-${Date.now()}`); setRunId(null); setMode("global-bb"); setSidebarOpen(false); }

  if (brandsLoading) return <div className="vs-shell sc-shell"><main className="vs-main sc-loading"><div className="sc-bb-opening"><span>🦦</span><h1>Say hello to BB</h1><p>Getting your Loona workspace ready…</p></div></main></div>;
  return <div className="vs-shell sc-shell">
    <BrandSidebar brands={allBrands} active={selectedBrand} runs={runs} open={sidebarOpen} onBrand={chooseBrand} onBrandThread={(next, id) => { setBrand(next); setBrandThreadId(id); setRunId(null); setMode("bb"); setSidebarOpen(false); }} onNew={newChat} onArchive={(run) => { if (!confirm(`Archive ${monthLabel(run.month)}? It will stay in history but no longer block a new monthly plan.`)) return; void archiveRun({ runId: run.runId, actor, reason: "Archived from brand sidebar" }).then(() => { if (runId === run.runId) { setRunId(null); setMode("home"); } }).catch((error) => alert(error instanceof Error ? error.message : String(error))); }} onGlobalBB={openGlobalBB} globalThreads={globalThreads} onGlobalThread={(id) => { setGlobalThreadId(id); openGlobalBB(); }} onOpen={(id) => { const opened = runs.find((item) => item.runId === id); setRunId(id); setMode(opened?.runType === "campaign" ? "campaign" : "monthly"); setSidebarOpen(false); }} />
    {(sidebarOpen || maniOpen) && <button type="button" className="vs-scrim" aria-label="Close" onClick={() => { setSidebarOpen(false); setManiOpen(false); }} />}
    <main className="vs-main">
      <header className="vs-header"><button type="button" className="vs-mobile-tool" aria-label="Open projects" onClick={() => setSidebarOpen(true)}>☰</button><div><h1>{mode === "global-bb" ? "Loona Hub" : selectedBrand?.name || "Strategy OS"}</h1><p>{activeRun ? (activeRun.runType === "campaign" ? "Campaign planning" : monthLabel(activeRun.month)) : mode === "home" ? "New strategy chat" : mode === "global-bb" ? "Ask BB · Global" : mode === "bb" ? "Ask BB" : mode === "campaign" ? "Campaign planning" : "Monthly planning"}</p></div>{selectedBrand && <a className="vs-header-tool sc-brand-directory" href={`/strategy/?directory=1&brandId=${encodeURIComponent(selectedBrand.id)}&brandName=${encodeURIComponent(selectedBrand.name)}`}>Brand Directory</a>}<button type="button" className="vs-header-tool" onClick={() => setManiOpen(true)}>Memory</button></header>
      <section className="vs-thread sc-thread">
        {mode !== "global-bb" && !selectedBrand && <StrategyHome onGlobalBB={() => openGlobalBB(true)} />}
        {selectedBrand && !selectedBrand.configured && <div className="sc-assistant-block sc-warning"><p>{selectedBrand.name} needs a completed Strategy OS brand configuration before research can start.</p></div>}
        {selectedBrand && !runId && mode === "home" && <Welcome onMode={setMode} configured={Boolean(selectedBrand.configured)} />}
        {selectedBrand && !runId && mode === "monthly" && <Brief mode="monthly" brand={selectedBrand} actor={actor} onStarted={(id) => setRunId(id)} onCancel={() => setMode("home")} />}
        {selectedBrand && !runId && mode === "campaign" && <CampaignBrief brand={selectedBrand} actor={actor} onStarted={(id) => setRunId(id)} onCancel={() => setMode("home")} />}
        {selectedBrand && !runId && mode === "bb" && <BBChat brand={selectedBrand} actor={actor} threadId={brandThreadId} onNewThread={() => setBrandThreadId(`chat-${Date.now()}`)} />}
        {mode === "global-bb" && <BBChat actor={actor} global threadId={globalThreadId} onNewThread={() => setGlobalThreadId(`chat-${Date.now()}`)} />}
        {runId && (mode === "campaign" || activeRun?.runType === "campaign") ? <CampaignRunChat runId={runId} actor={actor} /> : null}
        {runId && mode !== "campaign" && activeRun?.runType !== "campaign" ? <RunChat runId={runId} actor={actor} onArchived={() => { setRunId(null); setMode("home"); }} /> : null}
      </section>
      <div className="sc-bottom-hint">{mode === "global-bb" ? "This global BB chat stays in Loona Hub. Brand-specific work is kept with its own brand and Mani." : `Everything logged here stays with ${selectedBrand?.name || "this brand"} and is available to Mani and the next strategy run.`}</div>
    </main>
    <aside className={`vs-memory-drawer${maniOpen ? " is-open" : ""}`}>
      <button type="button" className="vs-drawer-close" onClick={() => setManiOpen(false)}>Close</button>
      <h2>Mani · Brand memory</h2>
      <p className="vs-muted vs-muted-sm">Mani works behind the scenes, collecting the brand’s recorded choices, feedback, team activity and Visual Studio history. BB uses this memory when speaking with the team.</p>
      <p className="vs-section-label">Plan status</p><p className="vs-muted vs-muted-sm">{planStatusText(activeRun)}</p>
      <p className="vs-section-label">Brand configuration</p><p className="vs-muted vs-muted-sm">{strategyBrand ? "Ready for planning" : "Needs setup"}</p>
      {selectedBrand ? <ManiMemoryComposer brand={selectedBrand} actor={actor} /> : <p className="vs-muted vs-muted-sm">Choose a brand to add information to Mani memory.</p>}
    </aside>
  </div>;
}
