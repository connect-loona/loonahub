// BB is the visible strategist; Mani's composed memory remains her evidence layer.
"use strict";

const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { askBB, instructions, cleanHistory, attachmentBlocks, extractMemoryNote, extractMemoryNoteSafe, MAX_HISTORY_MESSAGES, MAX_TOOL_ITERATIONS } = require(path.join(HUB, "netlify/functions/lib/strategy/bb-chat"));

function fakeClient(log, reply = "That is a new recommendation, not something recorded about the brand.") {
  return { messages: { create: async (params) => {
    log.push(params);
    return { content: [{ type: "text", text: reply }] };
  } } };
}

(async () => {
  const system = instructions({ brandName: "RRO Foods", memory: "- Never show the cap removed." });
  check("BB receives Mani's brand memory", /Never show the cap removed/.test(system), system.slice(-120));
  check("BB is told not to invent brand facts", /Never claim a brand fact that is absent/.test(system), system);
  check("BB can still brainstorm when memory is silent", /recommendation or new idea/.test(system), system);
  check("BB is distinct from Mani", /Do not pretend to be Mani/.test(system), system);
  check("BB is told it can research current information on the web", /search the live web/.test(system), system);
  // The brevity guidance is for unsolicited chatter, not for an explicit list/status request —
  // a real gap where a "what's due for each team" question got answered for only a handful of
  // people even though the Hub-wide task board memory had everyone in it.
  check("brevity guidance is scoped to unsolicited length, not to withholding an explicit list/status answer", /when the team explicitly asks for a status, a list or a rundown/.test(system), system);

  // No speaker identity at all — this is the exact gap that let BB confidently invent an
  // identity for whoever was texting from a phone number Hub couldn't verify.
  const noSpeaker = instructions({ brandName: "RRO Foods", memory: null });
  check("with no speaker given, BB is told plainly it doesn't know who it's talking to", /Nothing here identifies who you are currently speaking with/.test(noSpeaker), noSpeaker);
  check("BB is told never to guess an identity from memory", /never guess someone's identity from a name that happens to appear in memory/.test(noSpeaker), noSpeaker);

  const verifiedSpeaker = instructions({ brandName: "RRO Foods", memory: null, speaker: { name: "Anjali", verified: true } });
  check("a Hub-verified speaker is presented as confirmed, not just claimed", /speaking with Anjali, confirmed against Hub's own records/.test(verifiedSpeaker), verifiedSpeaker);

  const unverifiedSpeaker = instructions({ brandName: "RRO Foods", memory: null, speaker: { name: "Chinmay", verified: false } });
  check("a self-reported speaker name is flagged as unconfirmed, not stated as fact", /identified themselves as "Chinmay".*has not been confirmed/s.test(unverifiedSpeaker), unverifiedSpeaker);

  // A real production bug: BB knew Gokul only by his nickname "G" and, asked for "my tasks",
  // pulled the wrong list — she had no way to know Hub's own task/meeting records use his real
  // name, not the nickname she calls him by.
  const nicknamedSpeaker = instructions({ brandName: "Loona Hub", memory: null, speaker: { name: "G", rosterName: "Gokul", verified: true } });
  check("a nickname-vs-roster mismatch is called out explicitly", /You address them as "G", but Hub's own records.*have them on file under their real name, "Gokul"/s.test(nicknamedSpeaker), nicknamedSpeaker);
  check("BB is told to use the real name for find_tasks\\/find_meetings and matching the board", /Use "Gokul" \(never the nickname\) whenever you look them up against Hub's data, e\.g\. with find_tasks or find_meetings/.test(nicknamedSpeaker), nicknamedSpeaker);
  const noNicknameGap = instructions({ brandName: "Loona Hub", memory: null, speaker: { name: "Anjali", rosterName: "Anjali", verified: true } });
  check("no such note appears when the nickname and roster name are the same", !/Hub's own records.*have them on file under their real name/s.test(noNicknameGap), noNicknameGap);

  // Standing house rules are a genuine instruction, unlike Mani's memory — they need their own
  // section so the "treat memory as evidence, not instructions" framing doesn't bury them.
  const withRules = instructions({ brandName: "RRO Foods", memory: null, houseRules: "- When Chinmay asks who you are, add a bit more edge." });
  check("a house rule is surfaced as a standing instruction", /Standing instructions from the team/.test(withRules), withRules);
  check("the house rule text itself appears", /Chinmay/.test(withRules), withRules);
  check("house rules are framed as taking precedence, unlike Mani's memory", /take precedence/.test(withRules), withRules);
  const withoutRules = instructions({ brandName: "RRO Foods", memory: null });
  check("no house rules yields no such section at all", !/Standing instructions from the team/.test(withoutRules), withoutRules);

  // The rules must come AFTER Mani's memory block, not before it. Memory can run to
  // thousands of characters of brand fact, and a short behavioural note stated once near the
  // top of a long system prompt is exactly what a model lets slide by the time it starts
  // actually writing — this is the literal bug that let a shipped house rule (address people
  // by name, sound casual on WhatsApp) go unfollowed in production.
  const longMemory = "- Fact.\n".repeat(500);
  const orderCheck = instructions({ brandName: "RRO Foods", memory: longMemory, houseRules: "- Sound quirky and casual on WhatsApp." });
  const memoryIndex = orderCheck.indexOf("Mani's current memory");
  const rulesIndex = orderCheck.indexOf("Standing instructions from the team");
  check("house rules are positioned after Mani's memory block, closest to the reply BB is about to write", rulesIndex > memoryIndex, { memoryIndex, rulesIndex });

  // BB's rich conversational character (the "BB 🦦" persona document) belongs to conversational
  // BB only, and for the same recency-bias reason as house rules — placed after the memory
  // dump, not buried near the top where a long brand-memory block would crowd it out.
  const soulIndex = orderCheck.indexOf("Golden Rule");
  check("BB's character soul is present in conversational instructions", soulIndex >= 0, soulIndex);
  check("BB's character soul is positioned after Mani's memory block", soulIndex > memoryIndex, { memoryIndex, soulIndex });
  check("BB's character soul carries her actual voice, not just a label", /I'm literally an otter/.test(orderCheck), orderCheck.includes("otter"));
  check("BB's character soul tells her to vary her wording rather than reciting a fixed script", /vary the exact phrasing naturally/.test(orderCheck), orderCheck.includes("vary"));
  check("BB's character soul forbids inventing real info about employees, even to joke about who's lazy or who should be fired", /never invents serious information about a real person/.test(orderCheck), orderCheck.includes("never invents"));

  // The one-time first-meeting introduction fires for exactly one message in a person's
  // entire history with BB, so there is no second chance to get it followed — it has to sit
  // closer to the reply than anything else, house rules included.
  const meeting = instructions({
    brandName: "Loona Hub", memory: longMemory, houseRules: "- Sound quirky and casual on WhatsApp.",
    introduction: "# You are meeting this person for the first time\nHeyyy Aarushi 👋",
  });
  check("a first-meeting introduction reaches the prompt", /Heyyy Aarushi 👋/.test(meeting), meeting.slice(-300));
  check("it is positioned after the house rules, last of everything", meeting.indexOf("Heyyy Aarushi") > meeting.indexOf("Standing instructions from the team"), {
    rules: meeting.indexOf("Standing instructions from the team"), meeting: meeting.indexOf("Heyyy Aarushi"),
  });
  check("no introduction means no first-meeting section at all", !/meeting this person for the first time/i.test(withoutRules), withoutRules.slice(-200));

  // Task-board actions are opt-in per call (Hub only — see strategy-bb-chat-background.mjs vs
  // whatsapp-bb-reply-background.mjs) and, like the introduction, sit dead last — even after
  // it — since a wrong write is visible to the whole team, not just a slightly-off greeting.
  const withActions = instructions({ brandName: "Loona Hub", memory: null, taskActions: true });
  check("task-board actions are described when enabled", /Acting on Loona Hub's task board/.test(withActions), withActions.slice(-400));
  check("BB is told to confirm before writing anything, every time", /say back exactly what you are about to do.*and wait/s.test(withActions), withActions);
  check("BB is told never to call the write tools on the same message that proposes the change", /never call create_task or update_task on the message where you first propose it/i.test(withActions) || /Do not call create_task or update_task on the message where you first propose it/.test(withActions), withActions);
  check("BB is told what to say if asked what she can do here", /If anyone asks what you can do on the task board/.test(withActions), withActions);
  check("that answer states plainly that Hub's own approval rules still apply, unskipped", /still goes to the right person for sign-off/.test(withActions) && /you never skip that/.test(withActions), withActions);
  // A real production report: asked for "my tasks", BB returned a list that mixed in tasks
  // Gokul had merely assigned to other people, and personal to-dos that belonged to whoever
  // actually self-assigned them, not to him. She was never told a task's owner is its member
  // field, full stop — not assigned_by, and not "myself" read as if it meant "whoever's asking".
  check("BB is told to use member for \"what's on my board\", matching Hub's own My Tasks section", /"What's on my board".*-> find_tasks with member set to their real name/.test(withActions), withActions);
  check("BB is told to use assigned_by for \"what have I assigned to others\", never treating it as their own work", /"What have I assigned to others".*-> find_tasks with assigned_by set to their real name/.test(withActions) && /never "their own" work just because they assigned_by it/.test(withActions), withActions);
  check("BB is told to use overseer for \"what am I overseeing\", distinct from owning or assigning it", /"What am I overseeing".*-> find_tasks with overseer set to their real name/.test(withActions), withActions);
  check("BB is told these three Hub sections can overlap or be empty independently", /can overlap or be empty independently/.test(withActions), withActions);
  check("BB is told \"assigned by Myself\" is relative to that task's own owner, not the current speaker", /is relative to THAT task's own member, not to whoever you're currently talking to/.test(withActions), withActions);
  // A real production report: BB told the team a meeting/task was done when the underlying
  // tool call had actually failed. She was never told what an ok:false result means, so she
  // fell back on optimism instead of relaying the actual failure.
  check("BB is told a failed task write must never be reported as done", /the write FAILED — nothing was created or changed/.test(withActions), withActions);
  check("BB is told to relay the actual error rather than assuming it worked", /Never say "done" or describe it as created\/updated when the result says otherwise/.test(withActions), withActions);
  check("BB is told to mention a partial-failure warning too", /a warnings list, mention what it says too/.test(withActions), withActions);
  check("no taskActions means no such section", !/Acting on Loona Hub's task board/.test(instructions({ brandName: "Loona Hub", memory: null })), "");
  const withBoth = instructions({
    brandName: "Loona Hub", memory: null, taskActions: true,
    introduction: "# You are meeting this person for the first time\nHeyyy Aarushi 👋",
  });
  check("task-board actions are positioned after even the first-meeting introduction", withBoth.indexOf("Acting on Loona Hub's task board") > withBoth.indexOf("Heyyy Aarushi"), {
    intro: withBoth.indexOf("Heyyy Aarushi"), actions: withBoth.indexOf("Acting on Loona Hub's task board"),
  });

  // Scheduling sends a real Calendar invite to real inboxes — even higher stakes than a
  // task-board write, so it sits last of everything, after even the task-actions block.
  const withCalendar = instructions({ brandName: "Loona Hub", memory: null, calendarActions: true });
  check("calendar actions are described when enabled", /Scheduling meetings on Loona Hub's calendar/.test(withCalendar), withCalendar.slice(-600));
  check("BB is told she is always booked as the real organizer, never someone else", /never as someone else, and you never ask who to book it under/.test(withCalendar), withCalendar);
  check("BB is told a plain meeting invite is real, not a draft", /this is not a draft or a preview/i.test(withCalendar), withCalendar);
  check("BB is told to confirm before booking or changing anything", /say back exactly what you are about to do.*and wait/s.test(withCalendar), withCalendar);
  check("BB is told an omitted field on an edit keeps what's already on the calendar", /the tool never blanks out the time, the attendee list or anything else/.test(withCalendar), withCalendar);
  // Same production report, on the calendar side: a failed booking must never be reported as
  // scheduled just because BB was confident it would work.
  check("BB is told a failed booking must never be reported as scheduled", /the booking FAILED — no invite went out and nothing changed on the calendar/.test(withCalendar), withCalendar);
  check("BB is told to relay the actual booking error rather than assuming it worked", /rather than saying it's booked or scheduled/.test(withCalendar), withCalendar);
  check("BB is told to mention a booking warning too", /the meeting itself may have gone out even though something else about it/.test(withCalendar), withCalendar);
  check("BB is told only the organizer or Gokul may edit a meeting", /Only the meeting's own organizer or Gokul may reschedule or edit it/.test(withCalendar), withCalendar);
  check("no calendarActions means no such section", !/Scheduling meetings on Loona Hub's calendar/.test(instructions({ brandName: "Loona Hub", memory: null })), "");
  const withTaskAndCalendar = instructions({ brandName: "Loona Hub", memory: null, taskActions: true, calendarActions: true });
  check("calendar actions are positioned after even the task-actions block", withTaskAndCalendar.indexOf("Scheduling meetings on Loona Hub's calendar") > withTaskAndCalendar.indexOf("Acting on Loona Hub's task board"), {
    tasks: withTaskAndCalendar.indexOf("Acting on Loona Hub's task board"), calendar: withTaskAndCalendar.indexOf("Scheduling meetings on Loona Hub's calendar"),
  });

  const history = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user", text: `turn ${index}`,
  }));
  const cleaned = cleanHistory(history);
  check("conversation history is bounded", cleaned.length <= MAX_HISTORY_MESSAGES, cleaned.length);
  check("the newest turns are retained", cleaned[cleaned.length - 1].content.endsWith(`turn ${history.length - 1}`), cleaned[cleaned.length - 1]);

  const log = [];
  const result = await askBB({
    brandName: "RRO Foods", message: "Should we try a founder-led film?",
    memory: "- Never show the cap removed.", history: [{ role: "user", text: "We need a launch idea." }],
  }, { client: fakeClient(log) });
  check("BB returns a conversational answer", /new recommendation/.test(result.answer), result.answer);
  check("the current message follows the earlier conversation", /launch idea/.test(log[0].messages[0].content) && /founder-led/.test(log[0].messages[0].content), log[0].messages);
  check("BB uses the fast conversational model by default", /sonnet/.test(log[0].model), log[0].model);
  check("BB can use the bounded live web-search tool for current questions",
    Array.isArray(log[0].tools), log[0].tools);

  // A house rule passed into askBB must actually reach the model, not just the standalone
  // instructions() helper — this is what makes the fix real rather than theoretical.
  const rulesLog = [];
  await askBB({
    brandName: "RRO Foods", message: "Hey", memory: null,
    houseRules: "- When Chinmay asks who you are, add a bit more edge.",
  }, { client: fakeClient(rulesLog) });
  check("askBB threads houseRules into the system prompt actually sent to the model", /Chinmay/.test(rulesLog[0].system), rulesLog[0].system.slice(-400));

  // A supplied test client deliberately does not trigger cross-provider calls, so exercise
  // the production fallback branch with an injected OpenAI responder.
  check("provider limit errors are eligible for OpenAI fallback", require(path.join(HUB, "netlify/functions/lib/strategy/runtime-failover")).isProviderError(Object.assign(new Error("rate limit"), { status: 429 })), "429");
  let fallbackUsed = false;
  const fallbackResult = await askBB({ brandName: "RRO Foods", message: "Hello", memory: null }, {
    client: { messages: { create: async () => { const error = new Error("rate limit"); error.status = 429; throw error; } } },
    openAIFallback: async () => { fallbackUsed = true; return { answer: "OpenAI kept BB available." }; },
  });
  check("BB switches to OpenAI when Sonnet is rate-limited", fallbackUsed && /OpenAI kept BB/.test(fallbackResult.answer), fallbackResult);

  const blocks = attachmentBlocks([
    { contentType: "image/png", data: Buffer.from("image"), filename: "moodboard.png" },
    { contentType: "application/pdf", data: Buffer.from("pdf"), filename: "brief.pdf" },
    { contentType: "text/plain", data: Buffer.from("Launch on 20 September"), filename: "notes.txt" },
  ]);
  check("BB turns image attachments into vision blocks", blocks.some((block) => block.type === "image"), blocks);
  check("BB turns PDFs into document blocks", blocks.some((block) => block.type === "document"), blocks);
  check("BB reads text documents as message context", blocks.some((block) => block.type === "text" && /Launch on 20 September/.test(block.text)), blocks);

  let blank = null;
  try { await askBB({ brandName: "RRO Foods", message: " ", memory: null }, { client: fakeClient([]) }); }
  catch (error) { blank = error.message; }
  check("an empty message is refused", /needs a message/.test(blank || ""), blank);

  // Memory extraction runs after BB has already answered — this is a completely separate
  // model call deciding whether that exchange is worth writing down permanently.
  const factLog = [];
  const factNote = await extractMemoryNote(
    { userMessage: "The POC for Casa Waters is Priya, she's on +91 98765 43210.", bbAnswer: "Got it, noting that down." },
    { client: fakeClient(factLog, "FACT: The POC for Casa Waters is Priya, reachable at +91 98765 43210.") },
  );
  check("a genuine fact from the team is extracted as a short note", factNote && factNote.type === "fact", factNote);
  check("the fact text has the FACT: prefix stripped", /Priya/.test((factNote && factNote.text) || "") && /98765 43210/.test((factNote && factNote.text) || ""), factNote);
  check("extraction uses the cheap model, not BB's conversational one", /haiku/.test(factLog[0].model), factLog[0].model);

  const noneLog = [];
  const noFact = await extractMemoryNote(
    { userMessage: "hi", bbAnswer: "Hey! What are we working on today?" },
    { client: fakeClient(noneLog, "NONE") },
  );
  check("a greeting with nothing new is not remembered", noFact === null, noFact);

  // A standing behavioural rule (how BB should behave, not a brand fact) is classified
  // separately — this is exactly the case that prompted the distinction: the team teaching BB
  // how to introduce herself and adjust her tone, which must not be filed as a "brand fact".
  const ruleLog = [];
  const ruleNote = await extractMemoryNote(
    { userMessage: "Yeah you can keep changing according to people", bbAnswer: "Perfect. If it's Chinmay asking, maybe a little more edge. Sound right?" },
    { client: fakeClient(ruleLog, "RULE: When Chinmay asks who you are, add a bit more edge and banter; otherwise stay professional but warm.") },
  );
  check("a confirmed behavioural instruction is extracted as a rule, not a fact", ruleNote && ruleNote.type === "rule", ruleNote);
  check("the rule text has the RULE: prefix stripped", /Chinmay/.test((ruleNote && ruleNote.text) || ""), ruleNote);

  // A model that ignores the FACT:/RULE: format entirely still shouldn't lose a real note —
  // it degrades to a fact, the safer of the two categories to default to.
  const unlabelledNote = await extractMemoryNote(
    { userMessage: "The launch date moved to October 3rd.", bbAnswer: "Got it." },
    { client: fakeClient([], "The launch date moved to October 3rd.") },
  );
  check("an unlabelled response still yields a note, defaulting to a fact", unlabelledNote && unlabelledNote.type === "fact" && /October 3rd/.test(unlabelledNote.text), unlabelledNote);

  let extractionThrew = false;
  const safeResult = await extractMemoryNoteSafe(
    { userMessage: "The POC for Casa Waters is Priya.", bbAnswer: "Noted." },
    { client: { messages: { create: async () => { throw new Error("model unavailable"); } } } },
  ).catch(() => { extractionThrew = true; return "should not reach here"; });
  check("a failed extraction never throws — it degrades to no note", !extractionThrew && safeResult === null, safeResult);

  const emptyMessageNote = await extractMemoryNote({ userMessage: "", bbAnswer: "..." }, { client: fakeClient([]) });
  check("there is nothing to extract from an empty message", emptyMessageNote === null, emptyMessageNote);

  // ---- The task-action tool-use loop, only entered when taskActions is on ----
  function sequencedClient(log, responses) {
    let i = 0;
    return { messages: { create: async (params) => { log.push(params); const r = responses[Math.min(i, responses.length - 1)]; i += 1; return r; } } };
  }

  const findLog = [];
  const findResult = await askBB({
    brandName: "Loona Hub", message: "What does Anjali have open right now?", memory: null, taskActions: true,
  }, {
    client: sequencedClient(findLog, [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "find_tasks", input: { member: "Anjali" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Anjali has one open task: the Diwali reel." }] },
    ]),
    fbGet: async (path) => (path === "tasks" ? { t1: { task: "Shoot the Diwali reel", member: "Anjali", status: "Not Started" } } : null),
  });
  check("BB answers using what the tool actually found", /Diwali reel/.test(findResult.answer), findResult.answer);
  check("a read-only lookup takes exactly one extra model round trip", findLog.length === 2, findLog.length);
  check("the tool result handed back to BB actually contains what find_tasks found", /Diwali reel/.test(JSON.stringify(findLog[1].messages)), findLog[1].messages);

  const noActionsLog = [];
  await askBB({ brandName: "RRO Foods", message: "What does Anjali have open?", memory: null }, { client: fakeClient(noActionsLog) });
  check("without taskActions, BB is never even given the task-writing tools", !noActionsLog[0].tools.some((tool) => tool.name === "create_task"), noActionsLog[0].tools);

  // A write proposed and executed in the SAME turn must be refused — confirmation has to come
  // in the team's own next message, not be inferred from BB's own proposal.
  let pushCalled = false;
  const proposeLog = [];
  const proposeResult = await askBB({
    brandName: "Loona Hub", message: "Add a task for Anjali to shoot the Diwali reel.", memory: null, taskActions: true,
  }, {
    client: sequencedClient(proposeLog, [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu2", name: "create_task", input: { member: "Anjali", task: "Shoot the Diwali reel" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Here's what I'll add — say the word and I'll create it." }] },
    ]),
    fbPush: async () => { pushCalled = true; return "should-not-happen"; },
  });
  check("BB is told to describe the plan instead of having silently written it", /say the word/.test(proposeResult.answer), proposeResult.answer);
  check("nothing was actually written to the board on the proposing turn", !pushCalled, pushCalled);
  check("the blocked tool call told BB it needed confirmation first", /needsConfirmation/.test(JSON.stringify(proposeLog[1].messages)), proposeLog[1].messages);

  // The confirming turn itself, on the other hand, must go through.
  let pushedRecord = null;
  const confirmLog = [];
  await askBB({
    brandName: "Loona Hub", message: "Yes, go ahead and add it.", memory: null, taskActions: true, speaker: { name: "Ankita", verified: true },
  }, {
    client: sequencedClient(confirmLog, [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu3", name: "create_task", input: { member: "Anjali", task: "Shoot the Diwali reel" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done — added for Anjali." }] },
    ]),
    fbPush: async (writePath, value) => { pushedRecord = { writePath, value }; return "newkey"; },
  });
  check("a genuinely confirmed turn actually writes the task", pushedRecord && pushedRecord.writePath === "tasks", pushedRecord);
  check("the write is attributed to whoever actually confirmed it", pushedRecord && /Ankita/.test(pushedRecord.value.created_by), pushedRecord && pushedRecord.value);

  // A real production bug: WhatsApp resolves Gokul to his nickname "G" for how BB addresses
  // him, but a write has to be attributed to (and a schedule_meeting call has to book as) his
  // real /members roster name — otherwise the roster lookup fails outright, which is exactly
  // what happened. speaker.rosterName exists precisely to carry that real name through.
  let nicknameVsRoster = null;
  await askBB({
    brandName: "Loona Hub", message: "Yes, add it.", memory: null, taskActions: true,
    speaker: { name: "G", rosterName: "Gokul", verified: true },
  }, {
    client: sequencedClient([], [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu3b", name: "create_task", input: { member: "Anjali", task: "Shoot the Diwali reel" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
    ]),
    fbPush: async (writePath, value) => { nicknameVsRoster = value; return "newkey"; },
  });
  check("the write is attributed to the real roster name, not the conversational nickname", nicknameVsRoster && /Gokul/.test(nicknameVsRoster.created_by), nicknameVsRoster);
  check("the nickname itself never leaks into the attribution", nicknameVsRoster && !/\(asked by G\)/.test(nicknameVsRoster.created_by), nicknameVsRoster);

  // A model that keeps calling tools forever must not turn one chat message into an unbounded
  // number of Anthropic calls, and must still end with something to actually show the team.
  const runawayResponses = Array.from({ length: MAX_TOOL_ITERATIONS + 1 }, (_, index) => (
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: `loop${index}`, name: "find_tasks", input: {} }] }
  ));
  runawayResponses.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Here is what I have so far." }] });
  const runawayLog = [];
  const runawayResult = await askBB({
    brandName: "Loona Hub", message: "Keep checking the board.", memory: null, taskActions: true,
  }, { client: sequencedClient(runawayLog, runawayResponses), fbGet: async () => ({}) });
  check("the loop is capped rather than running forever", runawayLog.length === MAX_TOOL_ITERATIONS + 2, runawayLog.length);
  check("the forced final call carries no tools, so it cannot just keep calling more", Array.isArray(runawayLog[runawayLog.length - 1].tools) && runawayLog[runawayLog.length - 1].tools.length === 0, runawayLog[runawayLog.length - 1].tools);
  check("BB still returns real text to the team rather than nothing at all", /what I have so far/.test(runawayResult.answer), runawayResult.answer);

  // ---- Task tools and calendar tools can both be live in the same turn, correctly routed ----
  const bothToolsLog = [];
  let calendarDepsUsed = null;
  const bothToolsResult = await askBB({
    brandName: "Loona Hub", message: "What's on the calendar for Rahul?", memory: null, taskActions: true, calendarActions: true,
  }, {
    client: sequencedClient(bothToolsLog, [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu4", name: "find_meetings", input: { member: "Rahul" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Rahul has the Diwali shoot planning call on his calendar." }] },
    ]),
    fbGet: async (path) => {
      calendarDepsUsed = path;
      return path === "calendarEvents" ? { e1: { title: "Diwali shoot planning", knownAttendees: ["Rahul"] } } : null;
    },
  });
  check("both TASK_ACTION_TOOLS and CALENDAR_ACTION_TOOLS are offered to the model in the same turn", bothToolsLog[0].tools.some((t) => t.name === "create_task") && bothToolsLog[0].tools.some((t) => t.name === "schedule_meeting"), bothToolsLog[0].tools.map((t) => t.name));
  check("a calendar tool call is correctly routed to the calendar executor, not the task one", calendarDepsUsed === "calendarEvents", calendarDepsUsed);
  check("BB answers using what find_meetings actually found", /Diwali shoot planning/.test(bothToolsResult.answer), bothToolsResult.answer);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
