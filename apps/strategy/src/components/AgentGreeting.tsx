// "Hi, we're here to help you" — the agent lineup shown once per browser session on the
// run list, introducing the five specialists (see AGENT_LINEUP in lib/format.ts, which
// mirrors pipeline.js's own STAGE_AGENTS) with a small waving animation on each emoji.
// Session-scoped via sessionStorage (not localStorage) — "new session" per the request
// that asked for this means each fresh tab/visit, not "only ever once on this device".
import { useState } from "react";
import { AGENT_LINEUP } from "../lib/format";

const DISMISSED_KEY = "so-agent-greeting-dismissed";

function alreadyDismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false; // private-browsing/storage-blocked — just show it every time instead
  }
}

export function AgentGreeting() {
  const [dismissed, setDismissed] = useState(alreadyDismissedThisSession);

  function dismiss() {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // no persistence available — it'll just show again next render, which is fine
    }
  }

  if (dismissed) return null;

  return (
    <div className="st-board st-agent-greeting" style={{ marginTop: 0 }}>
      <button className="st-agent-greeting-close" aria-label="Dismiss" onClick={dismiss}>&#10005;</button>
      <div className="st-agent-greeting-text">👋 Hi! We're here to help you build this month's strategy.</div>
      <div className="st-agent-greeting-row">
        {AGENT_LINEUP.map((agent, i) => (
          <div key={agent.stage} className="st-agent-chip" style={{ animationDelay: `${i * 0.15}s` }}>
            <span className="st-agent-chip-emoji" style={{ animationDelay: `${i * 0.15}s` }}>{agent.emoji}</span>
            <span className="st-agent-chip-name">{agent.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
