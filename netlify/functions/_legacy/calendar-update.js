// ============================================================================
// LOONA Hub · Reschedule/edit an existing Google Calendar meeting (Netlify Function)
// ----------------------------------------------------------------------------
// Thin HTTP wrapper — the actual logic lives in lib/calendar-actions.js's updateMeeting(),
// shared with BB's own update_meeting tool (see lib/strategy/bb-calendar-actions.js).
//
// POST body: { eventKey (calendarEvents' Firebase key), requesterName, title,
//   date (YYYY-MM-DD), startTime (HH:MM), endTime (HH:MM),
//   attendees: [member names], guestEmails: [raw emails], brand, description, location }
//
// Requires the same https://www.googleapis.com/auth/calendar.events scope
// calendar-create.js needs (see that file's header comment).
// ============================================================================
const { updateMeeting } = require("../lib/calendar-actions");

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
    const result = await updateMeeting(body);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, tasksUpdated: result.tasksUpdated }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
