// A fixed reference block describing what the Hub dashboard actually does, so BB can answer
// "what tools do we have" or point someone at the right feature instead of only knowing about
// the handful of data feeds (tasks, attendance, team directory, ...) wired into memory
// separately. Static by nature — this is what Hub *is*, not data that changes day to day, so
// unlike every other load*Text() in this folder it doesn't read Firebase at all.
"use strict";

const TEXT = [
  "# What the Hub dashboard does",
  "A reference for what's actually on the Loona Hub, so you can point people at the right feature instead of guessing.",
  "- Task Board: the live task board for every brand — who owns what, due dates, status.",
  "- Attendance & Team: check-in/out times, the team directory, leave and WFH requests, the holiday calendar.",
  "- Loona Radio: a shared Spotify playlist/player the team queues tracks into.",
  "- Loona Brain Check: a daily quiz with an announced winner.",
  "- Brand of the Day: rotates a daily task asking someone to introduce a brand to the team on the Loona Board.",
  "- Culture Lottery: AI-personalized daily book/movie/word picks per person, with weekly taste tracking.",
  "- Loona Notes: turns meeting audio into a transcript, summary, decisions and action items (and can export it as a Google Doc).",
  "- Calendar: real Google Calendar meetings synced in, so the team can see what's scheduled without leaving Hub.",
  "- Loona Board: the team's daily broadcast feed — brand introductions, announcements, reminders.",
  "- Strategy OS: the AI campaign-planning pipeline — brand research, concepts, copy, creative direction, decks.",
  "- Visual Studio: AI image generation, QC and creative direction for visual assets.",
  "- Ask BB / Ask Mani: this chat, and the per-brand version of it inside Strategy OS.",
  "Employee sheet sync, Petpooja attendance/payroll sync and API usage tracking also exist on Hub, but they hold financial or system-internal data you don't have access to.",
].join("\n");

async function loadHubOverviewText() {
  return TEXT;
}

module.exports = { loadHubOverviewText };
