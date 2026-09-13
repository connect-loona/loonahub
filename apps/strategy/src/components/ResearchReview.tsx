// The research stage's review screen — ported from strategy-app.js's researchReviewHtml().
// Read-only content (no per-item actions, matching the legacy app) — approve/send-back
// lives entirely in the "Your next action" card.
//
// Two things this screen gets wrong if you let it: what it shows, and what it calls things.
//
// WHAT IT SHOWS. Research generates nine fields. Four of them — the openings it found, the
// dates it expects us to plan around, the facts it cleared for use in copy, and the things it
// admits it could not establish — used to render nowhere at all, while being validated and fed
// straight into Strategy's prompt. So the team approved research having never seen half of
// what they were approving, and the half they couldn't see included the only section that
// says "here is what I am not sure about".
//
// WHAT IT CALLS THINGS. "Live questions", "exhausted territory", "unspoken behaviours" and
// "whitespace" are the schema's internal names. Nobody outside this codebase knows what they
// mean, and a reviewer who doesn't know what a section is for cannot tell whether it's any
// good. Every section gets a plain-English heading and a one-line "why this matters" instead.
import type { ResearchCheckpoint, ResearchSource, StageState, StrategyRun } from "../lib/types";
import { fmtDateTime } from "../lib/format";

// Sources are cited by id throughout. Rendering the id ("s3") tells a reviewer nothing and
// gives them nowhere to click, so every citation resolves to its real link where it can.
function Sources({ ids, sources }: { ids?: string[]; sources: ResearchSource[] }) {
  if (!ids || !ids.length) return null;
  return (
    <div style={{ fontSize: 11 }}>
      Source: {ids.map((id, j) => {
        const src = sources.find((s) => s.id === id);
        return src ? (
          <a key={id} href={src.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{j > 0 ? ", " : ""}{src.type}</a>
        ) : (
          <span key={id}>{j > 0 ? ", " : ""}{id}</span>
        );
      })}
    </div>
  );
}

function Board({ title, count, why, children }: { title: string; count: number; why: string; children: React.ReactNode }) {
  return (
    <div className="st-board">
      <div className="st-board-header">{title} <span className="st-tag">{count}</span></div>
      <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 8 }}>{why}</div>
      {count === 0
        ? <div style={{ color: "var(--muted)", fontSize: 12, fontStyle: "italic" }}>Nothing found for this month.</div>
        : children}
    </div>
  );
}

const ROW: React.CSSProperties = { borderBottom: "1px solid var(--border)", padding: "10px 0", display: "flex", flexDirection: "column", gap: 4 };

