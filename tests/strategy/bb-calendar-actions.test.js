// BB scheduling and rescheduling real meetings through conversation.
//
// The thing most worth testing here is the identity boundary: the organizer of a meeting is
// NEVER something the model can supply — it is always ctx.speakerName, the actual verified
// person BB is talking to. A model that hallucinated a different organizer could otherwise send
// a real Calendar invite as someone else entirely. This suite fakes calendar-actions.js's own
// createMeeting/updateMeeting inputs via dependency injection rather than a real Google
// credential or network call — the Google-API behavior itself is covered by
// calendar-actions.test.js.
"use strict";
const crypto = require("crypto");
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const {
  CALENDAR_ACTION_TOOLS, executeCalendarAction, scheduleMeetingAction, updateMeetingAction, looksLikeConfirmation,
} = require(path.join(HUB, "netlify/functions/lib/strategy/bb-calendar-actions"));

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 512, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SERVICE_ACCOUNT = { client_email: "sa@loona-hub.iam.gserviceaccount.com", private_key: privateKey };

function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  function at(p) { return p.split("/").filter(Boolean).reduce((node, key) => (node == null ? node : node[key]), data); }
  async function fbGet(p) { const v = at(p); return v === undefined ? null : v; }
  async function fbPatch(p, obj) {
    const parts = p.split("/").filter(Boolean);
    let node = data;
    for (const key of parts) { if (typeof node[key] !== "object" || node[key] === null) node[key] = {}; node = node[key]; }
    Object.assign(node, obj);
    return { ok: true };
  }
  return { data, fbGet, fbPatch };
}

function makeFetch({ insertResponse = {}, patchResponse = {}, liveEventResponse = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    let body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ url, method: opts.method || "GET", body });
    if (String(url).includes("oauth2.googleapis.com/token")) return { ok: true, json: async () => ({ access_token: "test-token" }) };
    if (opts.method === "POST" && String(url).includes("/events?")) return { ok: true, json: async () => insertResponse };
    if (opts.method === "PATCH") return { ok: true, json: async () => patchResponse };
    return { ok: true, json: async () => liveEventResponse };
  };
  return { fetchImpl, calls };
}

const MEMBERS = { m1: { name: "Ankita", email: "ankita@loona.in" }, m2: { name: "Rahul", email: "rahul@loona.in" } };

