// The Loona holiday calendar, so BB can answer "is Friday a holiday" or factor a holiday into
// a deadline the way the team already does.
//
// Two sources, same as index.html's own holiday manager: OFFICIAL_HOLIDAYS is a fixed calendar
// mirrored here (index.html has no server-side counterpart to read, so this list must be kept
// in sync with it by hand when the founder updates it there), and /loona_holidays/{id} =
// { date, name } is the founder-added extra list, read live from Firebase.
"use strict";
const { fbGet } = require("./firebase");

// Keep in sync with OFFICIAL_HOLIDAYS in index.html.
const OFFICIAL_HOLIDAYS = [
  { date: "2026-03-19", name: "Gudi Padwa" },
  { date: "2026-03-21", name: "Ramzan Eid*" },
  { date: "2026-04-03", name: "Good Friday" },
  { date: "2026-05-01", name: "Maharashtra Day" },
  { date: "2026-08-15", name: "Independence Day" },
  { date: "2026-08-28", name: "Raksha Bandhan" },
  { date: "2026-09-14", name: "Ganesh Chaturthi" },
  { date: "2026-10-20", name: "Dussehra" },
  { date: "2026-11-08", name: "Diwali (Laxmi Pujan)" },
  { date: "2026-11-09", name: "Diwali Day 2" },
  { date: "2026-12-25", name: "Christmas Day" },
  { date: "2027-01-01", name: "New Year's Day" },
  { date: "2027-01-26", name: "Republic Day" },
  { date: "2027-03-24", name: "Holi (2nd Day Rangpanchami)" },
  { date: "2027-04-08", name: "Gudhi Padwa" },
  { date: "2027-04-09", name: "Ramzan Eid*" },
];

const LOOKAHEAD_DAYS = 60;

async function loadHolidayText(deps = {}) {
  const get = deps.fbGet || fbGet;
  const extra = (await get("loona_holidays")) || {};
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const to = new Date(new Date(today).getTime() + LOOKAHEAD_DAYS * 86400000).toISOString().slice(0, 10);

  const all = [...OFFICIAL_HOLIDAYS, ...Object.values(extra)]
    .filter((holiday) => holiday && holiday.date && holiday.date >= today && holiday.date <= to)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (!all.length) return null;
  const lines = all.map((holiday) => `- ${holiday.date}: ${holiday.name || "Holiday"}`);
  return ["# Upcoming Loona holidays", ...lines].join("\n");
}

module.exports = { loadHolidayText, OFFICIAL_HOLIDAYS };
