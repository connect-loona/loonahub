// Shared core of scheduling and rescheduling a real Google Calendar meeting — extracted out
// of _legacy/calendar-create.js and _legacy/calendar-update.js so BB (see
// lib/strategy/bb-calendar-actions.js) can call the exact same logic those two HTTP endpoints
// use, instead of a second, drifting copy of "how Loona Hub talks to Google Calendar." Both
// legacy handlers are now thin wrappers around createMeeting()/updateMeeting() below; nothing
// about their own request/response contract changed.
//
// Deliberately takes an injectable `deps` (fbGet/fbPatch/fetchImpl/serviceAccount) the same way
// every lib/strategy/*.js function does, so this can be unit-tested without a real Google
// credential, a real Firebase project, or a real network call.
"use strict";
const crypto = require("crypto");
const { authedUrl } = require("./firebase-auth");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// Only affects TEXT/labels (the auto-created task, the Loona Board post) — the one place
// eventKind changes actual API behavior is the conferenceData block in createMeeting().
const KIND_LABEL = { meeting: "Meeting", physical_meeting: "Physical Meeting", shoot: "Shoot" };
const KIND_EMOJI = { meeting: "📅", physical_meeting: "🤝", shoot: "🎬" };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signJWT(claims, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claims));
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return signingInput + "." + base64url(signature);
}

async function loadServiceAccount(deps) {
  if (deps.serviceAccount) return deps.serviceAccount;
  const raw = deps.serviceAccountRaw || process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_CALENDAR_SERVICE_ACCOUNT not set");
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error("GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON"); }
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key");
  return sa;
}

