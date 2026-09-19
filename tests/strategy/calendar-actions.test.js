// Scheduling and rescheduling a real Google Calendar meeting — the shared core BB's own
// schedule_meeting/update_meeting tools call (lib/strategy/bb-calendar-actions.js), and the
// exact same logic the Hub "New Meeting" form's calendar-create.js/calendar-update.js now
// delegate to as thin wrappers.
//
// Never touches a real Google credential, a real Firebase project, or the real network — every
// dependency (fbGet/fbPatch/fetchImpl/serviceAccount) is injected, matching the DI convention
// every other lib/strategy/*.js test uses.
"use strict";
const crypto = require("crypto");
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { createMeeting, updateMeeting, findMeetings } = require(path.join(HUB, "netlify/functions/lib/calendar-actions"));

// A structurally valid RSA key is all crypto.createSign(...).sign() needs — nothing in this
// test suite ever verifies the signature, since the fake token endpoint below never checks it
// either (it's standing in for Google's own token endpoint, which these tests never reach).
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 512, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SERVICE_ACCOUNT = { client_email: "sa@loona-hub.iam.gserviceaccount.com", private_key: privateKey };

// A tiny in-memory Firebase stand-in — fbGet/fbPatch resolve dotted paths against one plain
// object, close enough to the real REST shape (GET a path, PATCH merges shallowly at a path)
// for what this logic actually does with it.
function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  function at(path) {
    return path.split("/").filter(Boolean).reduce((node, key) => (node == null ? node : node[key]), data);
  }
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

// Stands in for both Google's OAuth token endpoint and its Calendar API — everything this
// module actually calls over the network. `insertResponse`/`patchResponse`/`liveEventResponse`
// let each test control exactly what "Google" hands back; `calls` records every request made so
// a test can assert on method/URL/body without a real HTTP layer underneath.
function makeFetch({ insertResponse = {}, patchResponse = {}, liveEventResponse = {}, tokenOk = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    let parsedBody = null;
    if (opts.body) { try { parsedBody = JSON.parse(opts.body); } catch { parsedBody = opts.body; } }
    calls.push({ url, method: opts.method || "GET", body: parsedBody });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return { ok: tokenOk, json: async () => (tokenOk ? { access_token: "test-token" } : { error: "unauthorized_client" }) };
    }
    if (opts.method === "POST" && String(url).includes("/events?")) {
      return { ok: true, json: async () => insertResponse };
    }
    if (opts.method === "PATCH") {
      return { ok: true, json: async () => patchResponse };
    }
    // The one plain GET this module makes: fetching the live event before an update.
    return { ok: true, json: async () => liveEventResponse };
  };
  return { fetchImpl, calls };
}

const MEMBERS = {
  m1: { name: "Ankita", email: "ankita@loona.in" },
  m2: { name: "Rahul", email: "rahul@loona.in" },
  m3: { name: "Priya" }, // no explicit email — must derive firstname@loona.in
};

