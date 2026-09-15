// Visual Studio — per-brand image generation as a running conversation.
//
// The shape here follows the way the team already works in ChatGPT, which is the thing this
// is meant to replace: a brand is a project, a project holds many chats, and a chat is a
// conversation against a reference that gets refined round by round. It is deliberately not a
// form with a Generate button, because that isn't how anyone actually arrives at a usable
// image.
//
// Two things this screen refuses to do, both learned from the prototypes it's based on:
//
//   It never claims a check it didn't run. Both prototypes drew a QC panel reading "5 of 6
//   checks passed" with nothing computing it. Somebody would read that on a real client asset
//   and believe it. The only assertions here are ones the backend actually returned.
//
//   It never shows a control that does nothing. The rules panel lists exactly the rules that
//   were really prepended to the prompt (see visual-rules.js); there are no strength sliders,
//   because no image API this app talks to accepts one.
import { useCallback, useEffect, useState } from "react";
import { onAuthChange, type CurrentUser } from "./lib/firebase";
import { useHubBrands, brandColour } from "./lib/useBrands";
import * as api from "./lib/api";
import type { Generation, PendingReference, VisualBrand, VisualChat } from "./lib/types";
import { ChatThread } from "./components/ChatThread";
import { Composer } from "./components/Composer";
import { ProjectMemory } from "./components/ProjectMemory";
import { UsagePanel } from "./components/UsagePanel";
import loonaLogo from "./assets/loona-logo.png";

