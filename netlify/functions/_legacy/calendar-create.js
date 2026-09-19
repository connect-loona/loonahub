// ============================================================================
// LOONA Hub · Create a Google Calendar meeting (Netlify Function)
// ----------------------------------------------------------------------------
// Thin HTTP wrapper — the actual logic (create the event, generate the Meet link, write
// calendarEvents/tasks/announcements) lives in lib/calendar-actions.js's createMeeting(),
// shared with BB's own schedule_meeting tool (see lib/strategy/bb-calendar-actions.js) so
// there is exactly one implementation of "how Loona Hub talks to Google Calendar" rather than
// two that can drift apart.
//
// POST body: { creatorName, title, date (YYYY-MM-DD), startTime (HH:MM), endTime (HH:MM),
//   attendees: [member names], guestEmails: [raw emails], brand, description, location,
//   eventKind }
//
// IMPORTANT: calendar-sync.js only ever requested calendar.readonly. Writing events needs the
// broader https://www.googleapis.com/auth/calendar.events scope authorized for this same
// service account's Client ID in Workspace Admin (Security > API Controls > Domain-wide
// Delegation), added alongside the existing readonly one, not replacing it.
// ============================================================================
const { createMeeting } = require("../lib/calendar-actions");

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ success: false, message: "Method not allowed" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const result = await createMeeting(body);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, eventId: result.eventId, htmlLink: result.htmlLink, callLink: result.callLink, warnings: result.warnings }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