export function ResearchReview({ run, stage }: { run: StrategyRun; stage: StageState }) {
  const r = stage.checkpoint as ResearchCheckpoint;
  const readOnly = stage.status === "approved";
  const approval = run.approvals?.research;
  const sources = r.sources || [];

  const liveQuestions = r.liveQuestions || [];
  const argumentsList = r.arguments || [];
  const unspoken = r.unspokenBehaviours || [];
  const exhausted = r.exhaustedTerritory || [];
  const whitespace = r.whitespace || [];
  const calendar = r.calendar || [];
  const verifiedFacts = r.verifiedFacts || [];
  const unknowns = r.unknowns || [];

  return (
    <>
      <Board
        title="Real audience questions"
        count={liveQuestions.length}
        why="Actual questions and doubts found in reviews, comments, search behaviour or community conversations. Use these to understand what people already care about before concepts are written."
      >
        {liveQuestions.map((q, i) => (
          <div key={i} style={ROW}>
            <div style={{ fontWeight: 600 }}>&ldquo;{q.verbatim}&rdquo;</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>What this tells us: {q.underlyingNeed}</div>
            <Sources ids={q.sourceIds} sources={sources} />
          </div>
        ))}
      </Board>

      <Board
        title="Arguments we could take a side on"
        count={argumentsList.length}
        why="Things people in this category genuinely disagree about. A brand that picks a side here has something to say; one that stays neutral has nothing. Check the suggested side is one this brand can credibly defend."
      >
        {argumentsList.map((a, i) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
            <div style={{ fontWeight: 600 }}>{a.disagreement}</div>
            <div style={{ fontSize: 12, marginTop: 4 }}><b>Side A:</b> {a.sideA}</div>
            <div style={{ fontSize: 12 }}><b>Side B:</b> {a.sideB}</div>
            <div style={{ fontSize: 12, color: "var(--accent)", marginTop: 4 }}>Credible position: {a.credibleBrandPosition} — {a.credibilityReason}</div>
            <Sources ids={a.sourceIds} sources={sources} />
          </div>
        ))}
      </Board>

      <Board
        title="What people do but don't talk about"
        count={unspoken.length}
        why="Habits and workarounds people actually have but rarely admit to. These are usually the most original places to start a concept, because no competitor is talking about them either."
      >
        {unspoken.map((b, i) => (
          <div key={i} style={ROW}>
            <div style={{ fontWeight: 600 }}>{b.behaviour}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{b.hiddenTension}</div>
            <Sources ids={b.sourceIds} sources={sources} />
          </div>
        ))}
      </Board>

      <Board
        title="Openings nobody has taken"
        count={whitespace.length}
        why="Gaps in what the category is saying that this brand has a genuine right to speak into. This is where a month's most distinctive work usually comes from — if an opening here looks wrong for the brand, say so before concepts get built on it."
      >
        {whitespace.map((w, i) => (
          <div key={i} style={ROW}>
            <div style={{ fontWeight: 600 }}>{w.opening}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Why we can say it: {w.brandRightToSpeak}</div>
            <Sources ids={w.sourceIds} sources={sources} />
          </div>
        ))}
      </Board>

      <Board
        title="Don't do this again (kill list)"
        count={exhausted.length}
        why="Angles this category — or this brand — has already worn out. Anything here should not turn up as a concept next month."
      >
        {exhausted.map((t, i) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
            <b>{t.territory}</b> — {t.reasonExhausted}
            <Sources ids={t.sourceIds} sources={sources} />
          </div>
        ))}
      </Board>

      <Board
        title="Dates worth planning around"
        count={calendar.length}
        why="Moments this month that the content could hang off. Check these are real and actually relevant before the calendar is built — a tentative one that turns out to be wrong is worse than none."
      >
        {calendar.map((c, i) => (
          <div key={i} style={ROW}>
            <div style={{ fontWeight: 600 }}>
              {c.date} — {c.moment}{" "}
              {/* A moment the model itself isn't sure about must look different from one it verified,
                  or a reviewer will treat a guess as a fact and plan a launch around it. */}
              <span
                className="st-tag"
                style={{ color: c.confidence === "verified" ? "var(--green)" : c.confidence === "tentative" ? "var(--amber, var(--muted))" : "var(--muted)" }}
              >
                {c.confidence === "verified" ? "confirmed" : c.confidence === "tentative" ? "needs checking" : "probably not relevant"}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{c.relevance}</div>
            <Sources ids={c.sourceIds} sources={sources} />
          </div>
        ))}
      </Board>

      <Board
        title="Facts cleared for use in copy"
        count={verifiedFacts.length}
        why="Claims the research stands behind, with the source. Only the ones marked safe to use should end up in a caption — the rest are context for you, not copy."
      >
        {verifiedFacts.map((f, i) => (
          <div key={i} style={ROW}>
            <div style={{ fontWeight: 600 }}>
              {f.fact}{" "}
              <span className="st-tag" style={{ color: f.usableInCopy ? "var(--green)" : "var(--muted)" }}>
                {f.usableInCopy ? "safe to use in copy" : "background only"}
              </span>
            </div>
            <Sources ids={f.sourceIds} sources={sources} />
          </div>
        ))}
      </Board>

      <Board
        title="What research couldn't confirm"
        count={unknowns.length}
        why="Things the research tried to establish and couldn't. This is the section to read hardest: anything the month depends on that shows up here needs a human to settle it before approval, not after."
      >
        {unknowns.map((u, i) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0", fontSize: 13 }}>{u}</div>
        ))}
      </Board>

      {readOnly ? (
        <div className="st-note">Research approved {fmtDateTime(approval?.decidedAt)} by {approval?.decidedBy}.</div>
      ) : (
        <div className="st-note">Use the &ldquo;Your next action&rdquo; card to approve this or send it back with notes.</div>
      )}
    </>
  );
}
