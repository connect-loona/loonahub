// The three standing messages BB sends the team every working day — the ones Gokul used to
// type out by hand at 10:00, noon and 6:30.
//
// Only the brief differs between them. Each slot hands BB the same live picture (the whole
// task board, plus what actually moved today from Mani's event ledger) and asks for a
// different read on it, so there is one place to change how any of them think rather than
// three near-identical functions drifting apart.
//
// Deliberately reuses askBB rather than calling a model directly: these go out in BB's own
// voice, under the same WhatsApp house rules as everything else she sends, so the morning
// digest sounds like the person the team has been talking to all week rather than a cron job.
"use strict";
const { collectAllTeamActivity, hubTaskBoardToPromptText } = require("./team-activity");
const { loadRecentHubManiEvents } = require("./mani-events");
const { loadHouseRulesText } = require("./bb-house-rules");
const { askBB } = require("./bb-chat");

// What counts as "closed" when reporting what the day actually produced.
const CLOSING_STATUSES = new Set(["completed", "deferred"]);
const MAX_EVENT_LINES = 60;

// IST, because every one of these is scheduled against the team's own working day — "due
// yesterday" has to mean yesterday in the office, not yesterday in UTC.
function istDate(offsetDays = 0) {
  const now = new Date(Date.now() + 5.5 * 3600000 + offsetDays * 86400000);
  return now.toISOString().slice(0, 10);
}

// What moved today, from Mani's ledger rather than the live board — a task that was finished
// and then cleared off the board this morning still belongs in the evening's "what closed"
// list, and the board itself no longer knows it existed.
async function movementText(deps = {}) {
  const load = deps.loadRecentHubManiEvents || loadRecentHubManiEvents;
  const today = deps.today || istDate();
  const events = await load(200, 1);
  const todays = events
    .filter((event) => String(event.occurredAt || "").slice(0, 10) === today)
    .filter((event) => String(event.type || "").startsWith("task_"))
    .slice(0, MAX_EVENT_LINES);
  if (!todays.length) return `# What moved today (${today})\nNothing has been recorded against a task yet today.`;
  return [
    `# What moved today (${today})`,
    "Every task event Hub recorded today, newest first. This is what actually changed, as opposed to the board's current state above.",
    ...todays.map((event) => {
      const at = String(event.occurredAt || "").slice(11, 16);
      const actor = event.actor && event.actor !== "system" ? ` · ${event.actor}` : "";
      return `- ${at}${actor}: ${event.summary || event.type}`;
    }),
  ].join("\n");
}

function countsText(activity, today, yesterday) {
  if (!activity) return null;
  const active = activity.active || [];
  const dueToday = active.filter((task) => String(task.due_date || "") === today);
  const dueYesterday = active.filter((task) => String(task.due_date || "") === yesterday);
  const undated = active.filter((task) => !task.due_date);
  const closed = (activity.recentlyDone || []).filter((task) => CLOSING_STATUSES.has(String(task.status || "").toLowerCase()));
  return [
    "# Counted for you",
    "Worked out from the board so you do not have to count them yourself. Use these numbers; do not recount and contradict them.",
    `- Open tasks in total: ${activity.activeCount || active.length}`,
    `- Still open and was due yesterday (${yesterday}): ${dueYesterday.length}`,
    `- Due today (${today}): ${dueToday.length}`,
    `- Open with no due date at all: ${undated.length}`,
    `- Already overdue by any amount: ${(activity.overdue || []).length}`,
    `- Recently closed or deferred: ${closed.length}`,
    `- People carrying open work: ${(activity.people || []).length}`,
  ].join("\n");
}

// One brief per slot. These are what BB is actually asked to write, so they carry the intent
// of each message rather than a format to fill in — she already knows how to write.
const SLOTS = {
  morning: {
    key: "morning",
    label: "Morning rundown",
    brief: [
      "Write the team's 10am rundown for today. Two things, in this order:",
      "1. What was due yesterday and still is not closed — name the person and the task, and say who it is actually waiting on where the board shows that.",
      "2. What is on the board for today as things stand right now.",
      "Go through everyone who has something in either bucket, not a handful. If nothing was left over from yesterday, say so plainly — that is good news and worth stating rather than padding around.",
      "Open by greeting the team, not one person. End with something that invites them to come back to you about their own list.",
    ].join("\n"),
  },
  midday: {
    key: "midday",
    label: "Midday check-in",
    brief: [
      "Write the midday check-in. This is a nudge, not a full report, so keep it noticeably shorter than the morning one.",
      "Look at what moved today against what this morning said was due. Call out what has genuinely progressed, and what has not been touched since the day started.",
      "Be specific about anything due today that is still sitting at Not Started — that is the whole point of a midday check.",
      "Keep it light. Nobody needs a second full rundown at lunch.",
    ].join("\n"),
  },
  evening: {
    key: "evening",
    label: "End of day",
    brief: [
      "Write the 6:30 end-of-day message. Three things:",
      "1. What actually closed today — name who closed what.",
      "2. What was due today and did not close, and what each of those is waiting on.",
      "3. A short, honest analysis: how did today actually go? Was the load spread evenly, or is one person carrying it? Is anything stuck waiting on the same approver over and over? Is there a pattern worth naming before it becomes next week's problem?",
      "The analysis is the part that matters — it is why this message exists rather than a list. Say the real thing, including when the answer is that today was slow.",
      "Never invent a reason for why something slipped. If the board does not say why, say it is not recorded and let the person answer for themselves tomorrow.",
    ].join("\n"),
  },
};

// Assembles the live picture and has BB write one slot's message. Returns the text only —
// how it reaches the team is the caller's business, which is what keeps this testable and
// lets the same digest go out over more than one channel.
async function buildDigest(slotKey, deps = {}) {
  const slot = SLOTS[slotKey];
  if (!slot) throw new Error(`Unknown digest slot "${slotKey}". Use one of: ${Object.keys(SLOTS).join(", ")}.`);

  const today = deps.today || istDate();
  const yesterday = deps.yesterday || istDate(-1);
  const collect = deps.collectAllTeamActivity || collectAllTeamActivity;
  const rules = deps.loadHouseRulesText || loadHouseRulesText;
  const ask = deps.askBB || askBB;

  const [activity, houseRules, moved] = await Promise.all([
    collect({ today }),
    rules("whatsapp").catch((error) => { console.error("Could not load BB's house rules for the digest:", error.message); return null; }),
    movementText({ ...deps, today }).catch((error) => { console.error("Could not load today's task movement:", error.message); return null; }),
  ]);

  const memory = [
    `Today is ${today}. Yesterday was ${yesterday}.`,
    hubTaskBoardToPromptText(activity),
    countsText(activity, today, yesterday),
    moved,
  ].filter(Boolean).join("\n\n");

  // No speaker and no history on purpose: this is addressed to the whole team rather than to
  // whoever happens to be in a thread, and it must read the same for everyone who gets it.
  const result = await ask({
    brandName: "Loona Hub",
    message: slot.brief,
    memory,
    history: [],
    attachments: [],
    speaker: null,
    houseRules,
  });
  return { slot: slot.key, label: slot.label, text: result.answer, provider: result.provider, model: result.model };
}

module.exports = { buildDigest, SLOTS, istDate, movementText, countsText, CLOSING_STATUSES };
