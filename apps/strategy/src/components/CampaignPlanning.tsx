import { useEffect, useMemo, useRef, useState } from "react";
import { campaignAction, saveStrategyChatMessage, startRun } from "../lib/api";
import { listenPath } from "../lib/firebase";
import { useRun, type HubBrandOption } from "../lib/useRuns";
import type { CampaignIdentity, CampaignRoute, CampaignThought, ChatMessage } from "../lib/types";

const QUESTIONS = [
  { key: "occasion", label: "Campaign or occasion", question: "What is the campaign or occasion?", placeholder: "For example: a product launch, festive campaign or brand moment…" },
  { key: "objective", label: "What it should achieve", question: "What should this campaign achieve?", placeholder: "The change we want in awareness, perception or action…" },
  { key: "audience", label: "Priority audience", question: "Who is the priority audience?", placeholder: "Be as specific as you can…" },
  { key: "currentMessage", label: "What the brand already says", question: "What is the brand already saying about this?", placeholder: "Existing positioning, language or a message we should build from…" },
  { key: "available", label: "What we can use", question: "What products, people, locations or existing material can we use?", placeholder: "Products, founders, customers, locations, photography, films…" },
  { key: "rules", label: "Must appear / must avoid", question: "What must appear, and what must be avoided?", placeholder: "Mandatory details, claims, exclusions or sensitivities…" },
  { key: "launchDate", label: "Launch date", question: "Is there a launch date?", placeholder: "Give the date, range, or say that it is flexible…" },
] as const;

type BriefAnswers = Record<(typeof QUESTIONS)[number]["key"], string>;
const EMPTY_ANSWERS = Object.fromEntries(QUESTIONS.map((item) => [item.key, ""])) as BriefAnswers;

function currentMonth() {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function entries<T>(node: Record<string, T> | undefined): T[] {
  return node ? Object.values(node) : [];
}

export function CampaignBrief({ brand, actor, onStarted, onCancel }: { brand: HubBrandOption; actor: string; onStarted: (runId: string) => void; onCancel: () => void }) {
  const [answers, setAnswers] = useState<BriefAnswers>(EMPTY_ANSWERS);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = QUESTIONS[step];

  function answer() {
    const value = draft.trim();
    if (!value) { setError("Add an answer before moving on."); return; }
    const next = { ...answers, [item.key]: value };
    setAnswers(next); setError(null);
    // Editing an earlier answer and stepping forward again used to show every later
    // question's textarea empty, even though it had already been answered — the draft was
    // always reset to "", never restored from what was already recorded for that question.
    // Prefilling from `next` (not the stale `answers`) means the just-saved edit is visible
    // immediately if the next question happens to be the one just edited.
    if (step === QUESTIONS.length - 1) { setDraft(""); setConfirming(true); }
    else { setStep(step + 1); setDraft(next[QUESTIONS[step + 1].key] || ""); }
  }

  function edit(index: number) {
    setStep(index); setDraft(answers[QUESTIONS[index].key]); setConfirming(false); setError(null);
  }

  async function confirm() {
    setBusy(true); setError(null);
    try {
      const sourceContext = QUESTIONS.map((question) => `${question.label}: ${answers[question.key]}`);
      const result = await startRun({
        brandId: brand.id, month: currentMonth(), actor, runType: "campaign", chatMode: true,
        sourceContext, campaignBrief: answers,
      });
      onStarted(result.runId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  }

  return <div className="sc-brief sc-campaign-intake">
    <div className="sc-user-bubble">Let’s plan a campaign.</div>
    {!confirming ? <>
      <div className="sc-progress"><span style={{ width: `${((step + 1) / QUESTIONS.length) * 100}%` }} /></div>
      {QUESTIONS.slice(0, step).map((question) => <div key={question.key} className="sc-intake-history"><p>{question.question}</p><div className="sc-user-bubble">{answers[question.key]}</div></div>)}
      <div className="sc-assistant-block">
        <p className="sc-question-count">Question {step + 1} of {QUESTIONS.length}</p>
        <h3>{item.question}</h3>
        <textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); answer(); } }} placeholder={item.placeholder} />
        {error && <p className="sc-error">{error}</p>}
        <div className="sc-actions"><button type="button" className="sc-secondary" onClick={step ? () => edit(step - 1) : onCancel}>Back</button><button type="button" className="sc-primary" onClick={answer}>Continue</button></div>
      </div>
    </> : <div className="sc-assistant-block">
      <p className="sc-question-count">Brief confirmation</p>
      <h3>Here’s the campaign brief I’ll work from.</h3>
      <p>Check it once. Research stays in the background; the next thing you’ll see is three campaign identity options.</p>
      <div className="sc-brief-summary">{QUESTIONS.map((question, index) => <div key={question.key}><span>{question.label}</span><p>{answers[question.key]}</p><button type="button" onClick={() => edit(index)}>Edit</button></div>)}</div>
      {error && <p className="sc-error">{error}</p>}
      <div className="sc-actions"><button type="button" className="sc-secondary" onClick={() => edit(QUESTIONS.length - 1)}>Back</button><button type="button" className="sc-primary" disabled={busy} onClick={() => void confirm()}>{busy ? "Starting research…" : "Confirm brief"}</button></div>
    </div>}
  </div>;
}

