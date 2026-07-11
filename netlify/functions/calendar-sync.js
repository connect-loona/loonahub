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
//     knownAttendees: [names], organizer, htmlLink, updatedAt }
//   /tasks/{key} — auto-created, tagged is_auto + auto_calendar_event_id for dedup
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
  const members = Object.values(membersData || {}).filter(m => m && m.name);
  if (!members.length) return { synced: 0, tasksCreated: 0, note: 'No members found in Firebase yet' };

  const emailToName = {};
  members.forEach(m => { emailToName[deriveEmail(m).toLowerCase()] = m.name; });

  const eventsByUid = new Map();
  const fetchErrors = [];

  for (const member of members) {
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

        eventsByUid.set(uid, {
          title: ev.summary || '(untitled meeting)',
          start: (ev.start && (ev.start.dateTime || ev.start.date)) || '',
          end: (ev.end && (ev.end.dateTime || ev.end.date)) || '',
          attendeeCount: allEmails.size,
          knownAttendees,
          organizer: emailToName[organizerEmail] || organizerEmail || '',
          htmlLink: ev.htmlLink || '',
          updatedAt: Date.now()
        });
      });
    } catch (e) {
      fetchErrors.push({ member: member.name, error: String(e.message || e) });
    }
  }

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
  const existingTasksData = await fbGet('tasks');
  const existingTasks = Object.values(existingTasksData || {});
  const existingSigs = new Set(
    existingTasks.filter(t => t && t.is_auto && t.auto_calendar_event_id)
      .map(t => t.auto_calendar_event_id + '|' + (t.member || ''))
  );

  const newTasks = {};
  for (const [uid, data] of eventsByUid) {
    if (data.attendeeCount < 2 || !data.knownAttendees.length) continue;
    for (const attendeeName of data.knownAttendees) {
      const sig = uid + '|' + attendeeName;
      if (existingSigs.has(sig)) continue;
      const key = 'auto_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
      newTasks[key] = {
        member: attendeeName,
        brand: '',
        task: `Meeting: ${data.title}`,
        priority: 'Medium',
        status: 'Not Started',
        due_date: (data.start || '').slice(0, 10),
        assigned_by: 'Google Calendar',
        is_auto: true,
        auto_calendar_event_id: uid,
        created_at: new Date().toISOString(),
        assigned_on: new Date().toISOString()
      };
      existingSigs.add(sig);
      tasksCreated++;
    }
  }
  if (Object.keys(newTasks).length) await fbPatch('tasks', newTasks);

  return { synced: eventsByUid.size, tasksCreated, errors: fetchErrors };
}

exports.handler = async (event) => {
  try {
    const result = await runSync();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