// Domain-wide delegation: impersonates the meeting's organizer so the invite genuinely comes
// from them, not an anonymous service account.
async function getAccessToken(userEmail, sa, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJWT({ iss: sa.client_email, scope: WRITE_SCOPE, aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now, sub: userEmail }, sa.private_key);
  const resp = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(jwt),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`Auth failed for ${userEmail}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

async function fbGet(path) {
  const resp = await fetch(authedUrl(`${FB}/${path}.json`));
  return resp.json().catch(() => null);
}
// Logs (rather than swallows) a rejected write — a caller can still choose to treat it as a
// non-fatal warning, but it is never silently invisible either way.
async function fbPatch(path, obj) {
  const resp = await fetch(authedUrl(`${FB}/${path}.json`), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error(`Firebase PATCH ${path} failed (${resp.status}): ${errText.slice(0, 300)}`);
  }
  return resp;
}

function fbSafeKey(s) { return String(s).replace(/[.#$[\]/]/g, "_"); }

function fmtIST(iso) {
  if (!iso || iso.length <= 10) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

function deriveEmail(member) {
  if (member.email) return member.email;
  return String(member.name || "").toLowerCase().replace(/\s+/g, "") + "@loona.in";
}

// "priya.sharma+meet@clientco.com" -> "Priya" — just the first name, not a reconstructed
// full name from the local-part.
function deriveGuestFirstName(email) {
  const local = String(email).split("@")[0] || email;
  const first = local.split(/[._+-]+/)[0] || local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : email;
}

function normName(n) { return String(n || "").trim().toLowerCase(); }

async function loadMemberByName(get) {
  const membersData = await get("members");
  const members = Object.values(membersData || {}).filter((m) => m && m.name);
  const memberByName = {};
  members.forEach((m) => { memberByName[String(m.name).toLowerCase()] = m; });
  return memberByName;
}

// Creates a real Google Calendar event (with an auto-generated Meet link for a plain
// "meeting" — a physical_meeting/shoot has nowhere virtual to join, so it skips
// conferenceData and uses `location` instead), impersonating the creator via the same
// domain-wide delegation service account calendar-sync.js reads with.
//
// params: { creatorName, title, date (YYYY-MM-DD), startTime (HH:MM), endTime (HH:MM),
//   attendees: [member names], guestEmails: [raw emails], brand, description, location,
//   eventKind }
async function createMeeting(params, deps = {}) {
  const get = deps.fbGet || fbGet;
  const patch = deps.fbPatch || fbPatch;
  const fetchImpl = deps.fetchImpl || fetch;
  const sa = await loadServiceAccount(deps);

  const { creatorName, title, date, startTime, endTime, attendees, guestEmails, brand, description, location } = params;
  const eventKind = ["meeting", "physical_meeting", "shoot"].includes(params.eventKind) ? params.eventKind : "meeting";
  if (!creatorName || !title || !date || !startTime || !endTime) {
    throw new Error("Missing required fields (creatorName, title, date, startTime, endTime)");
  }

  const memberByName = await loadMemberByName(get);
  const creator = memberByName[normName(creatorName)];
  if (!creator) throw new Error(`"${creatorName}" not found in the team roster`);
  const creatorEmail = deriveEmail(creator);

  const requestedAttendees = attendees || [];
  const attendeeMembers = requestedAttendees.map((name) => memberByName[normName(name)]).filter(Boolean);
  const unresolvedAttendees = requestedAttendees.filter((name) => !memberByName[normName(name)]);
  const attendeeEmails = attendeeMembers.map(deriveEmail).filter((email) => email.toLowerCase() !== creatorEmail.toLowerCase());

  const validGuestEmails = [...new Set((guestEmails || []).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))]
    .filter((e) => e !== creatorEmail.toLowerCase() && !attendeeEmails.map((a) => a.toLowerCase()).includes(e));

  const accessToken = await getAccessToken(creatorEmail, sa, fetchImpl);

  const eventBody = {
    summary: title,
    description: description || "",
    start: { dateTime: `${date}T${startTime}:00`, timeZone: "Asia/Kolkata" },
    end: { dateTime: `${date}T${endTime}:00`, timeZone: "Asia/Kolkata" },
    attendees: [...attendeeEmails, ...validGuestEmails].map((email) => ({ email })),
  };
  if (location) eventBody.location = location;
  if (eventKind === "meeting") {
    eventBody.conferenceData = {
      createRequest: {
        requestId: "loonahub_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const resp = await fetchImpl(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
    { method: "POST", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" }, body: JSON.stringify(eventBody) },
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Calendar API ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);

  const uid = data.iCalUID || data.id;
  const videoEntry = data.conferenceData && data.conferenceData.entryPoints && data.conferenceData.entryPoints.find((e) => e.entryPointType === "video");
  const callLink = data.hangoutLink || (videoEntry && videoEntry.uri) || "";

  const knownAttendees = [...new Set([creatorName, ...attendeeMembers.map((m) => m.name)])];
  const guestNames = validGuestEmails.map(deriveGuestFirstName);

  const calendarEventEntry = {
    uid,
    title: data.summary || title,
    start: `${date}T${startTime}:00+05:30`,
    end: `${date}T${endTime}:00+05:30`,
    attendeeCount: knownAttendees.length + guestNames.length,
    knownAttendees,
    guestNames,
    guestEmails: validGuestEmails,
    brand: brand || "",
    eventKind,
    location: location || "",
    organizer: creatorName,
    organizerEmail: creatorEmail,
    googleEventId: data.id || "",
    callLink,
    htmlLink: data.htmlLink || "",
    updatedAt: Date.now(),
  };
  const warnings = [];
  const eventKey = fbSafeKey(uid);
  const calEventsResp = await patch("calendarEvents", { [eventKey]: calendarEventEntry });
  if (!calEventsResp.ok) warnings.push(`${KIND_LABEL[eventKind]} created on Google Calendar, but saving it into Loona Hub failed — it may not show up on the Calendar tab.`);

  const startTimeLabel = fmtIST(calendarEventEntry.start);
  const endTimeLabel = fmtIST(calendarEventEntry.end);
  const timeRange = startTimeLabel ? (endTimeLabel && endTimeLabel !== startTimeLabel ? `${startTimeLabel} – ${endTimeLabel} IST` : `${startTimeLabel} IST`) : "";
  const taskText = `${KIND_LABEL[eventKind]}: ${calendarEventEntry.title}${location ? ` @ ${location}` : ""}${timeRange ? ` (${timeRange})` : ""}`;

  const taskLog = (await get("calendarSyncLog/tasks")) || {};
  const newTasks = {};
  const taskLogUpdate = {};
  knownAttendees.forEach((name) => {
    const sig = uid + "|" + name;
    const logKey = fbSafeKey(sig);
    if (taskLog[logKey]) return;
    const key = "auto_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2) + "_" + fbSafeKey(name);
    newTasks[key] = {
      member: name, brand: brand || "", task: taskText, priority: "Medium", status: "Not Started",
      due_date: date, assigned_by: "Google Calendar", is_auto: true, auto_calendar_event_id: uid,
      meeting_link: callLink || calendarEventEntry.htmlLink || "", created_at: new Date().toISOString(),
    };
    taskLogUpdate[logKey] = true;
  });
  if (Object.keys(newTasks).length) await patch("tasks", newTasks);
  if (Object.keys(taskLogUpdate).length) await patch("calendarSyncLog/tasks", taskLogUpdate);

  const annLog = (await get("calendarSyncLog/announcements")) || {};
  const annLogKey = fbSafeKey(uid);
  if (!annLog[annLogKey]) {
    const allNames = [...knownAttendees, ...guestNames];
    const annKey = "auto_ann_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
    const annResp = await patch("announcements", {
      [annKey]: {
        id: Date.now(),
        text: `${KIND_EMOJI[eventKind]} ${calendarEventEntry.title}${timeRange ? ` — ${timeRange}` : ""}${brand ? ` · ${brand}` : ""}${location ? ` · ${location}` : ""} · ${allNames.join(", ")}`,
        links: (callLink || calendarEventEntry.htmlLink) ? [callLink || calendarEventEntry.htmlLink] : [],
        author: creatorName, emoji: "📅", timestamp: new Date().toISOString(), calendar_event_id: uid, visibleTo: knownAttendees,
      },
    });
    if (!annResp.ok) warnings.push("Meeting created, but the Loona Board post failed to save — it won't show up there.");
    else await patch("calendarSyncLog/announcements", { [annLogKey]: true });
  }

  return { success: true, eventId: data.id, eventKey, htmlLink: data.htmlLink || "", callLink, warnings, unresolvedAttendees };
}

// Reschedules/edits an existing meeting, impersonating the ORIGINAL ORGANIZER regardless of
// who requested the edit — Google generally requires organizer-level permission to change an
// event's time/attendees for everyone. Deliberately does NOT touch conferenceData — a plain
// PATCH leaves whatever Meet link already exists untouched.
//
// params: { eventKey (calendarEvents' Firebase key), requesterName, title, date, startTime,
//   endTime, attendees, guestEmails, brand, description, location, eventKind }
async function updateMeeting(params, deps = {}) {
  const get = deps.fbGet || fbGet;
  const patch = deps.fbPatch || fbPatch;
  const fetchImpl = deps.fetchImpl || fetch;
  const sa = await loadServiceAccount(deps);

  const { eventKey, requesterName } = params;
  if (!eventKey || !requesterName) throw new Error("Missing required fields (eventKey, requesterName)");

  const existing = await get(`calendarEvents/${eventKey}`);
  if (!existing) throw new Error("This meeting is not in Loona Hub's calendar — try \"Sync now\" first, then edit again.");
  if (!existing.googleEventId) throw new Error("This meeting was synced before edit support existed — hit \"Sync now\" once to refresh it, then try editing again.");
  if (!existing.uid) throw new Error("This meeting is missing internal tracking data — hit \"Sync now\" once to refresh it, then try editing again.");
  const eventKind = ["meeting", "physical_meeting", "shoot"].includes(params.eventKind) ? params.eventKind : (existing.eventKind || "meeting");

  const memberByName = await loadMemberByName(get);

  // Server-side authorization, not just a UI decision — only the organizer or Gokul may
  // reschedule a meeting that sends real Calendar updates to everyone on it.
  const isAuthorized = normName(requesterName) === "gokul" || normName(requesterName) === normName(existing.organizer);
  if (!isAuthorized) throw new Error(`Only ${existing.organizer} (or Gokul) can edit this meeting.`);

  let organizerEmail = existing.organizerEmail;
  if (!organizerEmail) {
    const organizerMember = memberByName[normName(existing.organizer)];
    if (organizerMember) organizerEmail = deriveEmail(organizerMember);
  }
  if (!organizerEmail) throw new Error(`Could not resolve an email for organizer "${existing.organizer}" — hit "Sync now" once to refresh this meeting, then try again.`);

  const accessToken = await getAccessToken(organizerEmail, sa, fetchImpl);

  // Hub's own edit form always resubmits every field, so this merge is a no-op for it — but
  // BB will often be asked to change just one thing ("push it to 3pm"), and Hub's own
  // Firebase mirror doesn't even store the description at all. Fetching the live event and
  // defaulting anything the caller didn't explicitly set to what is ACTUALLY on the calendar
  // right now — rather than to an empty value — is what stops an edit like that from quietly
  // wiping the description, the location, or (worst of all) silently un-inviting everyone
  // already on it.
  const liveResp = await fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(existing.googleEventId)}`, {
    headers: { Authorization: "Bearer " + accessToken },
  });
  const live = liveResp.ok ? await liveResp.json().catch(() => ({})) : {};
  const liveStart = live.start && live.start.dateTime;
  const liveEnd = live.end && live.end.dateTime;

  const title = params.title !== undefined ? params.title : (live.summary || existing.title);
  const date = params.date !== undefined ? params.date : (liveStart ? liveStart.slice(0, 10) : String(existing.start || "").slice(0, 10));
  const startTime = params.startTime !== undefined ? params.startTime : (liveStart ? liveStart.slice(11, 16) : String(existing.start || "").slice(11, 16));
  const endTime = params.endTime !== undefined ? params.endTime : (liveEnd ? liveEnd.slice(11, 16) : String(existing.end || "").slice(11, 16));
  const description = params.description !== undefined ? params.description : (live.description || "");
  const location = params.location !== undefined ? params.location : (live.location || existing.location || "");
  const brand = params.brand !== undefined ? params.brand : (existing.brand || "");

  if (!title || !date || !startTime || !endTime) throw new Error("Missing required fields (title, date, startTime, endTime) and none could be recovered from the live calendar event.");
  if (endTime <= startTime) throw new Error("End time must be after start time");

  // Same reasoning for attendees: only fall back to whoever is ACTUALLY on the live invite
  // right now when neither attendees nor guestEmails was mentioned at all — an explicit empty
  // list is still honored as "remove everyone", since that is a real, intentional thing to ask.
  let attendees = params.attendees;
  let guestEmails = params.guestEmails;
  if (attendees === undefined && guestEmails === undefined) {
    const memberByEmail = {};
    Object.values(memberByName).forEach((m) => { memberByEmail[deriveEmail(m).toLowerCase()] = m.name; });
    const liveAttendeeEmails = (live.attendees || [])
      .map((a) => String(a.email || "").toLowerCase())
      .filter((email) => email && email !== organizerEmail.toLowerCase());
    attendees = liveAttendeeEmails.filter((email) => memberByEmail[email]).map((email) => memberByEmail[email]);
    guestEmails = liveAttendeeEmails.filter((email) => !memberByEmail[email]);
  }

  const requestedAttendees = attendees || [];
  const attendeeMembers = requestedAttendees.map((name) => memberByName[normName(name)]).filter(Boolean);
  const unresolvedAttendees = requestedAttendees.filter((name) => !memberByName[normName(name)]);
  const attendeeEmails = attendeeMembers.map(deriveEmail).filter((email) => email.toLowerCase() !== organizerEmail.toLowerCase());

  const validGuestEmails = [...new Set((guestEmails || []).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))]
    .filter((e) => e !== organizerEmail.toLowerCase() && !attendeeEmails.map((a) => a.toLowerCase()).includes(e));

  const patchBody = {
    summary: title,
    description: description || "",
    location: location || "",
    start: { dateTime: `${date}T${startTime}:00`, timeZone: "Asia/Kolkata" },
    end: { dateTime: `${date}T${endTime}:00`, timeZone: "Asia/Kolkata" },
    attendees: [...attendeeEmails, ...validGuestEmails].map((email) => ({ email })),
  };

  const resp = await fetchImpl(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(existing.googleEventId)}?sendUpdates=all`,
    { method: "PATCH", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" }, body: JSON.stringify(patchBody) },
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Calendar API ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);

  const uid = existing.uid;
  const knownAttendees = [...new Set([existing.organizer, ...attendeeMembers.map((m) => m.name)])];
  const guestNames = validGuestEmails.map(deriveGuestFirstName);

  const updatedEntry = {
    ...existing, title, eventKind, location: location || "",
    start: `${date}T${startTime}:00+05:30`, end: `${date}T${endTime}:00+05:30`,
    attendeeCount: knownAttendees.length + guestNames.length, knownAttendees, guestNames,
    guestEmails: validGuestEmails, brand: brand || "", updatedAt: Date.now(),
  };
  await patch("calendarEvents", { [eventKey]: updatedEntry });

  const startTimeLabel = fmtIST(updatedEntry.start);
  const endTimeLabel = fmtIST(updatedEntry.end);
  const timeRange = startTimeLabel ? (endTimeLabel && endTimeLabel !== startTimeLabel ? `${startTimeLabel} – ${endTimeLabel} IST` : `${startTimeLabel} IST`) : "";
  const newTaskText = `${KIND_LABEL[eventKind]}: ${title}${location ? ` @ ${location}` : ""}${timeRange ? ` (${timeRange})` : ""}`;

  const existingTasksData = await get("tasks");
  const existingTasks = existingTasksData ? Object.entries(existingTasksData) : [];
  const taskUpdates = {};
  let tasksUpdated = 0;
  existingTasks.forEach(([key, t]) => {
    if (t && t.auto_calendar_event_id === uid && t.status !== "Completed") {
      taskUpdates[key] = { ...t, task: newTaskText, due_date: date };
      tasksUpdated++;
    }
  });
  if (Object.keys(taskUpdates).length) await patch("tasks", taskUpdates);

  const existingAnnData = await get("announcements");
  const existingAnn = existingAnnData ? Object.entries(existingAnnData) : [];
  const annEntry = existingAnn.find(([, a]) => a && a.calendar_event_id === uid);
  if (annEntry) {
    const [annKey, ann] = annEntry;
    const allNames = [...knownAttendees, ...guestNames];
    await patch("announcements", {
      [annKey]: {
        ...ann,
        text: `${KIND_EMOJI[eventKind]} ${title}${timeRange ? ` — ${timeRange}` : ""}${brand ? ` · ${brand}` : ""}${location ? ` · ${location}` : ""} · ${allNames.join(", ")} (rescheduled)`,
        timestamp: new Date().toISOString(), visibleTo: knownAttendees,
      },
    });
  }

  return { success: true, tasksUpdated, callLink: existing.callLink || "", htmlLink: existing.htmlLink || "", unresolvedAttendees };
}

// Read-only lookup, shared by the Calendar tab's own search and BB's find_meetings tool.
async function findMeetings({ member, brand, date, query } = {}, deps = {}) {
  const get = deps.fbGet || fbGet;
  const events = (await get("calendarEvents")) || {};
  const wantedMember = member ? normName(member) : null;
  const wantedBrand = brand ? String(brand).trim().toLowerCase() : null;
  const wantedDate = date ? String(date).trim() : null;
  const wantedQuery = query ? String(query).trim().toLowerCase() : null;
  const results = [];
  for (const [eventKey, ev] of Object.entries(events)) {
    if (!ev) continue;
    if (wantedMember && !(ev.knownAttendees || []).some((name) => normName(name) === wantedMember)) continue;
    if (wantedBrand && String(ev.brand || "").trim().toLowerCase() !== wantedBrand) continue;
    if (wantedDate && String(ev.start || "").slice(0, 10) !== wantedDate) continue;
    if (wantedQuery && !String(ev.title || "").toLowerCase().includes(wantedQuery)) continue;
    results.push({
      eventKey, title: ev.title || null, start: ev.start || null, end: ev.end || null,
      organizer: ev.organizer || null, attendees: ev.knownAttendees || [], brand: ev.brand || null,
      location: ev.location || null, eventKind: ev.eventKind || "meeting", callLink: ev.callLink || null,
      htmlLink: ev.htmlLink || null,
    });
  }
  return results;
}

module.exports = { createMeeting, updateMeeting, findMeetings, KIND_LABEL, KIND_EMOJI };
