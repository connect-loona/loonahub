// Lets BB create and edit tasks on Loona Hub's task board from ordinary conversation, on Hub
// and on WhatsApp (see strategy-bb-chat-background.mjs and whatsapp-bb-reply-background.mjs,
// the two callers that turn this on — both resolve the speaker against the same Hub roster
// before treating a confirmation as trustworthy).
//
// Every write here is guarded by an explicit confirmation from the team, checked on the
// current turn's own message (looksLikeConfirmation) rather than trusting the model to have
// actually waited — a prompt instruction alone is not a safety net, this is. Attribution
// (created_by/updated_by) is enough on its own for mani-task-sync.js's existing 5-minute
// reconciliation to pick these writes up and log them under BB's name automatically; nothing
// extra needs to be recorded here.
//
// update_task never overrides Hub's own approval rules — it writes the exact same records
// index.html's own UI would: a due-date change from anyone but Gokul becomes a pending_due_date
// request (see submitDueDateChangeRequest); an assignee closing their own assigned-by-someone-
// else task pushes a real /approvals record (see handleDeckConfirm's fbAddApproval call) so it
// actually lands in that person's own "Pending Approvals" queue on Hub, not just a status flag
// nobody is watching for.
"use strict";
const { fbGet, fbPush, fbUpdate } = require("./firebase");

const VALID_STATUSES = ["Not Started", "In Progress", "Awaiting Approval", "Completed", "Deferred"];
const VALID_PRIORITIES = ["Low", "Medium", "High"];
const MAX_FIND_RESULTS = 30;

