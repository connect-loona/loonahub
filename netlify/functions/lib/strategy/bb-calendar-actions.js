// Lets BB schedule and reschedule real Google Calendar meetings from conversation, on Hub and
// on WhatsApp — same two callers as bb-task-actions.js, same reasoning: resolveSpeaker()/Hub's
// own login both verify against the same team roster before a confirmation is trusted.
//
// This is higher-stakes than a task-board write: scheduling sends a real Calendar invite to
// real inboxes (possibly including people outside Loona), under whoever is impersonated as the
// organizer via domain-wide delegation. For that reason the organizer is NEVER a model-supplied
// field — it is always ctx.speakerName, the actual verified person BB is talking to right now.
// A model that hallucinated or was talked into a different "creatorName" could otherwise send a
// real invite as someone else entirely; this file never gives it the chance to try.
"use strict";
const { createMeeting, updateMeeting, findMeetings } = require("../calendar-actions");
const { looksLikeConfirmation } = require("./bb-task-actions");

const EVENT_KINDS = ["meeting", "physical_meeting", "shoot"];
const MAX_FIND_RESULTS = 20;

const CALENDAR_ACTION_TOOLS = [
  {
    name: "find_meetings",
    description: "Search Loona Hub's calendar. Read-only — use it to look up a meeting's event_key before rescheduling it, or to check what's already on the calendar before booking something that might clash.",
    input_schema: {
      type: "object",
      properties: {
        member: { type: "string", description: "Filter to meetings this person is attending (or organizing), by first name." },
        brand: { type: "string", description: "Filter to meetings tagged with this brand." },
        date: { type: "string", description: "YYYY-MM-DD — filter to meetings on this exact date." },
        query: { type: "string", description: "Filter to meetings whose title contains this text." },
      },
    },
  },
  {
    name: "schedule_meeting",
    description: "Put a new meeting on Loona Hub's calendar. This sends a REAL Google Calendar invite to everyone on it, and for a plain video meeting (the default) generates a Meet link automatically. You are always booked as the organizer yourself — never ask who to book it as, it is always whoever is talking to you right now. Only call this after you have already told the team exactly what you are about to book — title, date, time, who's on it — and they have explicitly confirmed it in their NEXT message, never on the message that first proposes it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The meeting title." },
        date: { type: "string", description: "YYYY-MM-DD." },
        start_time: { type: "string", description: "HH:MM, 24-hour, IST." },
        end_time: { type: "string", description: "HH:MM, 24-hour, IST." },
        attendees: { type: "array", items: { type: "string" }, description: "Hub teammates to invite, by first name, exactly as they appear in Hub's team directory." },
        guest_emails: { type: "array", items: { type: "string" }, description: "Raw email addresses for anyone outside Loona to invite." },
        brand: { type: "string", description: "The brand this meeting is for, if any." },
        description: { type: "string" },
        location: { type: "string", description: "Required for a physical_meeting or a shoot — where it's actually happening." },
        event_kind: { type: "string", enum: EVENT_KINDS, description: "Defaults to \"meeting\" (a video call — gets an automatic Meet link). Use physical_meeting or shoot for something in person — neither gets a Meet link, so set location instead." },
      },
      required: ["title", "date", "start_time", "end_time"],
    },
  },
  {
    name: "update_meeting",
    description: "Reschedule or edit a meeting already on the calendar — sends a real Calendar update to everyone on it. Only the meeting's own organizer or Gokul may do this; anyone else's attempt is refused, and you should say so plainly rather than pretending it worked. Only set the fields that are actually changing — anything left out keeps whatever is already on the calendar (the time, the attendee list, all of it), it is never blanked out by omission. Only call this after you have already told the team exactly what you are about to change and they have explicitly confirmed it in their NEXT message. Look the meeting up with find_meetings first if you don't already have its event_key.",
    input_schema: {
      type: "object",
      properties: {
        event_key: { type: "string", description: "The meeting's id, from find_meetings." },
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD." },
        start_time: { type: "string", description: "HH:MM, 24-hour, IST." },
        end_time: { type: "string", description: "HH:MM, 24-hour, IST." },
        attendees: { type: "array", items: { type: "string" }, description: "The FULL attendee list this should end up with, by first name — only pass this when the attendee list itself is what's changing." },
        guest_emails: { type: "array", items: { type: "string" } },
        brand: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        event_kind: { type: "string", enum: EVENT_KINDS },
      },
      required: ["event_key"],
    },
  },
];

async function findMeetingsAction(input, deps) {
  const results = await findMeetings(input, deps);
  return results.slice(0, MAX_FIND_RESULTS);
}

async function scheduleMeetingAction(input, ctx, deps) {
  const organizer = ctx.speakerName;
  if (!organizer) throw new Error("I don't have a confirmed identity for whoever I'm talking to, so I can't book this as a real organizer — ask them to try again once Hub/WhatsApp can verify who they are.");
  const result = await createMeeting({
    creatorName: organizer,
    title: input.title,
    date: input.date,
    startTime: input.start_time,
    endTime: input.end_time,
    attendees: input.attendees,
    guestEmails: input.guest_emails,
    brand: input.brand,
    description: input.description,
    location: input.location,
    eventKind: input.event_kind,
  }, deps);
  return result;
}

async function updateMeetingAction(input, ctx, deps) {
  const requester = ctx.speakerName;
  if (!requester) throw new Error("I don't have a confirmed identity for whoever I'm talking to, so I can't authorize this edit — ask them to try again once Hub/WhatsApp can verify who they are.");
  const params = { eventKey: input.event_key, requesterName: requester };
  if (input.title !== undefined) params.title = input.title;
  if (input.date !== undefined) params.date = input.date;
  if (input.start_time !== undefined) params.startTime = input.start_time;
  if (input.end_time !== undefined) params.endTime = input.end_time;
  if (input.attendees !== undefined) params.attendees = input.attendees;
  if (input.guest_emails !== undefined) params.guestEmails = input.guest_emails;
  if (input.brand !== undefined) params.brand = input.brand;
  if (input.description !== undefined) params.description = input.description;
  if (input.location !== undefined) params.location = input.location;
  if (input.event_kind !== undefined) params.eventKind = input.event_kind;
  return updateMeeting(params, deps);
}

// The one gate every write goes through, exactly the same shape as bb-task-actions.js's own
// executeTaskAction — find_meetings is read-only and always allowed; scheduling or editing a
// meeting requires the current turn's own message to actually read as a confirmation.
async function executeCalendarAction(name, input, ctx = {}, deps = {}) {
  if (name === "find_meetings") return { ok: true, results: await findMeetingsAction(input, deps) };
  if (name === "schedule_meeting" || name === "update_meeting") {
    if (!ctx.confirmed) {
      return {
        ok: false,
        needsConfirmation: true,
        message: "Not done — the team has not yet confirmed this in their own message. Tell them exactly what you are about to book or change and wait for them to say yes before calling this again.",
      };
    }
    const result = name === "schedule_meeting" ? await scheduleMeetingAction(input, ctx, deps) : await updateMeetingAction(input, ctx, deps);
    return { ok: true, meeting: result };
  }
  throw new Error(`Unknown calendar action tool "${name}".`);
}

module.exports = { CALENDAR_ACTION_TOOLS, executeCalendarAction, findMeetingsAction, scheduleMeetingAction, updateMeetingAction, looksLikeConfirmation };
