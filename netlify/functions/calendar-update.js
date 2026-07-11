// ============================================================================
// LOONA Hub · Reschedule/edit an existing Google Calendar meeting (Netlify Function)
// ----------------------------------------------------------------------------
// PATCHes a real Google Calendar event (created either via calendar-create.js
// or synced from a meeting someone made directly in Google Calendar),
// impersonating the ORIGINAL ORGANIZER regardless of who in Loona Hub
// requested the edit — Google's API generally requires organizer-level
// permission to change an event's time/attendees for everyone, and the
// organizer is who real Calendar invite updates should appear to come from.
//
// Deliberately does NOT touch conferenceData — a plain PATCH leaves whatever
// Meet link already exists untouched, so editing a meeting never accidentally
// swaps in a second, different Meet link.
//
// POST body: { eventKey (calendarEvents' Firebase key), requesterName, title,
//   date (YYYY-MM-DD), startTime (HH:MM), endTime (HH:MM),
//   attendees: [member names], guestEmails: [raw emails], brand, description }
//
// Requires the same https://www.googleapis.com/auth/calendar.events scope
// calendar-create.js needs (see that file's header comment).
// ============================================================================

const crypto = require('crypto');

const FB = (process.env.FIREBASE_DB_URL || 'https://loona-hub-c85d7-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJWT(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return signingInput + '.' + base64url(signature);
}

async function getAccessToken(userEmail, sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJWT({
    iss: sa.client_email,
    scope: WRITE_SCOPE,
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deriveGuestFirstName(email) {
  const local = String(email).split('@')[0] || email;
  const first = local.split(/[._+-]+/)[0] || local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : email;
}

function normName(n) { return String(n || '').trim().toLowerCase(); }

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

  try {
    const saRaw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
    if (!saRaw) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT not set');
    let sa;
    try { sa = JSON.parse(saRaw); } catch (e) { throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON'); }
    if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key');

    const body = JSON.parse(event.body || '{}');
    const { eventKey, requesterName, title, date, startTime, endTime, attendees, guestEmails, brand, description } = body;
    if (!eventKey || !requesterName || !title || !date || !startTime || !endTime) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Missing required fields (eventKey, requesterName, title, date, startTime, endTime)' }) };
    }
    if (endTime <= startTime) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'End time must be after start time' }) };
    }

    const existing = await fbGet('calendarEvents/' + eventKey);
    if (!existing) throw new Error('This meeting is not in Loona Hub\'s calendar — try "Sync now" first, then edit again.');
    if (!existing.googleEventId) throw new Error('This meeting was synced before edit support existed — hit "Sync now" once to refresh it, then try editing again.');
    if (!existing.uid) throw new Error('This meeting is missing internal tracking data — hit "Sync now" once to refresh it, then try editing again.');

    const membersData = await fbGet('members');
    const members = Object.values(membersData || {}).filter(m => m && m.name);
    const memberByName = {};
    members.forEach(m => { memberByName[String(m.name).toLowerCase()] = m; });

    // Server-side authorization, not just client-side button visibility — only the
    // organizer or Gokul may reschedule a meeting that sends real Calendar updates
    // to everyone on it.
    const isAuthorized = normName(requesterName) === 'gokul' || normName(requesterName) === normName(existing.organizer);
    if (!isAuthorized) throw new Error('Only the organizer (or Gokul) can edit this meeting.');

    let organizerEmail = existing.organizerEmail;
    if (!organizerEmail) {
      const organizerMember = memberByName[String(existing.organizer || '').toLowerCase()];
      if (organizerMember) organizerEmail = deriveEmail(organizerMember);
    }
    if (!organizerEmail) throw new Error(`Could not resolve an email for organizer "${existing.organizer}" — hit "Sync now" once to refresh this meeting, then try again.`);

    const attendeeMembers = (attendees || [])
      .map(name => memberByName[String(name).toLowerCase()])
      .filter(Boolean);
    const attendeeEmails = attendeeMembers
      .map(deriveEmail)
      .filter(email => email.toLowerCase() !== organizerEmail.toLowerCase());

    const validGuestEmails = [...new Set((guestEmails || []).map(e => String(e).trim().toLowerCase()).filter(e => EMAIL_RE.test(e)))]
      .filter(e => e !== organizerEmail.toLowerCase() && !attendeeEmails.map(a => a.toLowerCase()).includes(e));

    const accessToken = await getAccessToken(organizerEmail, sa);

    const patchBody = {
      summary: title,
      description: description || '',
      start: { dateTime: `${date}T${startTime}:00`, timeZone: 'Asia/Kolkata' },
      end: { dateTime: `${date}T${endTime}:00`, timeZone: 'Asia/Kolkata' },
      attendees: [...attendeeEmails, ...validGuestEmails].map(email => ({ email }))
      // No conferenceData here on purpose — see file header comment.
    };

    const resp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(existing.googleEventId)}?sendUpdates=all`,
      {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody)
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Calendar API ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);

    const uid = existing.uid;
    const knownAttendees = [...new Set([existing.organizer, ...attendeeMembers.map(m => m.name)])];
    const guestNames = validGuestEmails.map(deriveGuestFirstName);

    const updatedEntry = {
      ...existing,
      title,
      start: `${date}T${startTime}:00+05:30`,
      end: `${date}T${endTime}:00+05:30`,
      attendeeCount: knownAttendees.length + guestNames.length,
      knownAttendees,
      guestNames,
      guestEmails: validGuestEmails,
      brand: brand || '',
      updatedAt: Date.now()
    };
    await fbPatch('calendarEvents', { [eventKey]: updatedEntry });

    // Refresh existing incomplete tasks for this meeting so due dates/times don't go
    // stale — completed tasks are left alone, that work already happened and
    // shouldn't get silently rewritten under someone.
    const startTimeLabel = fmtIST(updatedEntry.start);
    const endTimeLabel = fmtIST(updatedEntry.end);
    const timeRange = startTimeLabel ? (endTimeLabel && endTimeLabel !== startTimeLabel ? `${startTimeLabel} – ${endTimeLabel} IST` : `${startTimeLabel} IST`) : '';
    const newTaskText = `Meeting: ${title}${timeRange ? ` (${timeRange})` : ''}`;

    const existingTasksData = await fbGet('tasks');
    const existingTasks = existingTasksData ? Object.entries(existingTasksData) : [];
    const taskUpdates = {};
    let tasksUpdated = 0;
    existingTasks.forEach(([key, t]) => {
      if (t && t.auto_calendar_event_id === uid && t.status !== 'Completed') {
        taskUpdates[key] = { ...t, task: newTaskText, due_date: date };
        tasksUpdated++;
      }
    });
    if (Object.keys(taskUpdates).length) await fbPatch('tasks', taskUpdates);

    // Same idea for the Loona Board post — update it in place rather than posting a
    // second one, so the board doesn't accumulate duplicate entries for one meeting.
    const existingAnnData = await fbGet('announcements');
    const existingAnn = existingAnnData ? Object.entries(existingAnnData) : [];
    const annEntry = existingAnn.find(([, a]) => a && a.calendar_event_id === uid);
    if (annEntry) {
      const [annKey, ann] = annEntry;
      const allNames = [...knownAttendees, ...guestNames];
      await fbPatch('announcements', {
        [annKey]: {
          ...ann,
          text: `📅 ${title}${timeRange ? ` — ${timeRange}` : ''}${brand ? ` · ${brand}` : ''} · ${allNames.join(', ')} (rescheduled)`,
          timestamp: new Date().toISOString(),
          visibleTo: knownAttendees
        }
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, tasksUpdated })
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
