// BB creating and editing tasks on Loona Hub's task board through conversation.
//
// The thing most worth testing here is not the happy path — it's that a write never happens
// without the team having explicitly confirmed it in their own message, and that BB can never
// touch anything outside the plain task fields (never payroll, salary, or anything from
// /members_sensitive).
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const {
  TASK_ACTION_TOOLS, executeTaskAction, findTasks, createTask, updateTask, looksLikeConfirmation,
  VALID_STATUSES, VALID_PRIORITIES,
} = require(path.join(HUB, "netlify/functions/lib/strategy/bb-task-actions"));

(async () => {
  await req("PUT", `${RTDB_URL}/tasks.json`, null);
  await req("PUT", `${RTDB_URL}/approvals.json`, null);

  // ---- The confirmation gate: this turn's own message only ----
  check("a plain yes reads as confirmation", looksLikeConfirmation("Yes, go ahead."));
  check("\"do it\" reads as confirmation", looksLikeConfirmation("Do it."));
  check("a bare description with no confirming language does not", !looksLikeConfirmation("We need to fix the pack shot."));
  check("a no is never treated as a yes even if it contains a confirming word", !looksLikeConfirmation("No, don't do it yet."));
  check("\"wait\" overrides an otherwise confirming word nearby", !looksLikeConfirmation("Wait, actually hold off on that."));
  check("an empty message is never a confirmation", !looksLikeConfirmation(""));

  // ---- The tool schemas themselves ----
  check("exactly the three intended tools are exposed", TASK_ACTION_TOOLS.map((t) => t.name).join() === "find_tasks,create_task,update_task", TASK_ACTION_TOOLS.map((t) => t.name));
  check("create_task requires a member and a task", JSON.stringify(TASK_ACTION_TOOLS.find((t) => t.name === "create_task").input_schema.required) === '["member","task"]');
  check("update_task requires a task_id", TASK_ACTION_TOOLS.find((t) => t.name === "update_task").input_schema.required.includes("task_id"));

  // ---- find_tasks: read-only, always allowed, never needs confirmation ----
  await req("PUT", `${RTDB_URL}/tasks.json`, {
    t1: { task: "Shoot the Diwali reel", member: "Anjali", brand: "RRO Foods", status: "Not Started" },
    t2: { task: "Fix the pack shot", member: "Rahul", brand: "RRO Foods", status: "In Progress" },
    t3: { task: "Casa brand deck", member: "Priya", brand: "Casa Waters", status: "Completed" },
  });
  const byMember = await findTasks({ member: "anjali" });
  check("find_tasks filters by member, case-insensitively", byMember.length === 1 && byMember[0].task === "Shoot the Diwali reel", byMember);
  const byBrand = await findTasks({ brand: "RRO Foods" });
  check("find_tasks filters by brand", byBrand.length === 2, byBrand);
  const byQuery = await findTasks({ query: "pack shot" });
  check("find_tasks filters by a text query against the description", byQuery.length === 1 && byQuery[0].member === "Rahul", byQuery);
  const unconfirmedFind = await executeTaskAction("find_tasks", { brand: "Casa Waters" }, { confirmed: false });
  check("find_tasks runs even when the turn was not a confirmation — it's read-only", unconfirmedFind.ok && unconfirmedFind.results.length === 1, unconfirmedFind);

  // ---- create_task and update_task are refused outright without a confirmed turn ----
  const blockedCreate = await executeTaskAction("create_task", { member: "Anjali", task: "New task" }, { confirmed: false });
  check("create_task is refused when the current message wasn't a confirmation", blockedCreate.ok === false && blockedCreate.needsConfirmation === true, blockedCreate);
  const beforeCreate = await req("GET", `${RTDB_URL}/tasks.json`);
  check("nothing was actually written to the board by the refused call", Object.keys(beforeCreate.body || {}).length === 3, beforeCreate.body);

  const blockedUpdate = await executeTaskAction("update_task", { task_id: "t1", status: "Completed" }, { confirmed: false });
  check("update_task is refused the same way", blockedUpdate.ok === false && blockedUpdate.needsConfirmation === true, blockedUpdate);

  // ---- Once confirmed, the write actually happens, with BB's attribution ----
  const created = await executeTaskAction("create_task", { member: "Vishnu", task: "Write October captions", brand: "RRO Foods", priority: "High", due_date: "2026-10-01" }, { confirmed: true, speakerName: "Ankita" });
  check("a confirmed create_task actually creates the task", created.ok === true && created.task.task === "Write October captions", created);
  check("the new task is assigned to the right member with the right priority and due date", created.task.member === "Vishnu" && created.task.priority === "High" && created.task.due_date === "2026-10-01", created.task);
  check("it starts life as Not Started", created.task.status === "Not Started", created.task);
  check("it records who actually asked BB for it", /Ankita/.test(created.task.created_by), created.task.created_by);
  check("it carries a marker that it came through BB, for anyone auditing the board later", created.task.created_via === "bb_task_actions", created.task);
  const afterCreate = await req("GET", `${RTDB_URL}/tasks/${created.task.id}.json`);
  check("the task is genuinely on the live board, not just in the return value", afterCreate.body && afterCreate.body.task === "Write October captions", afterCreate.body);

  const updated = await executeTaskAction("update_task", { task_id: "t2", status: "Completed" }, { confirmed: true, speakerName: "Rahul" });
  check("a confirmed update_task actually changes the task", updated.ok === true && updated.task.status === "Completed", updated);
  check("it records a status_at timestamp when the status changes", Boolean(updated.task.status_at), updated.task);
  check("it records who asked for the change", /Rahul/.test(updated.task.updated_by), updated.task.updated_by);
  const afterUpdate = await req("GET", `${RTDB_URL}/tasks/t2.json`);
  check("the status change is genuinely on the live board", afterUpdate.body && afterUpdate.body.status === "Completed", afterUpdate.body);
  check("fields that weren't part of the update are untouched", afterUpdate.body.member === "Rahul", afterUpdate.body);

  // ---- update_task respects Hub's own approval gates rather than overriding them ----
  // PATCH, not PUT — this merges alongside t1/t2/t3, which the validation section further
  // down still needs, rather than wiping the whole /tasks collection out from under it.
  await req("PATCH", `${RTDB_URL}/tasks.json`, {
    d1: { task: "Client deck", member: "Anjali", assigned_by: "Ankita", status: "In Progress" },
    d2: { task: "Personal errand", member: "Anjali", assigned_by: "Ankita", status: "Not Started", is_personal: true },
    d3: { task: "Self-assigned note", member: "Anjali", assigned_by: "myself", status: "In Progress" },
    d4: { task: "Looped in Gokul", member: "Anjali", assigned_by: "myself", status: "In Progress", looped_in_gokul: true },
  });

  let noReason = null;
  try { await updateTask({ task_id: "d1", due_date: "2026-10-05" }, { speakerName: "Anjali" }); } catch (error) { noReason = error.message; }
  check("a non-Gokul due-date change without a reason is refused, same as Hub's own modal requires one", /needs a reason/.test(noReason || ""), noReason);

  const pendingDate = await updateTask({ task_id: "d1", due_date: "2026-10-05", due_date_reason: "Client pushed the review." }, { speakerName: "Anjali" });
  check("a non-Gokul due-date change does not touch the live due_date", pendingDate.due_date === undefined, pendingDate);
  check("it writes the exact same pending request Hub's own date-change modal writes", pendingDate.pending_due_date === "2026-10-05" && pendingDate.pending_due_reason === "Client pushed the review." && pendingDate.pending_due_requested_by === "Anjali", pendingDate);
  check("BB is told this is still pending, not done", pendingDate.notes && /waiting on Gokul/.test(pendingDate.notes.join(" ")), pendingDate.notes);
  const afterPendingDate = await req("GET", `${RTDB_URL}/tasks/d1.json`);
  check("the live due_date genuinely never moved", !afterPendingDate.body.due_date, afterPendingDate.body);

  const gokulDate = await updateTask({ task_id: "d1", due_date: "2026-10-05" }, { speakerName: "Gokul" });
  check("Gokul himself can still move a due date directly, exactly like the UI lets him", gokulDate.due_date === "2026-10-05" && Boolean(gokulDate.due_changed_at), gokulDate);
  check("a direct Gokul change carries no pending-approval note", !gokulDate.notes, gokulDate.notes);

  const assigneeCloses = await updateTask({ task_id: "d1", status: "Completed" }, { speakerName: "Anjali" });
  check("the assignee closing their own assigned-by-someone-else task does not close it directly", assigneeCloses.status === "Awaiting Approval", assigneeCloses);
  check("it names who it's actually waiting on", assigneeCloses.notes && /Ankita/.test(assigneeCloses.notes.join(" ")), assigneeCloses.notes);
  check("it records what the status was before this, for the approval decision to fall back on", assigneeCloses.pending_prev_status === "In Progress", assigneeCloses);
  const afterAssigneeCloses = await req("GET", `${RTDB_URL}/tasks/d1.json`);
  check("the live board reflects Awaiting Approval, not Completed", afterAssigneeCloses.body.status === "Awaiting Approval", afterAssigneeCloses.body);

  // This is the part that actually notifies the assigner — a status flag alone is not a
  // request anyone is watching for; the real /approvals record is what shows up in their own
  // "Pending Approvals" queue on Hub (renderApprovalRequests in index.html).
  const approvalsAfterAssignee = Object.values(((await req("GET", `${RTDB_URL}/approvals.json`)) || {}).body || {});
  const ankitaApproval = approvalsAfterAssignee.find((r) => r.taskKey === "d1" && r.status === "pending");
  check("a genuine approval request is pushed for the assigner to see", Boolean(ankitaApproval), approvalsAfterAssignee);
  check("it names the right assigner, task and type", ankitaApproval && ankitaApproval.assigner === "Ankita" && ankitaApproval.taskTitle === "Client deck" && ankitaApproval.type === "completion", ankitaApproval);

  const assignerCloses = await updateTask({ task_id: "d1", status: "Completed" }, { speakerName: "Ankita" });
  check("the assigner themself confirming can close it directly, same as the UI lets anyone but the assignee do", assignerCloses.status === "Completed", assignerCloses);

  const personalCloses = await updateTask({ task_id: "d2", status: "Completed" }, { speakerName: "Anjali" });
  check("a personal task closes directly regardless of who confirmed it — there's no assigner to protect", personalCloses.status === "Completed", personalCloses);

  const selfAssignedCloses = await updateTask({ task_id: "d3", status: "Completed" }, { speakerName: "Anjali" });
  check("a self-assigned task closes directly, matching the UI's own carve-out for 'myself'", selfAssignedCloses.status === "Completed", selfAssignedCloses);

  const loopedInGokulCloses = await updateTask({ task_id: "d4", status: "Deferred" }, { speakerName: "Anjali" });
  check("looped_in_gokul still requires sign-off even on an otherwise self-assigned task", loopedInGokulCloses.status === "Awaiting Deferral", loopedInGokulCloses);
  check("that approval is attributed to Gokul, not a nonexistent assigner", loopedInGokulCloses.notes && /Gokul/.test(loopedInGokulCloses.notes.join(" ")), loopedInGokulCloses.notes);
  const afterLoopedIn = await req("GET", `${RTDB_URL}/tasks/d4.json`);
  check("gokul_approval flips to pending — the actual field Gokul's own approval board reads", afterLoopedIn.body.gokul_approval === "pending", afterLoopedIn.body);
  const approvalsAfterLoop = Object.values(((await req("GET", `${RTDB_URL}/approvals.json`)) || {}).body || {});
  check("a self-assigned, looped-in-Gokul task pushes no /approvals record — there is no real assigner to notify that way", !approvalsAfterLoop.some((r) => r.taskKey === "d4"), approvalsAfterLoop);

  const gokulOverridesLoop = await updateTask({ task_id: "d4", status: "Completed" }, { speakerName: "Gokul" });
  check("Gokul confirming himself always closes directly, even on a looped-in task", gokulOverridesLoop.status === "Completed", gokulOverridesLoop);

  // ---- Both gates can fire together, exactly as they can by hand ----
  await req("PATCH", `${RTDB_URL}/tasks.json`, {
    d5: { task: "Both gates", member: "Anjali", assigned_by: "Ankita", status: "In Progress", looped_in_gokul: true },
  });
  const bothGates = await updateTask({ task_id: "d5", status: "Completed" }, { speakerName: "Anjali" });
  check("a task with a real assigner AND looped_in_gokul needs both to sign off", bothGates.status === "Awaiting Approval", bothGates);
  check("both approvers are named", bothGates.notes && /Ankita/.test(bothGates.notes.join(" ")) && /Gokul/.test(bothGates.notes.join(" ")), bothGates.notes);
  const afterBothGates = await req("GET", `${RTDB_URL}/tasks/d5.json`);
  check("gokul_approval is set on the task itself", afterBothGates.body.gokul_approval === "pending", afterBothGates.body);
  const approvalsAfterBoth = Object.values(((await req("GET", `${RTDB_URL}/approvals.json`)) || {}).body || {});
  check("AND a real /approvals record is pushed for Ankita, independently of Gokul's own sign-off", approvalsAfterBoth.some((r) => r.taskKey === "d5" && r.assigner === "Ankita"), approvalsAfterBoth);

  // ---- A personal task never gets a brand attached, even if one is supplied ----
  const personal = await createTask({ member: "Priya", task: "Book a dentist appointment", brand: "Casa Waters", is_personal: true }, { speakerName: "Priya" });
  check("a personal task ignores a supplied brand", !personal.brand && !personal.brands, personal);

  // ---- Validation: BB can't invent a status or priority that doesn't exist on the board ----
  let badStatus = null;
  try { await updateTask({ task_id: "t1", status: "On Fire" }, {}); } catch (error) { badStatus = error.message; }
  check("an invalid status is rejected rather than silently written", /not a valid status/.test(badStatus || ""), badStatus);
  check("the valid statuses are exactly the ones BB is allowed to set", VALID_STATUSES.join() === "Not Started,In Progress,Awaiting Approval,Completed,Deferred", VALID_STATUSES);

  let badPriority = null;
  try { await createTask({ member: "Anjali", task: "x", priority: "Urgent!!" }, {}); } catch (error) { badPriority = error.message; }
  check("an invalid priority is rejected", /not a valid priority/.test(badPriority || ""), badPriority);
  check("the valid priorities match what the board itself offers", VALID_PRIORITIES.join() === "Low,Medium,High", VALID_PRIORITIES);

  let missingMember = null;
  try { await createTask({ task: "No one assigned" }, {}); } catch (error) { missingMember = error.message; }
  check("create_task refuses a task with nobody assigned", /needs a member/.test(missingMember || ""), missingMember);

  let missingTaskId = null;
  try { await updateTask({ status: "Completed" }, {}); } catch (error) { missingTaskId = error.message; }
  check("update_task refuses to run with no task_id", /needs a task_id/.test(missingTaskId || ""), missingTaskId);

  let unknownTaskId = null;
  try { await updateTask({ task_id: "does-not-exist", status: "Completed" }, {}); } catch (error) { unknownTaskId = error.message; }
  check("updating a task id that doesn't exist fails clearly instead of writing a new, empty task", /No task found/.test(unknownTaskId || ""), unknownTaskId);

  // ---- A genuinely unknown tool name is a bug, not silently ignored ----
  let unknownTool = null;
  try { await executeTaskAction("delete_everything", {}, { confirmed: true }); } catch (error) { unknownTool = error.message; }
  check("an unrecognised tool name throws rather than doing nothing quietly", /Unknown task action tool/.test(unknownTool || ""), unknownTool);

  await req("PUT", `${RTDB_URL}/tasks.json`, null);
  await req("PUT", `${RTDB_URL}/approvals.json`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