function IdentityCard({ option, saved, busy, onSelect, onSave, onRefine }: { option: CampaignIdentity; saved: boolean; busy: boolean; onSelect: () => void; onSave: () => void; onRefine: (instruction: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  return <article className="sc-campaign-card">
    <p className="sc-card-kicker">Campaign identity</p><h3>{option.name}</h3><p className="sc-tagline">{option.tagline}</p>
    <dl><div><dt>Objective</dt><dd>{option.objective}</dd></div><div><dt>Territory</dt><dd>{option.territory}</dd></div></dl>
    <div className="sc-actions"><button type="button" className="sc-primary" disabled={busy} onClick={onSelect}>Select this campaign</button><button type="button" className="sc-secondary" onClick={() => setEditing(!editing)}>Refine</button><button type="button" className="sc-secondary" disabled={saved || busy} onClick={onSave}>{saved ? "Saved" : "Save for later"}</button></div>
    {editing && <div className="sc-refine"><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="What should change in this direction?" /><button type="button" className="sc-primary" disabled={!instruction.trim() || busy} onClick={() => { onRefine(`Use “${option.name} — ${option.tagline}” as the starting point. ${instruction.trim()}`); setEditing(false); setInstruction(""); }}>Refine this direction</button></div>}
  </article>;
}

function RouteCard({ route, busy, onSelect }: { route: CampaignRoute; busy: boolean; onSelect: () => void }) {
  return <article className="sc-campaign-card"><p className="sc-card-kicker">Creative route</p><h3>{route.name}</h3><p className="sc-route-idea">{route.coreIdea}</p><dl><div><dt>How it comes alive</dt><dd>{route.howItComesAlive}</dd></div><div><dt>Hero execution</dt><dd>{route.heroExecution}</dd></div><div><dt>Why it works</dt><dd>{route.whyItWorks}</dd></div></dl><div className="sc-actions"><button type="button" className="sc-primary" disabled={busy} onClick={onSelect}>Select this route</button></div></article>;
}

export function CampaignRunChat({ runId, actor }: { runId: string; actor: string }) {
  const { run } = useRun(runId);
  const campaign = run?.campaign || {};
  const identities = useMemo(() => entries(campaign.identityBatches).flatMap((batch) => batch.options || []), [campaign.identityBatches]);
  const routes = useMemo(() => entries(campaign.routeBatches).flatMap((batch) => batch.routes || []), [campaign.routeBatches]);
  const [error, setError] = useState<string | null>(null);
  const [pendingIdentity, setPendingIdentity] = useState<CampaignIdentity | null>(null);
  const [thoughtInstruction, setThoughtInstruction] = useState("");
  const [routeInstruction, setRouteInstruction] = useState("");
  const [assetRequest, setAssetRequest] = useState(campaign.assetRequest || "");
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customTagline, setCustomTagline] = useState("");
  const [copied, setCopied] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const autoRequested = useRef(false);
  const researchReady = Boolean(run?.stages?.research?.checkpoint);
  const busy = campaign.job?.status === "running";

  // Reopening a campaign chat used to show only whatever state it currently sits at — the
  // locked identity, the selected route — with no visible record of the conversation that
  // got there, even though every refinement instruction was already being written to
  // chatMessages. It was written, never read.
  useEffect(() => listenPath<Record<string, ChatMessage>>(`strategy_runs/${runId}/chatMessages`, (value) => {
    setMessages(Object.values(value || {}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
  }), [runId]);
  async function record(role: "user" | "assistant", text: string) {
    setMessages((items) => items.concat({ role, text, actor, createdAt: new Date().toISOString() }));
    try { await saveStrategyChatMessage({ runId, role, text, actor }); } catch { /* the campaign checkpoint remains safe if transcript writing is unavailable */ }
  }

  useEffect(() => {
    if (!run || !researchReady || identities.length || busy || autoRequested.current) return;
    autoRequested.current = true;
    campaignAction({ runId, action: "generate_identities", actor }).catch((cause) => { autoRequested.current = false; setError(cause instanceof Error ? cause.message : String(cause)); });
  }, [run, researchReady, identities.length, busy, runId, actor]);

  async function act(args: Parameters<typeof campaignAction>[0], transcript?: string) {
    setError(null);
    try {
      await campaignAction(args);
      if (transcript) void record("user", transcript);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function lockIdentity(option?: CampaignIdentity, custom?: boolean) {
    const name = custom ? customName.trim() : option?.name;
    const args = custom
      ? { runId, action: "lock_identity" as const, actor, customIdentity: { name: customName.trim(), tagline: customTagline.trim() } }
      : { runId, action: "lock_identity" as const, actor, optionId: option?.id };
    setError(null);
    try {
      await campaignAction(args);
      setPendingIdentity(null); setCustomOpen(false);
      void record("assistant", `Campaign identity locked: ${name}`);
      await campaignAction({ runId, action: "generate_thought", actor });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function lockThought(thought: CampaignThought) {
    setError(null);
    try {
      await campaignAction({ runId, action: "lock_thought", actor, thought: thought as unknown as Record<string, unknown> });
      void record("assistant", "Campaign thought locked.");
      await campaignAction({ runId, action: "generate_routes", actor });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function copyCampaign() {
    if (!campaign.lockedIdentity || !campaign.lockedThought || !campaign.lockedRoute || !campaign.assets?.length) return;
    const text = [
      `CAMPAIGN: ${campaign.lockedIdentity.name}`,
      `TAGLINE: ${campaign.lockedIdentity.tagline}`,
      `CAMPAIGN THOUGHT\n${campaign.lockedThought.thought}`,
      `CREATIVE ROUTE: ${campaign.lockedRoute.name}\n${campaign.lockedRoute.coreIdea}`,
      ...campaign.assets.map((asset, index) => `${index + 1}. ${asset.title} (${asset.format})\nIdea: ${asset.idea}\nOn-creative copy: ${asset.onCreativeCopy}\nCaption: ${asset.caption}\nCreative direction: ${asset.creativeDirection}`),
    ].join("\n\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  }

  if (!run) return <div className="sc-status">Opening campaign…</div>;
  return <div className="sc-run-chat sc-campaign-run">
    {messages.map((message, index) => message.role === "user"
      ? <div className="sc-user-bubble" key={`msg-${index}`}>{message.text}</div>
      : <div className="sc-assistant-block" key={`msg-${index}`}><p>{message.text}</p></div>)}
    {campaign.brief && <details className="sc-research-chip"><summary>Campaign brief · confirmed</summary><div>{QUESTIONS.map((question) => <p key={question.key}><b>{question.label}</b><span>{campaign.brief?.[question.key]}</span></p>)}</div></details>}
    {campaign.lockedIdentity && <div className="sc-identity-pin"><span>Locked campaign</span><h2>{campaign.lockedIdentity.name}</h2><p>{campaign.lockedIdentity.tagline}</p></div>}
    {!researchReady && <div className="sc-status">Research is happening privately in the background <span className="sc-dots">•••</span></div>}
    {researchReady && !campaign.lockedIdentity && <>
      <div className="sc-assistant-block"><p>Research is ready. Here are three overarching campaign identities. Choose one, refine a direction, save it, or ask for a fresh set.</p></div>
      {identities.map((option) => <IdentityCard key={option.id + option.name} option={option} saved={(campaign.savedIdentityIds || []).includes(option.id)} busy={busy} onSelect={() => setPendingIdentity(option)} onSave={() => void act({ runId, action: "save_identity", actor, optionId: option.id })} onRefine={(instruction) => void act({ runId, action: "generate_identities", actor, instruction }, instruction)} />)}
      {busy && campaign.job?.action === "generate_identities" && <div className="sc-status">Writing three campaign options <span className="sc-dots">•••</span></div>}
      {pendingIdentity && <div className="sc-lock-confirm"><p>Lock <b>{pendingIdentity.name}</b> with the tagline “{pendingIdentity.tagline}” as the campaign identity?</p><div className="sc-actions"><button className="sc-secondary" onClick={() => setPendingIdentity(null)}>Not yet</button><button className="sc-primary" disabled={busy} onClick={() => void lockIdentity(pendingIdentity)}>Lock campaign identity</button></div></div>}
      <div className="sc-option-controls"><button className="sc-secondary" disabled={busy} onClick={() => void act({ runId, action: "generate_identities", actor, instruction: "Give three completely new options. Do not overwrite or repeat the earlier options." }, "Give me three more campaign options.")}>Give me three more options</button>{["Make them bolder", "Make them more premium", "Make them more product-led"].map((instruction) => <button key={instruction} className="sc-secondary" disabled={busy} onClick={() => void act({ runId, action: "generate_identities", actor, instruction }, instruction)}>{instruction}</button>)}<button className="sc-secondary" onClick={() => setCustomOpen(!customOpen)}>Add our own campaign name</button></div>
      {customOpen && <div className="sc-custom-identity"><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="Campaign name" /><input value={customTagline} onChange={(event) => setCustomTagline(event.target.value)} placeholder="Tagline" /><button className="sc-primary" disabled={!customName.trim() || !customTagline.trim()} onClick={() => void lockIdentity(undefined, true)}>Lock our campaign identity</button></div>}
    </>}
    {campaign.lockedIdentity && !campaign.lockedThought && <>
      {!campaign.thoughtCandidate && campaign.job?.status !== "failed" && <div className="sc-status">Developing the campaign thought <span className="sc-dots">•••</span></div>}
      {!campaign.thoughtCandidate && campaign.job?.status === "failed" && <button className="sc-secondary" onClick={() => void act({ runId, action: "generate_thought", actor })}>Retry campaign thought</button>}
      {campaign.thoughtCandidate && <article className="sc-campaign-card sc-thought-card"><p className="sc-card-kicker">Campaign thought</p><p className="sc-thought">{campaign.thoughtCandidate.thought}</p><dl><div><dt>Strategic role</dt><dd>{campaign.thoughtCandidate.strategicRole}</dd></div><div><dt>Brand connection</dt><dd>{campaign.thoughtCandidate.brandConnection}</dd></div><div><dt>Audience takeaway</dt><dd>{campaign.thoughtCandidate.audienceTakeaway}</dd></div></dl><div className="sc-actions"><button className="sc-primary" disabled={busy} onClick={() => void lockThought(campaign.thoughtCandidate!)}>Lock campaign thought</button></div><div className="sc-refine"><textarea value={thoughtInstruction} onChange={(event) => setThoughtInstruction(event.target.value)} placeholder="What should change in the campaign thought?" /><button className="sc-secondary" disabled={busy || !thoughtInstruction.trim()} onClick={() => { void act({ runId, action: "generate_thought", actor, instruction: thoughtInstruction.trim() }, thoughtInstruction.trim()); setThoughtInstruction(""); }}>Refine thought</button></div></article>}
    </>}
    {campaign.lockedThought && !campaign.lockedRoute && <>
      <div className="sc-assistant-block"><p>The campaign identity is set. Now choose how it should come alive.</p></div>
      {routes.map((route) => <RouteCard key={route.id + route.name} route={route} busy={busy} onSelect={() => void act({ runId, action: "lock_route", actor, routeId: route.id }, `Select creative route: ${route.name}`)} />)}
      {busy && campaign.job?.action === "generate_routes" && <div className="sc-status">Developing creative routes <span className="sc-dots">•••</span></div>}
      {!busy && !routes.length && campaign.job?.status === "failed" && <button className="sc-secondary" onClick={() => void act({ runId, action: "generate_routes", actor })}>Retry creative routes</button>}
      {routes.length > 0 && <div className="sc-refine sc-route-refine"><textarea value={routeInstruction} onChange={(event) => setRouteInstruction(event.target.value)} placeholder="Ask for another set or steer the routes…" /><button className="sc-secondary" disabled={busy} onClick={() => { void act({ runId, action: "generate_routes", actor, instruction: routeInstruction.trim() || "Give three completely different creative routes without repeating the earlier ones." }, routeInstruction.trim() || "Give me three more creative routes."); setRouteInstruction(""); }}>More routes</button></div>}
    </>}
    {campaign.lockedRoute && <>
      <article className="sc-selected-route"><p className="sc-card-kicker">Selected creative route</p><h3>{campaign.lockedRoute.name}</h3><p>{campaign.lockedRoute.coreIdea}</p></article>
      <div className="sc-assistant-block"><p>What campaign assets should I build from this route?</p><p className="sc-muted">You can ask naturally: “2 launch reels, 1 manifesto carousel and 3 statics.”</p></div>
      <div className="sc-asset-request"><textarea value={assetRequest} onChange={(event) => setAssetRequest(event.target.value)} placeholder="Describe the formats and quantity…" /><button className="sc-primary" disabled={busy || !assetRequest.trim()} onClick={() => void act({ runId, action: "generate_assets", actor, assetRequest: assetRequest.trim() }, assetRequest.trim())}>{campaign.assets?.length ? "Rebuild campaign assets" : "Build campaign assets"}</button></div>
      {busy && campaign.job?.action === "generate_assets" && <div className="sc-status">Building the campaign assets <span className="sc-dots">•••</span></div>}
      {campaign.assets?.length ? <section className="sc-final-plan"><p className="sc-card-kicker">Complete campaign plan</p><h3>{campaign.lockedIdentity?.name}</h3><p className="sc-tagline">{campaign.lockedIdentity?.tagline}</p><article className="sc-final-item"><b>Campaign thought</b><p>{campaign.lockedThought?.thought}</p></article><article className="sc-final-item"><b>Creative route · {campaign.lockedRoute?.name}</b><p>{campaign.lockedRoute?.coreIdea}</p></article>{campaign.assets.map((asset, index) => <article key={asset.id} className="sc-final-item"><b>{index + 1}. {asset.title}</b><span>{asset.format}</span><p><strong>Idea</strong><br />{asset.idea}</p><p><strong>On-creative copy</strong><br />{asset.onCreativeCopy}</p><p><strong>Caption</strong><br />{asset.caption}</p><p><strong>Creative direction</strong><br />{asset.creativeDirection}</p></article>)}<button className="sc-primary" onClick={() => void copyCampaign()}>{copied ? "Complete campaign copied" : "Copy complete campaign"}</button></section> : null}
    </>}
    {campaign.job?.status === "failed" && <p className="sc-error">{campaign.job.detail || "The campaign response could not be generated. Try again."}</p>}
    {error && <p className="sc-error">{error}</p>}
  </div>;
}