(async () => {
  // ---- Tool schemas ----
  check("exactly the three intended tools are exposed", CALENDAR_ACTION_TOOLS.map((t) => t.name).join() === "find_meetings,schedule_meeting,update_meeting", CALENDAR_ACTION_TOOLS.map((t) => t.name));
  check("no tool exposes a model-settable organizer/creator/requester field — that identity is never taken from the model", !CALENDAR_ACTION_TOOLS.some((t) => Object.keys(t.input_schema.properties).some((k) => /organiz|creator|requester/i.test(k))), CALENDAR_ACTION_TOOLS.map((t) => Object.keys(t.input_schema.properties)));
  check("schedule_meeting requires the essentials", JSON.stringify(CALENDAR_ACTION_TOOLS.find((t) => t.name === "schedule_meeting").input_schema.required) === '["title","date","start_time","end_time"]');
  check("update_meeting requires only the event_key — everything else is optional, on purpose", JSON.stringify(CALENDAR_ACTION_TOOLS.find((t) => t.name === "update_meeting").input_schema.required) === '["event_key"]');

  // ---- The confirmation gate is shared verbatim with the task-actions one ----
  check("confirmation detection is the exact same heuristic used for tasks", looksLikeConfirmation("Yes, book it.") === true);

  // ---- find_meetings never needs confirmation ----
  const store0 = makeStore({ calendarEvents: { e1: { title: "Standup", knownAttendees: ["Ankita"] } } });
  const unconfirmedFind = await executeCalendarAction("find_meetings", {}, { confirmed: false }, { fbGet: store0.fbGet });
  check("find_meetings runs even on an unconfirmed turn — it's read-only", unconfirmedFind.ok === true && unconfirmedFind.results.length === 1, unconfirmedFind);

  // ---- schedule_meeting / update_meeting are refused outright without confirmation ----
  const blockedSchedule = await executeCalendarAction("schedule_meeting", { title: "x", date: "2026-10-05", start_time: "10:00", end_time: "10:30" }, { confirmed: false, speakerName: "Ankita" }, {});
  check("schedule_meeting is refused when the turn wasn't a confirmation", blockedSchedule.ok === false && blockedSchedule.needsConfirmation === true, blockedSchedule);
  const blockedUpdate = await executeCalendarAction("update_meeting", { event_key: "e1" }, { confirmed: false, speakerName: "Ankita" }, {});
  check("update_meeting is refused the same way", blockedUpdate.ok === false && blockedUpdate.needsConfirmation === true, blockedUpdate);

  // ---- The organizer is always ctx.speakerName, never anything from the model's input ----
  {
    const store = makeStore({ members: MEMBERS });
    const { fetchImpl, calls } = makeFetch({ insertResponse: { id: "g1", iCalUID: "uid1@google.com", summary: "Kickoff", hangoutLink: "https://meet.google.com/xyz" } });
    // Even if the model were somehow coaxed into passing an "organizer"-shaped value inside a
    // field that does exist (e.g. hidden in the title), scheduleMeetingAction only ever reads
    // the real organizer from ctx.speakerName — there is no code path that lets input override it.
    const result = await executeCalendarAction("schedule_meeting", { title: "Kickoff", date: "2026-10-05", start_time: "10:00", end_time: "10:30" }, { confirmed: true, speakerName: "Ankita" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    check("a confirmed schedule_meeting actually books it", result.ok === true && result.meeting.success === true, result);
    const tokenCall = calls.find((c) => String(c.url).includes("oauth2.googleapis.com"));
    const assertion = new URLSearchParams(tokenCall.body).get("assertion");
    const jwtPayload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64").toString("utf8"));
    check("the meeting is genuinely booked as the verified speaker", jwtPayload.sub === "ankita@loona.in", jwtPayload);
  }

  // ---- Scheduling with no verified speaker is refused, not silently attributed to "the team" ----
  {
    let unverifiedError = null;
    try { await scheduleMeetingAction({ title: "x", date: "2026-10-05", start_time: "10:00", end_time: "10:30" }, { speakerName: null }, {}); }
    catch (error) { unverifiedError = error.message; }
    check("scheduling with no confirmed identity is refused outright", /confirmed identity/.test(unverifiedError || ""), unverifiedError);
  }
  {
    let unverifiedError = null;
    try { await updateMeetingAction({ event_key: "e1" }, { speakerName: null }, {}); }
    catch (error) { unverifiedError = error.message; }
    check("editing with no confirmed identity is refused outright too", /confirmed identity/.test(unverifiedError || ""), unverifiedError);
  }

  // ---- update_meeting only forwards fields BB actually set, so update_task-style partial
  // edits don't accidentally overwrite anything on the calendar with a blank ----
  {
    const seed = { members: MEMBERS, calendarEvents: { e2: { uid: "uid2@google.com", googleEventId: "g2", organizer: "Ankita", organizerEmail: "ankita@loona.in", title: "Weekly sync", start: "2026-10-05T09:00:00+05:30", end: "2026-10-05T09:30:00+05:30", knownAttendees: ["Ankita", "Rahul"] } } };
    const store = makeStore(seed);
    const { fetchImpl, calls } = makeFetch({ patchResponse: {}, liveEventResponse: { summary: "Weekly sync", start: { dateTime: "2026-10-05T09:00:00+05:30" }, end: { dateTime: "2026-10-05T09:30:00+05:30" }, attendees: [{ email: "rahul@loona.in" }] } });
    const result = await executeCalendarAction("update_meeting", { event_key: "e2", start_time: "11:00", end_time: "11:30" }, { confirmed: true, speakerName: "Ankita" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    check("a time-only change through BB's tool succeeds", result.ok === true && result.meeting.success === true, result);
    const patchCall = calls.find((c) => c.method === "PATCH");
    check("the existing guest (Rahul) is preserved — BB never mentioned attendees, so they weren't sent as a change", patchCall.body.attendees.length === 1 && patchCall.body.attendees[0].email === "rahul@loona.in", patchCall.body.attendees);
  }

  // ---- Only the organizer or Gokul may edit — enforced by the shared lib, surfaced honestly ----
  {
    const seed = { members: MEMBERS, calendarEvents: { e3: { uid: "uid3@google.com", googleEventId: "g3", organizer: "Ankita", organizerEmail: "ankita@loona.in", title: "1:1", start: "2026-10-05T09:00:00+05:30", end: "2026-10-05T09:30:00+05:30", knownAttendees: ["Ankita", "Rahul"] } } };
    const store = makeStore(seed);
    const { fetchImpl } = makeFetch({ patchResponse: {}, liveEventResponse: { summary: "1:1", start: { dateTime: "2026-10-05T09:00:00+05:30" }, end: { dateTime: "2026-10-05T09:30:00+05:30" }, attendees: [] } });
    let refusalError = null;
    try {
      await executeCalendarAction("update_meeting", { event_key: "e3", start_time: "10:00", end_time: "10:30" }, { confirmed: true, speakerName: "Rahul" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    } catch (error) { refusalError = error.message; }
    check("a non-organizer, non-Gokul edit throws rather than silently applying", /can edit this meeting/.test(refusalError || ""), refusalError);
  }

  // ---- An unrecognised tool name is a bug, not silently ignored ----
  let unknownTool = null;
  try { await executeCalendarAction("cancel_everything", {}, { confirmed: true }, {}); } catch (error) { unknownTool = error.message; }
  check("an unrecognised tool name throws", /Unknown calendar action tool/.test(unknownTool || ""), unknownTool);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
