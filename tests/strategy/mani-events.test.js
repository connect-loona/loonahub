// Mani's continuous ledger and the reconciliation bridge for legacy client-written tasks.
"use strict";

process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { recordManiEvent, loadRecentManiEvents, maniEventsToPromptText } = require(path.join(HUB, "netlify/functions/lib/strategy/mani-events"));
const { reconcileTasks } = require(path.join(HUB, "netlify/functions/lib/strategy/mani-task-sync"));
const { reconcileOperationalActivity } = require(path.join(HUB, "netlify/functions/lib/strategy/mani-operational-sync"));

(async () => {
  await req("PUT", `${RTDB_URL}/mani_events.json`, null);
  await req("PUT", `${RTDB_URL}/mani_brand_events.json`, null);
  await req("PUT", `${RTDB_URL}/mani_snapshots.json`, null);
  await req("PUT", `${RTDB_URL}/tasks.json`, { t1: { task: "Prepare launch", brand: "RRO Foods", member: "Anjali", status: "Not Started" } });

  await recordManiEvent({ type: "concept_approved", source: "strategy_os", brandId: "rro-foods", actor: "Gokul", entityType: "concept", entityId: "c1", action: "approved", summary: "Approved the founder-led launch concept." });
  const events = await loadRecentManiEvents("rro-foods");
  check("a brand event is written to Mani's ledger", events.length === 1 && events[0].type === "concept_approved", events);
  check("the event retains actor and evidence summary", events[0].actor === "Gokul" && /founder-led/.test(events[0].summary), events[0]);
  check("recent events can be supplied to BB and agents", /Mani's recent event timeline/.test(maniEventsToPromptText(events)), maniEventsToPromptText(events));

  const baseline = await reconcileTasks();
  check("the first task reconciliation establishes a quiet baseline", baseline.baseline === true && baseline.changes === 0, baseline);
  await req("PATCH", `${RTDB_URL}/tasks/t1.json`, { status: "Done", updated_by: "Anjali" });
  const changed = await reconcileTasks();
  check("a later direct task edit becomes a Mani event", changed.changes === 1, changed);
  const taskEvents = await loadRecentManiEvents("rro-foods");
  check("the task event records the new state and actor", taskEvents.some((event) => event.type === "task_updated" && event.actor === "Anjali" && /Done/.test(event.summary)), taskEvents);

  await req("PUT", `${RTDB_URL}/calendarEvents.json`, { c1: { title: "Launch review", brand: "RRO Foods", organizer: "Anjali", start: "2026-10-01T10:00:00+05:30", guestEmails: ["private@example.com"] } });
  await req("PUT", `${RTDB_URL}/meetingNotes.json`, { n1: { title: "Launch review", brand: "RRO Foods", recordedBy: "Anjali", summary: "Approved the launch route.", transcript: "This raw transcript must not be copied." } });
  const operationsBaseline = await reconcileOperationalActivity();
  check("operational sources establish a quiet baseline", operationsBaseline.changes === 0, operationsBaseline);
  await req("PATCH", `${RTDB_URL}/meetingNotes/n1.json`, { summary: "Approved the launch route and Friday delivery." });
  const operationsChanged = await reconcileOperationalActivity();
  check("meeting note changes become Mani events", operationsChanged.changes === 1, operationsChanged);
  const operationEvents = await loadRecentManiEvents("rro-foods");
  const noteEvent = operationEvents.find((event) => event.type === "meeting_notes_updated");
  check("meeting memory retains the useful summary", noteEvent && /Friday delivery/.test(noteEvent.summary), noteEvent);
  check("raw transcripts and guest emails are excluded from Mani", noteEvent && !/raw transcript|private@example/.test(JSON.stringify(noteEvent)), noteEvent);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