(async () => {
  // ---- createMeeting: the happy path ----
  {
    const store = makeStore({ members: MEMBERS });
    const { fetchImpl, calls } = makeFetch({
      insertResponse: {
        id: "g_evt_1", iCalUID: "uid-1@google.com", summary: "Diwali shoot planning", htmlLink: "https://calendar.google.com/x",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] },
      },
    });
    const result = await createMeeting({
      creatorName: "Ankita", title: "Diwali shoot planning", date: "2026-10-05", startTime: "15:00", endTime: "15:30",
      attendees: ["Rahul", "Priya", "Nobody Real"], guestEmails: ["client@brand.com", "not-an-email"],
    }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });

    check("a meeting is created successfully", result.success === true, result);
    check("the Meet link comes back from the API response", result.callLink === "https://meet.google.com/abc-defg-hij", result);
    check("an unresolved attendee name is reported rather than silently dropped", result.unresolvedAttendees.includes("Nobody Real"), result.unresolvedAttendees);
    check("a malformed guest email is filtered out", !JSON.stringify(calls).includes("not-an-email"));

    const tokenCall = calls.find((c) => String(c.url).includes("oauth2.googleapis.com"));
    const assertion = new URLSearchParams(tokenCall.body).get("assertion");
    const jwtPayload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64").toString("utf8"));
    check("the organizer is who Google is actually asked to impersonate (JWT sub claim)", jwtPayload.sub === "ankita@loona.in", jwtPayload);
    const insertCall = calls.find((c) => c.method === "POST" && String(c.url).includes("/events?"));
    check("a Meet link is requested for a plain meeting", Boolean(insertCall.body.conferenceData), insertCall.body);
    check("Priya's derived email is invited even with no email on file", insertCall.body.attendees.some((a) => a.email === "priya@loona.in"), insertCall.body.attendees);
    check("Rahul's own email on file is used instead of a derived one", insertCall.body.attendees.some((a) => a.email === "rahul@loona.in"), insertCall.body.attendees);
    check("the valid external guest is invited", insertCall.body.attendees.some((a) => a.email === "client@brand.com"), insertCall.body.attendees);

    check("the meeting is written into calendarEvents", Boolean(store.data.calendarEvents && store.data.calendarEvents["uid-1@google_com"]), store.data.calendarEvents);
    check("a task is auto-created for every known attendee, including the organizer", Object.values(store.data.tasks || {}).filter((t) => t.auto_calendar_event_id === "uid-1@google.com").length === 3, store.data.tasks);
    check("the auto-task carries the Meet link so attendees can join from the task board", Object.values(store.data.tasks || {}).some((t) => t.meeting_link === "https://meet.google.com/abc-defg-hij"), store.data.tasks);
    check("a Loona Board announcement is posted, scoped to only the real participants", Object.values(store.data.announcements || {}).some((a) => a.calendar_event_id === "uid-1@google.com" && a.visibleTo.length === 3), store.data.announcements);
  }

  // ---- createMeeting: a physical meeting/shoot never gets a Meet link ----
  {
    const store = makeStore({ members: MEMBERS });
    const { fetchImpl, calls } = makeFetch({ insertResponse: { id: "g_evt_2", iCalUID: "uid-2@google.com", summary: "Studio shoot", htmlLink: "https://calendar.google.com/y" } });
    const result = await createMeeting({
      creatorName: "Ankita", title: "Studio shoot", date: "2026-10-06", startTime: "10:00", endTime: "13:00",
      eventKind: "shoot", location: "Loona Studio, Bandra",
    }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    check("a shoot is created without a Meet link", result.callLink === "", result);
    const insertCall = calls.find((c) => c.method === "POST" && String(c.url).includes("/events?"));
    check("no conferenceData is requested for a shoot", insertCall.body.conferenceData === undefined, insertCall.body);
    check("the location is set on the event instead", insertCall.body.location === "Loona Studio, Bandra", insertCall.body);
  }

  // ---- createMeeting: validation ----
  {
    const store = makeStore({ members: MEMBERS });
    const { fetchImpl } = makeFetch({});
    let missing = null;
    try { await createMeeting({ creatorName: "Ankita", title: "x" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT }); }
    catch (error) { missing = error.message; }
    check("missing date/time fields are refused", /Missing required fields/.test(missing || ""), missing);

    let unknownCreator = null;
    try {
      await createMeeting({ creatorName: "Someone Not On The Team", title: "x", date: "2026-10-05", startTime: "10:00", endTime: "10:30" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    } catch (error) { unknownCreator = error.message; }
    check("an organizer not on the roster is refused, rather than silently sending as nobody", /not found in the team roster/.test(unknownCreator || ""), unknownCreator);
  }

  // ---- updateMeeting: authorization ----
  {
    const seed = {
      members: MEMBERS,
      calendarEvents: {
        evt1: { uid: "uid-1@google.com", googleEventId: "g_evt_1", organizer: "Ankita", organizerEmail: "ankita@loona.in", title: "Diwali shoot planning", start: "2026-10-05T15:00:00+05:30", end: "2026-10-05T15:30:00+05:30", eventKind: "meeting", knownAttendees: ["Ankita", "Rahul"], guestEmails: [], brand: "RRO Foods", callLink: "https://meet.google.com/abc-defg-hij", htmlLink: "https://calendar.google.com/x" },
      },
    };
    const store = makeStore(seed);
    const { fetchImpl } = makeFetch({ patchResponse: {}, liveEventResponse: { summary: "Diwali shoot planning", start: { dateTime: "2026-10-05T15:00:00+05:30" }, end: { dateTime: "2026-10-05T15:30:00+05:30" }, attendees: [{ email: "rahul@loona.in" }] } });

    let refused = null;
    try {
      await updateMeeting({ eventKey: "evt1", requesterName: "Priya", startTime: "16:00" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    } catch (error) { refused = error.message; }
    check("someone who is neither the organizer nor Gokul is refused", /can edit this meeting/.test(refused || ""), refused);

    const byOrganizer = await updateMeeting({ eventKey: "evt1", requesterName: "Ankita", startTime: "16:00", endTime: "16:30" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    check("the organizer themself can edit it", byOrganizer.success === true, byOrganizer);

    const byGokul = await updateMeeting({ eventKey: "evt1", requesterName: "Gokul", startTime: "17:00", endTime: "17:30" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    check("Gokul can edit anyone's meeting", byGokul.success === true, byGokul);
  }

  // ---- updateMeeting: omitted fields never blank out what's already on the calendar ----
  {
    const seed = {
      members: MEMBERS,
      calendarEvents: {
        evt2: { uid: "uid-2@google.com", googleEventId: "g_evt_2", organizer: "Ankita", organizerEmail: "ankita@loona.in", title: "Weekly sync", start: "2026-10-05T09:00:00+05:30", end: "2026-10-05T09:30:00+05:30", eventKind: "meeting", knownAttendees: ["Ankita", "Rahul", "Priya"], guestEmails: ["client@brand.com"], brand: "Casa Waters", location: "" },
      },
    };
    const store = makeStore(seed);
    const { fetchImpl, calls } = makeFetch({
      patchResponse: {},
      liveEventResponse: {
        summary: "Weekly sync", description: "Standing weekly check-in — do not lose this.",
        start: { dateTime: "2026-10-05T09:00:00+05:30" }, end: { dateTime: "2026-10-05T09:30:00+05:30" },
        attendees: [{ email: "rahul@loona.in" }, { email: "priya@loona.in" }, { email: "client@brand.com" }],
      },
    });

    // Only the time is changing — this is the exact shape a BB tool call like "push it to
    // 10am" would make: event_key + start_time/end_time, nothing else.
    const result = await updateMeeting({ eventKey: "evt2", requesterName: "Ankita", startTime: "10:00", endTime: "10:30" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    check("a time-only edit still succeeds", result.success === true, result);

    const patchCall = calls.find((c) => c.method === "PATCH");
    check("the title is preserved from the live event, not blanked", patchCall.body.summary === "Weekly sync", patchCall.body);
    check("the description is preserved from the live event — Hub's own Firebase mirror never even stores it", patchCall.body.description === "Standing weekly check-in — do not lose this.", patchCall.body);
    check("nobody already on the invite is silently dropped", patchCall.body.attendees.length === 3, patchCall.body.attendees);
    check("the client guest is still on the invite too", patchCall.body.attendees.some((a) => a.email === "client@brand.com"), patchCall.body.attendees);
    check("the new time is the one thing that actually changed", patchCall.body.start.dateTime === "2026-10-05T10:00:00", patchCall.body.start);
  }

  // ---- updateMeeting: an explicit empty attendee list IS honored (a real, intentional ask) ----
  {
    const seed = {
      members: MEMBERS,
      calendarEvents: {
        evt3: { uid: "uid-3@google.com", googleEventId: "g_evt_3", organizer: "Ankita", organizerEmail: "ankita@loona.in", title: "1:1", start: "2026-10-05T11:00:00+05:30", end: "2026-10-05T11:30:00+05:30", eventKind: "meeting", knownAttendees: ["Ankita", "Rahul"], guestEmails: [] },
      },
    };
    const store = makeStore(seed);
    const { fetchImpl, calls } = makeFetch({
      patchResponse: {},
      liveEventResponse: { summary: "1:1", start: { dateTime: "2026-10-05T11:00:00+05:30" }, end: { dateTime: "2026-10-05T11:30:00+05:30" }, attendees: [{ email: "rahul@loona.in" }] },
    });
    await updateMeeting({ eventKey: "evt3", requesterName: "Ankita", attendees: [] }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT });
    const patchCall = calls.find((c) => c.method === "PATCH");
    check("explicitly passing an empty attendee list really does clear it", patchCall.body.attendees.length === 0, patchCall.body.attendees);
  }

  // ---- updateMeeting: validation ----
  {
    const store = makeStore({ members: MEMBERS });
    const { fetchImpl } = makeFetch({});
    let noEvent = null;
    try { await updateMeeting({ eventKey: "does-not-exist", requesterName: "Ankita" }, { fbGet: store.fbGet, fbPatch: store.fbPatch, fetchImpl, serviceAccount: SERVICE_ACCOUNT }); }
    catch (error) { noEvent = error.message; }
    check("editing a meeting that isn't in Hub's calendar fails clearly", /not in Loona Hub's calendar/.test(noEvent || ""), noEvent);
  }

  // ---- findMeetings ----
  {
    const store = makeStore({
      calendarEvents: {
        e1: { title: "Diwali shoot planning", start: "2026-10-05T15:00:00+05:30", knownAttendees: ["Ankita", "Rahul"], brand: "RRO Foods" },
        e2: { title: "Casa monthly review", start: "2026-10-06T11:00:00+05:30", knownAttendees: ["Priya"], brand: "Casa Waters" },
      },
    });
    const byMember = await findMeetings({ member: "rahul" }, { fbGet: store.fbGet });
    check("find_meetings filters by attendee, case-insensitively", byMember.length === 1 && byMember[0].title === "Diwali shoot planning", byMember);
    const byDate = await findMeetings({ date: "2026-10-06" }, { fbGet: store.fbGet });
    check("find_meetings filters by exact date", byDate.length === 1 && byDate[0].title === "Casa monthly review", byDate);
    const byQuery = await findMeetings({ query: "monthly" }, { fbGet: store.fbGet });
    check("find_meetings filters by a text query against the title", byQuery.length === 1, byQuery);
  }

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
