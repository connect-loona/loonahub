// ============================================================================
// LOONA Hub · Google Calendar → Firebase sync (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Uses a Google Cloud service account authorized for Workspace domain-wide
// delegation to read each team member's calendar (read-only, via short-lived
// impersonation tokens — never a stored per-user OAuth grant) and sync meeting
// events into Firebase. Also auto-creates a "Meeting: ..." task per known
// attendee for real meetings (2+ attendees), same is_auto pattern the
// Brand-of-the-Day auto task already uses.
//
// Firebase paths:
//   /calendarEvents/{safeUid} = { title, start, end, attendeeCount,
//     knownAttendees: [names], organizer, organizerEmail, googleEventId (the
//     raw Google event id — distinct from safeUid/iCalUID, needed to PATCH the
//     event later — see calendar-update.js), callLink (actual video join URL,
//     if any), htmlLink (calendar event page), updatedAt }
//   /tasks/{key} — auto-created, tagged is_auto + auto_calendar_event_id for dedup
//   /announcements/{key} — one Loona Board post per meeting (not per attendee),
//     tagged calendar_event_id for dedup and visibleTo: [names] so it only shows
//     to the actual participants, not the whole team
//   /calendarSyncLog/tasks/{safe(uid|attendee)} = true
//   /calendarSyncLog/announcements/{safeUid} = true
//     Permanent "already created this once" ledger, checked instead of scanning
//     the live tasks/announcements nodes. Someone deleting a completed meeting
//     task (or dismissing a Loona Board post) removes the live record, but the
//     next sync run must NOT treat that as "never created" and recreate it —
//     this ledger is what a deletion doesn't touch.
//
// Team roster + emails come from /members.json (already synced by the app) —
// a member's email is guessed as "firstname@loona.in" unless that member's
// Firebase record has an explicit "email" field, which always wins.
//
// Env vars:
//   GOOGLE_CALENDAR_SERVICE_ACCOUNT  (full JSON key contents, as a string)
//   FIREBASE_DB_URL  (optional; defaults to the loona-hub RTDB)
//
// Manual run (for testing): GET /.netlify/functions/calendar-sync
// ============================================================================

const crypto = require('crypto');

