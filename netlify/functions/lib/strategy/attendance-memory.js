// Today's check-in/check-out times, for BB to answer "who's in", "when did X arrive" — never
// who's owed a fine, whose leave balance is low, or anything else from the payroll side of
// this integration.
//
// Reads /loona_attendance/{date}/{emp_id} = { n, i, o, w, b } (name, first-in minute-of-day,
// last-out minute-of-day, worked minutes, break minutes) — the same compact daily summary
// petpooja-sync.js writes, kept fresh roughly hourly by attendance-sheet-sync.js re-running it
// for the last two days before its own read. This file goes nowhere near the Late/fine/leave
// classification in attendance-sheet-sync.js (LATE_FEE, LATE_FREE_DAYS, monthly fines) — that
// machinery exists to calculate money owed, which is exactly the payroll/financial territory
// BB must never touch. A plain arrival time is enough for the team to judge for themselves
// whether someone was late; BB doesn't need to make that call, and definitely shouldn't be the
// one naming a fine.
"use strict";
const { fbGet } = require("./firebase");

function formatTimeOfDay(minuteOfDay) {
  if (minuteOfDay === null || minuteOfDay === undefined) return null;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const period = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatDuration(totalMinutes) {
  if (!totalMinutes) return null;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function attendanceLine(record) {
  const name = String(record.n || "").trim();
  if (!name) return null;
  const checkIn = formatTimeOfDay(record.i);
  if (!checkIn) return `- ${name}: no check-in recorded today.`;
  const bits = [`checked in at ${checkIn}`];
  const checkOut = formatTimeOfDay(record.o);
  if (checkOut) bits.push(`checked out at ${checkOut}`);
  const worked = formatDuration(record.w);
  if (worked) bits.push(`worked ${worked}`);
  return `- ${name}: ${bits.join(", ")}.`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Deliberately today only, not a multi-day history — this is for "who's in right now"
// questions, not attendance analytics, and keeps this out of every conversation's context at
// a size that scales with the whole team rather than the whole month.
async function loadAttendanceText() {
  const date = todayISO();
  const raw = (await fbGet(`loona_attendance/${date}`)) || {};
  const lines = Object.values(raw).map(attendanceLine).filter(Boolean);
  if (!lines.length) return null;
  return [
    `# Today's attendance (${date})`,
    "Check-in/check-out times only, from Petpooja. Never mention or infer a fine, leave balance, salary or any other payroll figure — that data exists elsewhere and is not something you have access to.",
    ...lines,
  ].join("\n");
}

module.exports = { loadAttendanceText };
