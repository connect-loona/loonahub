// Real Google Calendar meetings synced into /calendarEvents — only ever meetings with 2+
// attendees, since calendar-sync.js drops anything solo before it's ever written.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { loadCalendarText } = require(path.join(HUB, "netlify/functions/lib/strategy/calendar-memory"));

const NOW = new Date("2026-09-18T12:00:00.000Z");

(async () => {
  await req("PUT", `${RTDB_URL}/calendarEvents.json`, null);

  const empty = await loadCalendarText({ now: NOW });
  check("no meetings yields null rather than an empty heading", empty === null, empty);

  await req("PUT", `${RTDB_URL}/calendarEvents.json`, {
    e1: { title: "Casa Waters monthly review", start: "2026-09-19T10:00:00+05:30", end: "2026-09-19T11:00:00+05:30", attendeeCount: 3, knownAttendees: ["Anjali", "Priya", "Gokul"], organizer: "Gokul" },
    e2: { title: "RRO Foods shoot planning", start: "2026-09-25T15:00:00+05:30", end: "2026-09-25T15:30:00+05:30", attendeeCount: 2, knownAttendees: ["Vishnu", "Rahul"], organizer: "Vishnu" },
    e3: { title: "Too far out", start: "2026-11-01T10:00:00+05:30", end: "2026-11-01T11:00:00+05:30", attendeeCount: 2, knownAttendees: ["Anjali"], organizer: "Anjali" },
    e4: { title: "Solo focus block", start: "2026-09-19T09:00:00+05:30", end: "2026-09-19T09:30:00+05:30", attendeeCount: 1, knownAttendees: [], organizer: "Meera" },
  });

  const text = await loadCalendarText({ now: NOW });
  check("an upcoming meeting is included with its attendees", /Casa Waters monthly review/.test(text) && /Anjali/.test(text) && /Gokul/.test(text), text);
  check("another meeting within the lookahead window is included", /RRO Foods shoot planning/.test(text), text);
  check("a meeting past the lookahead window is excluded", !/Too far out/.test(text), text);
  check("a solo block (1 attendee) is excluded", !/Solo focus block/.test(text), text);
  check("the earlier meeting comes first", text.indexOf("Casa Waters") < text.indexOf("RRO Foods"), text);
  check("it's labelled as real synced meetings, not a brief", /synced/i.test(text), text.slice(0, 200));

  await req("PUT", `${RTDB_URL}/calendarEvents.json`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
