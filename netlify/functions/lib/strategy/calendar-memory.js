// Meetings the team actually has scheduled — for BB to answer "what's on today", "who's in
// that call", or "when's the next meeting with X".
//
// Reads /calendarEvents/{safeUid} = { title, start, end, attendeeCount, knownAttendees: [names],
// organizer, organizerEmail, callLink, htmlLink }, synced from each member's real Google
// Calendar by calendar-sync.js. Only ever contains meetings with 2+ attendees — a solo block on
// someone's calendar never makes it into this collection in the first place.
"use strict";
const { fbGet } = require("./firebase");

const LOOKBACK_DAYS = 1;
const LOOKAHEAD_DAYS = 14;
const MAX_LINES = 30;

function formatWhen(iso) {
  if (!iso) return "time unknown";
  // All-day events come through as a bare date ("2026-09-20"); real meetings carry a full
  // timestamp — only the latter should get a clock time attached.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function meetingLine(event) {
  const title = String(event.title || "(untitled meeting)").trim();
  const attendees = Array.isArray(event.knownAttendees) ? event.knownAttendees.filter(Boolean) : [];
  const who = attendees.length ? ` — ${attendees.join(", ")}` : "";
  return `- ${formatWhen(event.start)}: ${title}${who}`;
}

async function loadCalendarText(deps = {}) {
  const get = deps.fbGet || fbGet;
  const raw = (await get("calendarEvents")) || {};
  const now = deps.now || new Date();
  const from = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString();
  const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000).toISOString();

  const events = Object.values(raw)
    .filter((event) => event && event.attendeeCount >= 2 && event.start)
    .filter((event) => {
      const start = /^\d{4}-\d{2}-\d{2}$/.test(event.start) ? `${event.start}T00:00:00` : event.start;
      return start >= from && start <= to;
    })
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

  const lines = events.slice(0, MAX_LINES).map(meetingLine);
  if (!lines.length) return null;
  return [
    "# Upcoming and recent team meetings",
    "Real meetings from the team's Google Calendars, synced by Hub — only meetings with 2 or more attendees are ever tracked here.",
    ...lines,
  ].join("\n");
}

module.exports = { loadCalendarText };
