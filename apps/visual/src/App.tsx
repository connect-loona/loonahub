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
import type { Generation, VisualBrand, VisualChat } from "./lib/types";
import { ChatThread } from "./components/ChatThread";
import { Composer } from "./components/Composer";
import { ProjectMemory } from "./components/ProjectMemory";
import loonaLogo from "./assets/loona-logo.png";

export function App() {
  const { brands, loading: brandsLoading } = useHubBrands();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [brand, setBrand] = useState<VisualBrand | null>(null);
  const [chats, setChats] = useState<VisualChat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => onAuthChange(setUser), []);
  const actor = user?.displayName || user?.email || "Hub";

  // Pick the first brand once Hub's list arrives, so the app opens on something real rather
  // than an empty frame.
  useEffect(() => {
    if (!brand && brands.length) setBrand(brands[0]);
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
    void loadChats(brand);
  }, [brand, loadChats]);

  const openChat = useCallback(async (id: string) => {
    setChatId(id);
    setGenerations([]);
    setError(null);
    try {
      const { generations: rounds } = await api.chatHistory(id);
      // Oldest first: a conversation reads downward, and the newest round belongs at the
      // bottom next to the composer you're about to type in again.
      setGenerations(rounds.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Deliberately does NOT create anything yet — send() creates the chat on the first real
  // message. Creating up front meant every click left an "Untitled visual chat · Empty" row
  // in the sidebar forever, whether or not anyone typed into it.
  function newChat() {
    setChatId(null);
    setGenerations([]);
    setError(null);
    setNotice(null);
  }

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

  async function send(prompt: string, count: number, size: string) {
    if (!brand) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // A chat is created on first send rather than up front, so opening Visual Studio and
      // changing your mind doesn't litter the sidebar with empty threads.
      let id = chatId;
      if (!id) {
        const created = await api.createChat(brand.id, actor);
        id = created.id;
        setChatId(id);
      }
      const result = await api.generate({ chatId: id, prompt, count, size, actor });
      setGenerations((prev) => prev.concat([{ ...result, pickedIndex: null }]));
      // The images exist either way — say so plainly if the memory write was what failed,
      // rather than letting the round silently vanish from history later.
      if (result.recorded === false) {
        setNotice("These images were generated, but couldn't be saved to this brand's memory. Download anything you want to keep.");
      }
      await loadChats(brand);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pick(generation: Generation, index: number) {
    if (!brand) return;
    setError(null);
    try {
      await api.pickImage({ brandId: brand.id, generationId: generation.id, index, actor });
      setGenerations((prev) => prev.map((g) => (g.id === generation.id
        ? { ...g, pickedIndex: index, pickedBy: actor, pickedAt: new Date().toISOString() }
        : g)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="vs-shell">
      <aside className="vs-sidebar">
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
                  onClick={() => setBrand(b)}
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
                          onClick={() => openChat(c.id)}
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
        <div className="vs-user">{actor}</div>
      </aside>

      <main className="vs-main">
        <header className="vs-header">
          <div>
            <h1>{brand ? brand.name : "Visual Studio"}</h1>
            <p>{chats.find((c) => c.id === chatId)?.title || "New visual chat"}</p>
          </div>
        </header>

        {error && <div className="vs-error" role="alert">{error}</div>}
        {notice && <div className="vs-notice" role="status">{notice}</div>}

        <ChatThread generations={generations} onPick={pick} busy={busy} />
        <Composer onSend={send} busy={busy} disabled={!brand} />
      </main>

      <ProjectMemory brand={brand} generations={generations} />
    </div>
  );
}