const FB = (process.env.FIREBASE_DB_URL || 'https://loona-hub-c85d7-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const DAYS_AHEAD = 21;
const DAYS_BEHIND = 3;

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJWT(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return signingInput + '.' + base64url(signature);
}

// Google's standard JWT Bearer Token flow for service accounts (RFC 7523) —
// "sub" is what makes this domain-wide delegation: it impersonates that user
// without them ever granting consent themselves, since a Workspace admin
// authorized this service account for the whole domain up front.
async function getAccessToken(userEmail, sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJWT({
    iss: sa.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
    sub: userEmail
  }, sa.private_key);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`Auth failed for ${userEmail}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

async function fetchEventsForUser(userEmail, accessToken) {
  const now = Date.now();
  const timeMin = new Date(now - DAYS_BEHIND * 86400000).toISOString();
  const timeMax = new Date(now + DAYS_AHEAD * 86400000).toISOString();
  const params = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(userEmail)}/events?${params}`;
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`Calendar fetch failed for ${userEmail}: ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
    return [];
  }
  return data.items || [];
}

// Firebase RTDB keys can't contain . # $ [ ] / — iCalUIDs commonly look like
// "abc123@google.com", which has a dot.
function fbSafeKey(s) {
  return String(s).replace(/[.#$[\]/]/g, '_');
}

async function fbGet(path) {
  const resp = await fetch(FB + '/' + path + '.json');
  return resp.json().catch(() => null);
}
async function fbPatch(path, obj) {
  return fetch(FB + '/' + path + '.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
}

function fmtIST(iso) {
  if (!iso) return '';
  if (iso.length <= 10) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

function deriveEmail(member) {
  if (member.email) return member.email;
  return String(member.name || '').toLowerCase().replace(/\s+/g, '') + '@loona.in';
}

async function runSync() {
  // Also accepts the "CALENDER" misspelling — that's how it's actually named in
  // the Netlify dashboard, and env var keys can't be renamed there without
  // re-pasting the JSON key value, so we just read either.
  const saRaw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT not set');
  let sa;
  try { sa = JSON.parse(saRaw); } catch (e) { throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key');

  const membersData = await fbGet('members');
  // Same legacy-array-or-object shape the client's own inactive_members
  // listener tolerates (see index.html) — inactive_members is the ONLY
  // offboarding record this app has; a removed person's row under members/
  // never gets deleted, so without this filter someone like Ananya keeps
  // getting her real Google Calendar polled (impersonated via domain-wide
  // delegation) and keeps getting a "Meeting: ..." task + Loona Board post
  // auto-created for every meeting she's on, forever, even after she's off
  // the active roster.
  const inactiveRaw = (await fbGet('inactive_members')) || {};
  const inactiveNames = new Set(Array.isArray(inactiveRaw) ? inactiveRaw : Object.values(inactiveRaw));
  const members = Object.values(membersData || {}).filter(m => m && m.name && !inactiveNames.has(m.name));
  if (!members.length) return { synced: 0, tasksCreated: 0, note: 'No members found in Firebase yet' };

  const emailToName = {};
  members.forEach(m => { emailToName[deriveEmail(m).toLowerCase()] = m.name; });

  const eventsByUid = new Map();
  const fetchErrors = [];

  // Parallel across members, not sequential — each member is 2 network round-trips
  // (token + events), and awaiting those one-by-one for a team of any real size risks
  // blowing past Netlify's function timeout, which is exactly what made this feel slow
  // (a run that times out partway through writes nothing for that run at all).
  await Promise.all(members.map(async member => {
    const email = deriveEmail(member);
    try {
      const accessToken = await getAccessToken(email, sa);
      const events = await fetchEventsForUser(email, accessToken);
      events.forEach(ev => {
        if (!ev.id || ev.status === 'cancelled') return;
        const uid = ev.iCalUID || ev.id;
        if (eventsByUid.has(uid)) return; // same meeting already seen via another attendee's calendar

        const allEmails = new Set((ev.attendees || []).map(a => (a.email || '').toLowerCase()).filter(Boolean));
        if (ev.organizer && ev.organizer.email) allEmails.add(ev.organizer.email.toLowerCase());
        const knownAttendees = [...new Set([...allEmails].map(e => emailToName[e]).filter(Boolean))];
        const organizerEmail = (ev.organizer && ev.organizer.email || '').toLowerCase();

        // hangoutLink / conferenceData is the actual join URL (Meet, or whatever
        // conferencing add-on was used) — htmlLink is just the calendar event page,
        // which makes people click through an extra screen to find the real link.
        const videoEntry = ev.conferenceData && ev.conferenceData.entryPoints && ev.conferenceData.entryPoints.find(e => e.entryPointType === 'video');
        const callLink = ev.hangoutLink || (videoEntry && videoEntry.uri) || '';

        eventsByUid.set(uid, {
          // fbSafeKey isn't reliably reversible (multiple distinct chars collapse to the
          // same "_"), so the raw uid is stored explicitly rather than derived back from
          // the Firebase key — calendar-update.js needs the exact original to match
          // against auto_calendar_event_id on tasks/announcements.
          uid,
          title: ev.summary || '(untitled meeting)',
          start: (ev.start && (ev.start.dateTime || ev.start.date)) || '',
          end: (ev.end && (ev.end.dateTime || ev.end.date)) || '',
          attendeeCount: allEmails.size,
          knownAttendees,
          organizer: emailToName[organizerEmail] || organizerEmail || '',
          organizerEmail,
          // Distinct from uid (iCalUID, used for the Firebase key/dedup) — this is the
          // literal Google event id calendar-update.js needs for its PATCH URL.
          googleEventId: ev.id || '',
          callLink,
          htmlLink: ev.htmlLink || '',
          updatedAt: Date.now()
        });
      });
    } catch (e) {
      fetchErrors.push({ member: member.name, error: String(e.message || e) });
    }
  }));

  // Solo calendar entries (focus time, personal reminders, doctor's appointments) have
  // only 1 attendee and no business syncing into a shared company tool at all — drop
  // them here rather than just excluding them from auto-tasking below.
  for (const [uid, data] of eventsByUid) {
    if (data.attendeeCount < 2) eventsByUid.delete(uid);
  }

  const eventsUpdate = {};
  eventsByUid.forEach((data, uid) => { eventsUpdate[fbSafeKey(uid)] = data; });
  if (Object.keys(eventsUpdate).length) await fbPatch('calendarEvents', eventsUpdate);

  // Auto-task per known attendee — everything left in eventsByUid is already a real
  // meeting (2+ attendees) since solo blocks were dropped just above.
  let tasksCreated = 0;
  const taskLog = await fbGet('calendarSyncLog/tasks') || {};
  const taskLogUpdate = {};

  const newTasks = {};
  for (const [uid, data] of eventsByUid) {
    if (data.attendeeCount < 2 || !data.knownAttendees.length) continue;
    for (const attendeeName of data.knownAttendees) {
      const sig = uid + '|' + attendeeName;
      const logKey = fbSafeKey(sig);
      if (taskLog[logKey] || taskLogUpdate[logKey]) continue;
      const key = 'auto_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
      const startTime = fmtIST(data.start);
      const endTime = fmtIST(data.end);
      const timeRange = startTime ? (endTime && endTime !== startTime ? `${startTime} – ${endTime} IST` : `${startTime} IST`) : '';
      newTasks[key] = {
        member: attendeeName,
        brand: '',
        task: `Meeting: ${data.title}${timeRange ? ` (${timeRange})` : ''}`,
        priority: 'Medium',
        status: 'Not Started',
        due_date: (data.start || '').slice(0, 10),
        assigned_by: 'Google Calendar',
        is_auto: true,
        auto_calendar_event_id: uid,
        meeting_link: data.callLink || data.htmlLink || '',
        created_at: new Date().toISOString()
        // no assigned_on here — the client already falls back to formatting
        // created_at with fmtStamp() when assigned_on is absent, which matches
        // how every other task in the app displays it. A raw ISO string here
        // (what this used to be) shows up looking wrong next to that format.
      };
      taskLogUpdate[logKey] = true;
      tasksCreated++;
    }
  }
  if (Object.keys(newTasks).length) await fbPatch('tasks', newTasks);
  if (Object.keys(taskLogUpdate).length) await fbPatch('calendarSyncLog/tasks', taskLogUpdate);

  // Loona Board post per meeting (not per attendee) — visible only to the actual
  // participants, in addition to (not instead of) each attendee's own task.
  let boardPosted = 0;
  const annLog = await fbGet('calendarSyncLog/announcements') || {};
  const annLogUpdate = {};

  const newAnnouncements = {};
  let idBump = 0;
  for (const [uid, data] of eventsByUid) {
    if (data.attendeeCount < 2 || !data.knownAttendees.length) continue;
    const logKey = fbSafeKey(uid);
    if (annLog[logKey] || annLogUpdate[logKey]) continue;
    const startTime = fmtIST(data.start);
    const endTime = fmtIST(data.end);
    const timeRange = startTime ? (endTime && endTime !== startTime ? `${startTime} – ${endTime} IST` : `${startTime} IST`) : '';
    const key = 'auto_ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
    newAnnouncements[key] = {
      id: Date.now() + (idBump++),
      text: `📅 ${data.title}${timeRange ? ` — ${timeRange}` : ''} · ${data.knownAttendees.join(', ')}`,
      links: (data.callLink || data.htmlLink) ? [data.callLink || data.htmlLink] : [],
      author: 'Google Calendar',
      emoji: '📅',
      timestamp: new Date().toISOString(),
      calendar_event_id: uid,
      visibleTo: data.knownAttendees
    };
    annLogUpdate[logKey] = true;
    boardPosted++;
  }
  if (Object.keys(newAnnouncements).length) await fbPatch('announcements', newAnnouncements);
  if (Object.keys(annLogUpdate).length) await fbPatch('calendarSyncLog/announcements', annLogUpdate);

  return { synced: eventsByUid.size, tasksCreated, boardPosted, errors: fetchErrors };
}

exports.handler = async (event) => {
  try {
    const result = await runSync();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
