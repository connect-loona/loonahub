// Loona Board: the daily brand-introduction and general-announcement feed the team posts
// through the dashboard's Broadcast modal (fbAddAnnouncement -> /announcements). Global BB
// should be able to recall these — brand introductions in particular are referred back to.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { loadAnnouncementsText } = require(path.join(HUB, "netlify/functions/lib/strategy/announcements-memory"));

(async () => {
  await req("PUT", `${RTDB_URL}/announcements.json`, null);

  const emptyText = await loadAnnouncementsText();
  check("no announcements yields null rather than an empty heading", emptyText === null, emptyText);

  await req("PUT", `${RTDB_URL}/announcements.json`, {
    a1: { text: "Brand of the day: Casa Waters — premium packaged drinking water.", author: "Priya", links: ["https://casawaters.example.com"], timestamp: "2026-09-10T09:00:00Z", ts: 1757494800000 },
    a2: { text: "Reminder: submit timesheets by Friday.", author: "Anjali", timestamp: "2026-09-15T09:00:00Z", ts: 1757926800000 },
    a3: { text: "Brand of the day: RRO Foods — snack brand.", author: "Vishnu", link: "https://rrofoods.example.com", timestamp: "2026-09-17T09:00:00Z", ts: 1758099600000 },
    a4: { author: "Ghost", timestamp: "2026-09-01T09:00:00Z", ts: 1756717200000 },
  });

  const text = await loadAnnouncementsText();
  check("it includes a brand introduction and its link", /Casa Waters/.test(text) && /casawaters\.example\.com/.test(text), text);
  check("it also includes a plain announcement with no link", /submit timesheets by Friday/.test(text), text);
  check("a singular `link` field is picked up the same as `links`", /RRO Foods/.test(text) && /rrofoods\.example\.com/.test(text), text);
  check("the most recent announcement comes first", text.indexOf("RRO Foods") < text.indexOf("Casa Waters"), text);
  check("an entry with no text is skipped rather than producing a blank line", !/Ghost/.test(text), text);
  check("it's clearly labelled as the Loona Board feed", /Loona Board/.test(text), text.slice(0, 100));

  await req("PUT", `${RTDB_URL}/announcements.json`, null);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