// IST, matching how fmtStamp is written everywhere else in Hub (the browser's own local
// clock, which for the team is already IST) — this file runs on Netlify's servers instead, so
// it has to shift UTC by hand to land on the same wall-clock time the team would see.
function fmtStamp() {
  const d = new Date(Date.now() + 5.5 * 3600000);
  const dd = String(d.getUTCDate()).padStart(2, "0"), mm = String(d.getUTCMonth() + 1).padStart(2, "0"), yy = String(d.getUTCFullYear()).slice(-2);
  const h = d.getUTCHours(), ap = h >= 12 ? "pm" : "am", h12 = ((h + 11) % 12) + 1, mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}-${mm}-${yy} ${h12}:${mi} ${ap}`;
}

// A deliberately narrow heuristic: this looks only at the message the team sent in this turn,
// not at any stored proposal, so it cannot be fooled by a stale earlier exchange. A negation
// anywhere in the message wins over a confirmation word appearing elsewhere in it — "no wait,
// don't do that yet" must never read as a yes because of nothing but "do".
const CONFIRM_RE = /\b(yes|yep|yeah|yup|go ahead|go for it|do it|confirmed?|please do|proceed|sounds good|makes sense|that'?s right|approved?|correct)\b/i;
const NEGATE_RE = /\b(no|nope|not yet|don'?t|do not|wait|hold on|hold off|cancel|actually)\b/i;

function looksLikeConfirmation(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  if (NEGATE_RE.test(text)) return false;
  return CONFIRM_RE.test(text);
}

const TASK_ACTION_TOOLS = [
  {
    name: "find_tasks",
    description: "Search Loona Hub's live task board. Read-only — use it to look up a task's id before editing it, to check what's already on the board before adding something that might be a duplicate, or to answer any question about whose board has what. Hub's own Task Board page draws this exact same distinction, and you should too: member is whose task it actually is (use this for \"what's on my board\"); assigned_by is who delegated it to them (use this for \"what have I assigned to others\" — a task is never \"yours\" just because you assigned_by it); overseer is someone looped in for visibility only, neither the owner nor the delegator (use this for \"what am I overseeing\"). Returns only what is actually recorded; never call this expecting it to guess.",
    input_schema: {
      type: "object",
      properties: {
        member: { type: "string", description: "Filter to tasks actually assigned TO this person — this is whose task it is. By first name." },
        assigned_by: { type: "string", description: "Filter to tasks this person delegated to someone else — this does NOT mean the task belongs to them. By first name, or \"Myself\"/\"Google Calendar\" for the same neutral values the board itself uses." },
        overseer: { type: "string", description: "Filter to tasks this person is looped in on for visibility, without owning or having assigned them. By first name." },
        brand: { type: "string", description: "Filter to tasks under this brand." },
        status: { type: "string", description: "Filter to this exact status, e.g. \"Not Started\", \"In Progress\", \"Completed\"." },
        query: { type: "string", description: "Filter to tasks whose description contains this text (case-insensitive)." },
      },
    },
  },
  {
    name: "create_task",
    description: "Add a new task to Loona Hub's task board. Only call this after you have already told the team exactly what you are about to create and they have explicitly confirmed it in their NEXT message — never on the same message that first proposes it. Make sure you actually have every field Hub's own Add Task form asks for before you propose it — who it's for, the brand, the description, priority, and due date — asking for whatever's missing rather than guessing.",
    input_schema: {
      type: "object",
      properties: {
        member: { type: "string", description: "Who the task is assigned to, by first name, exactly as it appears in Hub's team directory." },
        task: { type: "string", description: "The task description." },
        brand: { type: "string", description: "The brand this task is for. Use \"Loona\" for internal work that isn't personal and isn't tied to any client brand — omit only for a genuinely personal to-do." },
        priority: { type: "string", enum: VALID_PRIORITIES },
        due_date: { type: "string", description: "YYYY-MM-DD. Omit if there is no due date." },
        due_time: { type: "string", description: "HH:MM, 24-hour. Optional — only set this when it's a real deadline moment, not just a date, matching Hub's own due-time field (it triggers a deadline reminder). Never invent one; only set it if actually given a time." },
        is_personal: { type: "boolean", description: "True for a personal to-do rather than brand work." },
        overseers: { type: "array", items: { type: "string" }, description: "Anyone who should be looped in on this task for visibility only (Hub's own \"loop in\" option on the Add Task form), by first name — never the assignee themself. Ask whether anyone should be looped in; don't assume the answer is no." },
        assigned_by: { type: "string", description: "Who is actually assigning this task, by first name. Defaults to whoever is asking you to create it (or \"Myself\" if they're assigning it to their own name) exactly like Hub's own form — only set this when they are clearly creating it on someone else's behalf as a different assigner." },
      },
      required: ["member", "task"],
    },
  },
  {
    name: "update_task",
    description: "Edit a task that is already on the board. Only call this after you have already told the team exactly what you are about to change and they have explicitly confirmed it in their NEXT message — never on the same message that first proposes it. Look the task up with find_tasks first if you don't already know its id. Hub itself gates two things behind approval — changing a due date (only Gokul can set it directly; anyone else's change goes to Gokul to approve, and needs a reason) and marking your own assigned-by-someone-else task Completed or Deferred (goes to the assigner for sign-off instead of closing immediately) — and this tool respects the exact same gates rather than writing straight to the board. The result tells you whether your change applied immediately or is now pending someone else's approval; say whichever one actually happened, don't assume it's done.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task's id, from find_tasks." },
        status: { type: "string", enum: VALID_STATUSES },
        due_date: { type: "string", description: "YYYY-MM-DD, or an empty string to clear it." },
        due_date_reason: { type: "string", description: "Why the date is moving. Required whenever due_date is being changed by anyone other than Gokul — ask them for it before calling this if you don't already have it." },
        due_time: { type: "string", description: "HH:MM, 24-hour, or an empty string to clear it." },
        priority: { type: "string", enum: VALID_PRIORITIES },
        task: { type: "string", description: "A revised task description." },
        overseers: { type: "array", items: { type: "string" }, description: "The FULL list of who should be looped in — only pass this when who's looped in is itself what's changing; it replaces the existing list rather than adding to it." },
      },
      required: ["task_id"],
    },
  },
];

// Mirrors lnResolveAssignedBy() in index.html exactly: assigning to yourself always reads as
// "Myself" regardless of who's speaking, an explicit assigner overrides that, and otherwise the
// assigner defaults to whoever is actually asking BB to do this — never a literal "BB", which
// isn't a real person Hub's own approval routing (statusApprovalGates below) could ever notify.
function resolveAssignedBy(member, speakerName, explicitAssignedBy) {
  const assignee = String(member || "").trim();
  const speaker = String(speakerName || "").trim();
  if (assignee && speaker && normName(assignee) === normName(speaker)) return "Myself";
  const explicit = String(explicitAssignedBy || "").trim();
  if (explicit) return explicit;
  return speaker || "BB";
}

// Assignees who don't represent a real person to route an approval to — matches the exact
// carve-out updateStatus() has in index.html for a self-assigned or calendar-generated task.
const NEUTRAL_ASSIGNERS = new Set(["myself", "me", "google calendar", ""]);
function normName(value) { return String(value || "").trim().toLowerCase(); }

// Mirrors updateStatus()'s own gate in index.html: marking your OWN assigned-by-someone-else
// task Completed/Deferred goes to the assigner and/or Gokul instead of closing immediately —
// these are two INDEPENDENT approval requirements in the real UI (a task can need either, both,
// or neither), not one combined flag, so callers need both bits to know who to actually notify.
// When BB doesn't know who's confirming, this defaults to requiring approval rather than
// guessing it's safe to skip — the same reasoning as the confirmation gate itself: an
// unprovable case is treated as the one that needs a human.
function statusApprovalGates(existing, status, speakerName) {
  const none = { assignerNeedsApproval: false, gokulNeedsApproval: false };
  if (status !== "Completed" && status !== "Deferred") return none;
  if (existing.is_personal) return none;
  if (normName(speakerName) === "gokul") return none;
  const speakerIsAssignee = !speakerName || normName(existing.member) === normName(speakerName);
  if (!speakerIsAssignee) return none;
  const assignedBy = String(existing.assigned_by || "").trim();
  const assignerNeedsApproval = !NEUTRAL_ASSIGNERS.has(normName(assignedBy)) && normName(assignedBy) !== normName(speakerName || "");
  return { assignerNeedsApproval, gokulNeedsApproval: !!existing.looped_in_gokul };
}

async function findTasks({ member, assigned_by: assignedBy, overseer, brand, status, query } = {}, deps = {}) {
  const get = deps.fbGet || fbGet;
  const tasks = (await get("tasks")) || {};
  const wantedMember = member ? String(member).trim().toLowerCase() : null;
  const wantedAssignedBy = assignedBy ? String(assignedBy).trim().toLowerCase() : null;
  const wantedOverseer = overseer ? String(overseer).trim().toLowerCase() : null;
  const wantedBrand = brand ? String(brand).trim().toLowerCase() : null;
  const wantedStatus = status ? String(status).trim().toLowerCase() : null;
  const wantedQuery = query ? String(query).trim().toLowerCase() : null;
  const results = [];
  for (const [id, task] of Object.entries(tasks)) {
    if (!task) continue;
    if (wantedMember && String(task.member || "").trim().toLowerCase() !== wantedMember) continue;
    if (wantedAssignedBy && String(task.assigned_by || "").trim().toLowerCase() !== wantedAssignedBy) continue;
    if (wantedOverseer && !(Array.isArray(task.overseers) ? task.overseers : []).some((name) => String(name || "").trim().toLowerCase() === wantedOverseer)) continue;
    if (wantedBrand && String(task.brand || "").trim().toLowerCase() !== wantedBrand) continue;
    if (wantedStatus && String(task.status || "").trim().toLowerCase() !== wantedStatus) continue;
    if (wantedQuery && !String(task.task || "").toLowerCase().includes(wantedQuery)) continue;
    results.push({
      id, member: task.member || null, brand: task.brand || null, task: task.task || null,
      status: task.status || null, priority: task.priority || null, due_date: task.due_date || null,
      is_personal: !!task.is_personal, assigned_by: task.assigned_by || null,
      overseers: Array.isArray(task.overseers) ? task.overseers : [],
    });
    if (results.length >= MAX_FIND_RESULTS) break;
  }
  return results;
}

async function createTask({ member, task, brand, priority, due_date, due_time, is_personal, overseers, assigned_by }, ctx = {}, deps = {}) {
  const push = deps.fbPush || fbPush;
  const name = String(member || "").trim();
  const description = String(task || "").trim();
  if (!name) throw new Error("create_task needs a member to assign it to.");
  if (!description) throw new Error("create_task needs a task description.");
  if (priority && !VALID_PRIORITIES.includes(priority)) throw new Error(`"${priority}" is not a valid priority — use one of ${VALID_PRIORITIES.join(", ")}.`);
  const personal = !!is_personal;
  const record = {
    member: name,
    task: description,
    is_personal: personal,
    priority: VALID_PRIORITIES.includes(priority) ? priority : "Medium",
    status: "Not Started",
    due_date: due_date ? String(due_date).trim() : "",
    due_time: due_time ? String(due_time).trim() : "",
    assigned_by: resolveAssignedBy(name, ctx.speakerName, assigned_by),
    overseers: Array.isArray(overseers) ? [...new Set(overseers.map((o) => String(o || "").trim()).filter(Boolean))] : [],
    created_at: new Date().toISOString(),
    assigned_on: fmtStamp(),
    created_by: `BB (asked by ${ctx.speakerName || "the team"})`,
    created_via: "bb_task_actions",
  };
  if (brand && !personal) {
    const brandName = String(brand).trim();
    record.brand = brandName;
    record.brands = [brandName];
  }
  const id = await push("tasks", record);
  return { id, ...record };
}

async function updateTask({ task_id, status, due_date, due_date_reason, due_time, priority, task, overseers }, ctx = {}, deps = {}) {
  const get = deps.fbGet || fbGet;
  const update = deps.fbUpdate || fbUpdate;
  const push = deps.fbPush || fbPush;
  const id = String(task_id || "").trim();
  if (!id) throw new Error("update_task needs a task_id — look it up with find_tasks first.");
  const existing = await get(`tasks/${id}`);
  if (!existing) throw new Error(`No task found with id "${id}". Use find_tasks to look up the right id first.`);
  if (status && !VALID_STATUSES.includes(status)) throw new Error(`"${status}" is not a valid status — use one of ${VALID_STATUSES.join(", ")}.`);
  if (priority && !VALID_PRIORITIES.includes(priority)) throw new Error(`"${priority}" is not a valid priority — use one of ${VALID_PRIORITIES.join(", ")}.`);

  const speakerName = ctx.speakerName || null;
  const patch = { updated_by: `BB (asked by ${speakerName || "the team"})` };
  const notes = [];

  // Due dates: only Gokul can move one directly (updateDueDate() in index.html) — anyone else's
  // change becomes the same pending request Hub's own date-change modal writes, reason and
  // all, so it shows up in Gokul's approval queue exactly like one submitted by hand.
  if (due_date !== undefined) {
    if (normName(speakerName) === "gokul") {
      patch.due_date = String(due_date).trim();
      patch.due_changed_at = fmtStamp();
      patch.due_changed_by = speakerName;
    } else {
      const reason = String(due_date_reason || "").trim();
      if (!reason) throw new Error("A due-date change from anyone but Gokul needs a reason, the same as Hub's own date-change request — ask them why before calling update_task again with due_date_reason set.");
      patch.pending_due_date = String(due_date).trim();
      patch.pending_due_reason = reason;
      patch.pending_due_requested_by = speakerName || "the team (via BB)";
      patch.pending_due_requested_at = new Date().toISOString();
      notes.push(`The due date itself has not changed yet — this is now waiting on Gokul to approve moving it to ${patch.pending_due_date || "no date"}.`);
    }
  }

  // Completing/deferring your own assigned-by-someone-else task: same gate as updateStatus()/
  // handleDeckConfirm() in index.html. Two independent things can happen, exactly as they do
  // when a person does this by hand — the task's own status flips to Awaiting Approval/
  // Deferral, AND, when a real person (not Gokul, not "myself") is the assigner, a genuine
  // /approvals record is pushed so it actually lands in THEIR "Pending Approvals" queue on
  // Hub — not just a status column nobody happens to be watching.
  if (status) {
    const { assignerNeedsApproval, gokulNeedsApproval } = statusApprovalGates(existing, status, speakerName);
    if (assignerNeedsApproval || gokulNeedsApproval) {
      const reqType = status === "Deferred" ? "deferral" : "completion";
      const awaiting = reqType === "deferral" ? "Awaiting Deferral" : "Awaiting Approval";
      patch.status = awaiting;
      patch.submitted_at = new Date().toISOString();
      patch.pending_prev_status = existing.status || null;
      if (gokulNeedsApproval) patch.gokul_approval = "pending";
      const waitingOn = [];
      if (assignerNeedsApproval) {
        await push("approvals", {
          id: Date.now(),
          taskKey: id,
          taskTitle: existing.task || null,
          member: existing.member || null,
          assigner: existing.assigned_by,
          brand: existing.brand || null,
          requestedAt: new Date().toISOString(),
          status: "pending",
          type: reqType,
          prevStatus: existing.status || null,
        });
        waitingOn.push(existing.assigned_by);
      }
      if (gokulNeedsApproval) waitingOn.push("Gokul");
      notes.push(`This is not closed yet — it's now ${awaiting}, waiting on ${waitingOn.join(" and ")} to sign off.`);
    } else {
      patch.status = status;
      patch.status_at = fmtStamp();
    }
  }

  if (priority) patch.priority = priority;
  if (task) patch.task = String(task).trim();
  if (due_time !== undefined) patch.due_time = String(due_time).trim();
  if (overseers !== undefined) patch.overseers = Array.isArray(overseers) ? [...new Set(overseers.map((o) => String(o || "").trim()).filter(Boolean))] : [];
  await update(`tasks/${id}`, patch);
  return { id, ...existing, ...patch, notes: notes.length ? notes : undefined };
}

// The one gate every write goes through. ctx.confirmed comes from looksLikeConfirmation
// against the current turn's own message — find_tasks is read-only and always allowed, since
// looking something up commits to nothing.
async function executeTaskAction(name, input, ctx = {}, deps = {}) {
  if (name === "find_tasks") return { ok: true, results: await findTasks(input, deps) };
  if (name === "create_task" || name === "update_task") {
    if (!ctx.confirmed) {
      return {
        ok: false,
        needsConfirmation: true,
        message: "Not done — the team has not yet confirmed this in their own message. Tell them exactly what you are about to do and wait for them to say yes before calling this again.",
      };
    }
    const result = name === "create_task" ? await createTask(input, ctx, deps) : await updateTask(input, ctx, deps);
    return { ok: true, task: result };
  }
  throw new Error(`Unknown task action tool "${name}".`);
}

module.exports = {
  TASK_ACTION_TOOLS, executeTaskAction, findTasks, createTask, updateTask, looksLikeConfirmation,
  resolveAssignedBy, VALID_STATUSES, VALID_PRIORITIES,
};