export function App() {
  const { brands, loading: brandsLoading } = useHubBrands();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [brand, setBrand] = useState<VisualBrand | null>(null);
  const [chats, setChats] = useState<VisualChat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // References the person has attached but not sent yet. Browser-only until upload, so
  // these go straight through the function to the provider and are never written down.
  const [references, setReferences] = useState<PendingReference[]>([]);
  // Whether the last failure was the kind that clears on its own — a burst limit or a blip at
  // OpenAI's end — so the error can offer a retry instead of just sitting there.
  const [retryable, setRetryable] = useState(false);
  const [suggestedPrompt, setSuggestedPrompt] = useState<string | null>(null);
  const [parent, setParent] = useState<{ generationId: string; imageIndex: number } | null>(null);
  // Carried into the composer alongside a reference — see carryForward. Either field may be
  // undefined (an older round recorded no shape), and Composer applies only what's present.
  const [seedShape, setSeedShape] = useState<{ size?: string | null; quality?: string | null } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  // Kept so a transient failure can be retried without making the person retype the prompt.
  const [lastSend, setLastSend] = useState<{ prompt: string; count: number; size: string; quality: string; provider: "openai" | "magnific" } | null>(null);

  useEffect(() => onAuthChange(setUser), []);
  const actor = user?.displayName || user?.email || "Hub";

  // Pick the first brand once Hub's list arrives, so the app opens on something real rather
  // than an empty frame.
  useEffect(() => {
    if (!brand && brands.length) {
      const wanted = new URLSearchParams(window.location.search).get("brand");
      setBrand(brands.find((b) => b.id === wanted) || brands[0]);
    }
  }, [brands, brand]);

  const loadChats = useCallback(async (b: VisualBrand) => {
    setError(null);
    try {
      const { chats: list } = await api.listChats(b.id);
      setChats(list);
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setChats([]);
      return [];
    }
  }, []);

  useEffect(() => {
    if (!brand) return;
    setChatId(null);
    setGenerations([]);
    setReferences([]);
    setParent(null);
    void loadChats(brand);
  }, [brand, loadChats]);

  // Waits on a job that is already running and drops its round into the thread when it lands.
  //
  // This is the same waitForJob the send path uses, deliberately — there is one definition of
  // "a job finished" rather than a second one for the resume case that could drift from it.
  const attachToJob = useCallback(async (job: api.VisualJob) => {
    setBusy(true);
    setError(null);
    setNotice("Reconnected to a generation that was already running.");
    try {
      // A job can be found still QUEUED: created, but never started, because the tab that
      // created it went away in the moment between those two calls. Nothing else will ever
      // pick it up, so it would sit queued for ever while somebody waits for a round that is
      // not coming. Starting it here is safe — the worker ignores a job already running.
      if (job.status === "queued" && job.workerToken) await api.startJob(job.id, job.workerToken);
      const result = await api.waitForJob(job.id);
      // Guard against a job that finished while the person was off looking at another chat:
      // only append if it isn't already in the thread.
      setGenerations((prev) => (prev.some((g) => g.id === result.id) ? prev : prev.concat([{ ...result, pickedIndex: null }])));
      setNotice(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const openChat = useCallback(async (id: string) => {
    setChatId(id);
    setGenerations([]);
    setReferences([]);
    setError(null);
    // Written before the history call, not after: if the page is refreshed while that request
    // is still in flight, the URL already points at the right chat.
    const query = new URLSearchParams({ brand: brand?.id || "", chat: id });
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    // Running jobs are read BEFORE the history, and the order is load-bearing.
    //
    // A generation outlives the tab that started it: the worker keeps going and the round is
    // paid for either way. Reading history first opened a window where a job finishing in
    // between belonged to neither list — not yet recorded when history was read, no longer
    // "active" when jobs were. The round simply vanished, and somebody had been charged for it.
    //
    // This way round there is no such gap: if nothing is running, everything that exists is
    // already in the record, and the history read below will contain it.
    let running: api.VisualJob[] = [];
    try {
      const { jobs } = await api.activeJobs(id);
      running = jobs;
    } catch {
      // Not being able to check for running jobs is not a reason to fail opening the chat.
    }

    try {
      const { generations: rounds, hasMore: more } = await api.chatHistory(id);
      // Oldest first: a conversation reads downward, and the newest round belongs at the
      // bottom next to the composer you're about to type in again.
      setGenerations(rounds.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
      setHasMore(Boolean(more));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    // attachToJob de-duplicates by id, so a job that lands in history while we were waiting
    // cannot produce the same round twice.
    if (running.length) void attachToJob(running[running.length - 1]);
  }, [brand, attachToJob]);

  useEffect(() => {
    if (chatId || !chats.length) return;
    const wanted = new URLSearchParams(window.location.search).get("chat");
    if (wanted && chats.some((chat) => chat.id === wanted)) void openChat(wanted);
  }, [chats, chatId, openChat]);

  async function loadOlder() {
    if (!chatId || !generations.length) return;
    try {
      const oldest = generations[0].createdAt;
      const { generations: older, hasMore: more } = await api.chatHistory(chatId, oldest);
      setGenerations((current) => older.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).concat(current));
      setHasMore(Boolean(more));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  // Deliberately does NOT create anything yet — send() creates the chat on the first real
  // message. Creating up front meant every click left an "Untitled visual chat · Empty" row
  // in the sidebar forever, whether or not anyone typed into it.
  function newChat() {
    setChatId(null);
    setGenerations([]);
    setReferences([]);
    setError(null);
    setNotice(null);
    setParent(null);
    if (brand) window.history.replaceState(null, "", `${window.location.pathname}?brand=${encodeURIComponent(brand.id)}`);
  }

  // Carrying a generated image back up as the next reference IS the iteration loop — it's how
  // "now make the table warmer" works without re-uploading anything, and it costs nothing
  // because the image is already in the browser.
  // Continuing on ONE take, exclusively — whichever was just picked, or just explicitly built
  // on, replaces whatever was there before rather than piling onto it. Picking option A out of
  // a round means working on A, not A-plus-whatever-was-already-attached; building on a
  // different take later means moving on to that one, not accumulating both. Someone who wants
  // to genuinely combine two different sources still can, through the ordinary "+ Reference"
  // upload — this only governs what a PICK or a BUILD-ON-THIS action itself carries.
  //
  // It also carries the round's shape and quality forward, not just the image — a follow-up on
  // a 9:16 final shouldn't quietly land back on the composer's own defaults (4:5, draft) just
  // because nobody remembered to reselect them.
  function carryForward(generation: Generation, index: number) {
    const image = (generation.images || [])[index];
    if (!image || !image.url) return;
    setReferences([{
      dataUrl: image.url as string,
      name: `Take ${index + 1} from this chat`,
      role: "Composition and current scene",
      assetKey: image.assetKey || undefined,
      contentType: image.contentType || undefined,
    }]);
    setParent({ generationId: generation.id, imageIndex: index });
    setSeedShape({ size: generation.size, quality: generation.quality });
    setNotice(null);
  }
  const useAsReference = carryForward;

  async function commitRename(id: string) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title || !brand) return;
    // Optimistic: the sidebar updates immediately and reverts by reload if the call fails.
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await api.renameChat(id, title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await loadChats(brand);
    }
  }

  async function send(prompt: string, count: number, size: string, quality: string, provider: "openai" | "magnific") {
    if (!brand) return;
    setError(null);
    setNotice(null);
    setRetryable(false);
    setLastSend({ prompt, count, size, quality, provider });
    setBusy(true);
    try {
      // A chat is created on first send rather than up front, so opening Visual Studio and
      // changing your mind doesn't litter the sidebar with empty threads.
      let id = chatId;
      if (!id) {
        const created = await api.createChat(brand.id, actor);
        id = created.id;
        setChatId(id);
        // Routed immediately, before the job is even created. A generation can run for well
        // over a minute, and if the tab is refreshed in that window the URL has to already
        // name this chat — otherwise the reconnect below has nothing to reconnect to and the
        // round looks lost while the worker is still finishing it.
        const query = new URLSearchParams({ brand: brand.id, chat: id });
        window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
        // The sidebar should show the new chat straight away, not only once it has a round.
        void loadChats(brand);
      }
      setNotice(references.length ? "Uploading references securely…" : "Generation queued — you can safely refresh this page.");
      const uploaded = await Promise.all(references.map((reference) => api.uploadReference(id as string, reference)));
      setReferences(uploaded);
      const result = await api.generate({
        chatId: id, prompt, count, size, quality, provider, actor,
        references: uploaded,
        parentGenerationId: parent?.generationId || null,
        parentImageIndex: parent?.imageIndex ?? null,
      });
      setGenerations((prev) => prev.concat([{ ...result, pickedIndex: null }]));
      // Cleared on success only: a failed round should keep what was attached so the person
      // can fix the prompt and try again without re-uploading everything.
      setReferences([]);
      setParent(null);
      setNotice(null);
      // The images exist either way — say so plainly if the memory write was what failed,
      // rather than letting the round silently vanish from history later.
      if (result.recorded === false) {
        setNotice("These images were generated, but couldn't be saved to this brand's memory. Download anything you want to keep.");
      }
      await loadChats(brand);
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = e instanceof Error ? e.message : String(e);
      // A rate limit already got one automatic retry server-side, so by the time it reaches
      // here it's worth saying plainly that waiting is the fix — and that fewer takes helps.
      // Running out of credit is the opposite: waiting achieves nothing.
      setError(status === 402
        ? `${message} (Nothing you can do from here — this needs topping up.)`
        : message);
      setRetryable(status === 429 || status === 502);
    } finally {
      setBusy(false);
    }
  }

  async function pick(generation: Generation, index: number, note?: string, tags?: string[]) {
    if (!brand) return;
    setError(null);
    try {
      await api.pickImage({ brandId: brand.id, generationId: generation.id, index, actor, note, tags });
      setGenerations((prev) => prev.map((g) => (g.id === generation.id
        ? { ...g, pickedIndex: index, pickedBy: actor, pickedAt: new Date().toISOString() }
        : g)));
      // Picking option A out of a round means continuing on A, not leaving somebody to click
      // "Build on this" a second time for the choice they just made. carryForward REPLACES
      // rather than stacks, so this is safe even when the take just picked is the same one
      // already carried by an earlier explicit click — picking it again is a no-op, not a
      // second copy of the same reference.
      carryForward(generation, index);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function enhance(generation: Generation, index: number) {
    if (!chatId) return;
    setError(null); setNotice("Magnific Precision enhancement queued — this can take several minutes."); setBusy(true);
    try {
      const result = await api.enhanceImage({ chatId, generationId: generation.id, imageIndex: index, actor });
      setGenerations((prev) => prev.concat([{ ...result, pickedIndex: null }]));
      setNotice(null);
      if (brand) await loadChats(brand);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="vs-shell">
      <aside className={`vs-sidebar${sidebarOpen ? " is-open" : ""}`}>
        <div className="vs-logo"><img src={loonaLogo} alt="Loona" /></div>
        <nav className="vs-topnav">
          <a href="/">Hub</a>
          <a href="/strategy/">Strategy OS</a>
          <span className="is-active">Visual Studio</span>
        </nav>

        <p className="vs-section-label">Brand projects</p>
        {brandsLoading && <p className="vs-muted">Loading brands from Hub…</p>}
        {!brandsLoading && !brands.length && (
          <p className="vs-muted">No active brands in Hub yet — add one there first.</p>
        )}

        <div className="vs-projects">
          {brands.map((b) => {
            const open = brand?.id === b.id;
            return (
              <div key={b.id} className={`vs-project-block${open ? " is-open" : ""}`}>
                <button
                  type="button"
                  className={`vs-project${open ? " is-active" : ""}`}
                  onClick={() => {
                    window.history.replaceState(null, "", `${window.location.pathname}?brand=${encodeURIComponent(b.id)}`);
                    setBrand(b); setSidebarOpen(false);
                  }}
                >
                  {/* Hub's own brand logo where there is one, the same way its brand cards do
                      it — falling back to a coloured initial for brands nobody has uploaded
                      one for yet. */}
                  {b.logo
                    ? <img className="vs-project-logo" src={b.logo} alt="" />
                    : (
                      <span className="vs-project-icon" style={{ background: brandColour(b.id) }}>
                        {b.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  <span className="vs-project-name">{b.name}</span>
                </button>
                {open && (
                  <div className="vs-chatlist">
                    <button type="button" className="vs-newchat" onClick={newChat}>+ New visual chat</button>
                    {chats.map((c) => (renamingId === c.id ? (
                      // Rename in place rather than through a dialog — it's one field, and a
                      // modal for a chat title is more ceremony than the action deserves.
                      <input
                        key={c.id}
                        className="vs-chatrename"
                        value={renameDraft}
                        autoFocus
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => commitRename(c.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitRename(c.id); }
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                      />
                    ) : (
                      <div key={c.id} className={`vs-chatrow${chatId === c.id ? " is-active" : ""}`}>
                        <button
                          type="button"
                          className="vs-chatlink"
                          onClick={() => { void openChat(c.id); setSidebarOpen(false); }}
                          // Double-click to rename, the way a file name works everywhere else.
                          onDoubleClick={() => { setRenamingId(c.id); setRenameDraft(c.title); }}
                        >
                          {c.title}
                          <span>{c.generationCount ? `${c.generationCount} round${c.generationCount === 1 ? "" : "s"}` : "Empty"}</span>
                        </button>
                        {/* An explicit button too: double-click isn't discoverable, and this
                            is the only way to rename on a touch screen. */}
                        <button
                          type="button"
                          className="vs-chatrename-btn"
                          title="Rename this chat"
                          aria-label={`Rename ${c.title}`}
                          onClick={() => { setRenamingId(c.id); setRenameDraft(c.title); }}
                        >
                          ✎
                        </button>
                      </div>
                    )))}
                    {!chats.length && <p className="vs-muted vs-muted-sm">No chats yet for this brand.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="vs-spacer" />
        <button type="button" className="vs-usage-link" onClick={() => setUsageOpen(true)}>API usage</button>
        <div className="vs-user">{actor}</div>
      </aside>

      {(sidebarOpen || memoryOpen || usageOpen) && <button className="vs-scrim" aria-label="Close side panel" onClick={() => { setSidebarOpen(false); setMemoryOpen(false); setUsageOpen(false); }} />}
      <main className="vs-main">
        <header className="vs-header">
          <button type="button" className="vs-mobile-tool" onClick={() => setSidebarOpen(true)} aria-label="Open projects">☰</button>
          <div>
            <h1>{brand ? brand.name : "Visual Studio"}</h1>
            <p>{chats.find((c) => c.id === chatId)?.title || "New visual chat"}</p>
          </div>
          <button type="button" className="vs-mobile-tool" onClick={() => setMemoryOpen(true)} aria-label="Open brand memory">Mani</button>
          <button type="button" className="vs-header-tool" onClick={() => setUsageOpen(true)}>API usage</button>
        </header>

        {error && (
          <div className="vs-error" role="alert">
            {error}
            {retryable && lastSend && !busy && (
              // The references are still attached (they're only cleared on success), so this
              // really is the same round again rather than a half-rebuilt one.
              <button type="button" className="vs-retry" onClick={() => send(lastSend.prompt, lastSend.count, lastSend.size, lastSend.quality, lastSend.provider)}>
                Try again
              </button>
            )}
          </div>
        )}
        {notice && <div className="vs-notice" role="status">{notice}</div>}
        {hasMore && <button type="button" className="vs-load-older" onClick={() => void loadOlder()}>Load older rounds</button>}

        <ChatThread
          generations={generations}
          onPick={pick}
          onUseAsReference={useAsReference}
          onSuggestion={setSuggestedPrompt}
          onReview={async (generation, imageIndex) => {
            if (!chatId) return;
            const { qc } = await api.reviewImage({ chatId, generationId: generation.id, imageIndex });
            setGenerations((prev) => prev.map((g) => g.id === generation.id ? { ...g, qc } : g));
          }}
          onEnhance={enhance}
          busy={busy}
        />
        <Composer
          onSend={send} busy={busy} disabled={!brand} references={references} setReferences={setReferences}
          suggestedPrompt={suggestedPrompt} onSuggestionUsed={() => setSuggestedPrompt(null)}
          seedShape={seedShape} onSeedUsed={() => setSeedShape(null)}
        />
      </main>

      <div className={`vs-memory-drawer${memoryOpen ? " is-open" : ""}`}>
        <button type="button" className="vs-drawer-close" onClick={() => setMemoryOpen(false)}>Close</button>
        <ProjectMemory brand={brand} generations={generations} />
      </div>
      <UsagePanel open={usageOpen} onClose={() => setUsageOpen(false)} />
    </div>
  );
}
