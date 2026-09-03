// ============================================================================
// LOONA Hub · Create a Google Calendar meeting (Netlify Function)
// ----------------------------------------------------------------------------
// Creates a real Google Calendar event (with an auto-generated Meet link) via
// the same domain-wide delegation service account calendar-sync.js reads
// with — impersonating the creator, so the event is organized by them (real
// invites land in each attendee's actual inbox), not an anonymous service
// account.
//
// IMPORTANT: calendar-sync.js only ever requested calendar.readonly. Writing
// events needs the broader https://www.googleapis.com/auth/calendar.events
// scope authorized for this same service account's Client ID in Workspace
// Admin (Security > API Controls > Domain-wide Delegation) — add it as an
// additional scope alongside the existing readonly one, don't replace it.
//
// POST body: { creatorName, title, date (YYYY-MM-DD), startTime (HH:MM),
//   endTime (HH:MM), attendees: [member names], guestEmails: [raw emails],
//   brand, description }
//
// Writes calendarEvents/tasks/announcements/ledger entries for this one event
// directly — same shape calendar-sync.js produces — instead of triggering a
// full team-roster sync and waiting for it. A full sync has to sequentially
// (well, now in parallel, but still) touch every member's calendar, so
// piggybacking event creation on that was the reason a just-created meeting
// took a while to show up on the Loona Board. The periodic calendar-sync
// still runs as the general safety net for meetings created directly in
// Google Calendar (not through Loona Hub), and its own dedup ledger means it
// won't double up on what this function already wrote.
// ============================================================================

const crypto = require('crypto');

const FB = (process.env.FIREBASE_DB_URL || 'https://loona-hub-c85d7-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// Only affects TEXT/labels below (the auto-created task, the Loona Board
// post, error messages) — the one place eventKind changes actual API
// behavior is the conferenceData block further down.
const KIND_LABEL = { meeting: 'Meeting', physical_meeting: 'Physical Meeting', shoot: 'Shoot' };
const KIND_EMOJI = { meeting: '📅', physical_meeting: '🤝', shoot: '🎬' };

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
// Callers were previously ignoring the response entirely — a rejected write
// (bad Firebase rule, malformed payload, etc.) looked identical to a
// successful one, so e.g. the Loona Board announcement could silently fail
// to write while the calendar event and per-attendee tasks went through fine,
// with nothing anywhere to say so. This logs the failure and lets the caller
// track it instead of it disappearing.
async function fbPatch(path, obj) {
  const resp = await fetch(FB + '/' + path + '.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(`Firebase PATCH ${path} failed (${resp.status}): ${errText.slice(0, 300)}`);
  }
  return resp;
}

// Firebase RTDB keys can't contain . # $ [ ] /
function fbSafeKey(s) {
  return String(s).replace(/[.#$[\]/]/g, '_');
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

// "priya.sharma+meet@clientco.com" -> "Priya" — just the first name, per the
// ask, not an attempt at reconstructing a full name from the local-part.
function deriveGuestFirstName(email) {
  const local = String(email).split('@')[0] || email;
  const first = local.split(/[._+-]+/)[0] || local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : email;
}

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
    const { creatorName, title, date, startTime, endTime, attendees, guestEmails, brand, description, location } = body;
    // "meeting" (default, unchanged behavior — video call, Meet link
    // auto-created), "physical_meeting" (outside the office), "shoot" — the
    // latter two skip conferenceData entirely (no Meet link makes sense for
    // something physical) and use the location field instead. See
    // KIND_TASK_PREFIX/KIND_EMOJI below for how this reflects downstream.
    const eventKind = ['meeting', 'physical_meeting', 'shoot'].includes(body.eventKind) ? body.eventKind : 'meeting';
    if (!creatorName || !title || !date || !startTime || !endTime) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Missing required fields (creatorName, title, date, startTime, endTime)' }) };
    }

    const membersData = await fbGet('members');
    const members = Object.values(membersData || {}).filter(m => m && m.name);
    const memberByName = {};
    members.forEach(m => { memberByName[String(m.name).toLowerCase()] = m; });

    const creator = memberByName[String(creatorName).toLowerCase()];
    if (!creator) throw new Error(`"${creatorName}" not found in the team roster`);
    const creatorEmail = deriveEmail(creator);

    const attendeeMembers = (attendees || [])
      .map(name => memberByName[String(name).toLowerCase()])
      .filter(Boolean);
    const attendeeEmails = attendeeMembers
      .map(deriveEmail)
      .filter(email => email.toLowerCase() !== creatorEmail.toLowerCase());

    const validGuestEmails = [...new Set((guestEmails || []).map(e => String(e).trim().toLowerCase()).filter(e => EMAIL_RE.test(e)))]
      .filter(e => e !== creatorEmail.toLowerCase() && !attendeeEmails.map(a => a.toLowerCase()).includes(e));

    const accessToken = await getAccessToken(creatorEmail, sa);

    const eventBody = {
      summary: title,
      description: description || '',
      start: { dateTime: `${date}T${startTime}:00`, timeZone: 'Asia/Kolkata' },
      end: { dateTime: `${date}T${endTime}:00`, timeZone: 'Asia/Kolkata' },
      attendees: [...attendeeEmails, ...validGuestEmails].map(email => ({ email }))
    };
    if (location) eventBody.location = location;
    // A Meet link only makes sense for an actual video call — a shoot or an
    // off-site physical meeting has nowhere to "join" virtually, so this is
    // the one thing that actually branches on eventKind at the Calendar-API
    // level (everything else below just changes text/labels).
    if (eventKind === 'meeting') {
      eventBody.conferenceData = {
        createRequest: {
          requestId: 'loonahub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      };
    }

    const resp = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody)
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Calendar API ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);

    // Same uid convention calendar-sync.js uses (iCalUID falling back to id) so a later
    // periodic sync recognizes this as the same event instead of writing a duplicate.
    const uid = data.iCalUID || data.id;
    const videoEntry = data.conferenceData && data.conferenceData.entryPoints && data.conferenceData.entryPoints.find(e => e.entryPointType === 'video');
    // Google can still be provisioning the Meet link at the moment insert() returns —
    // conferenceData.createRequest.status may say "pending" rather than "success". If so
    // this falls back to the calendar page link for now; the periodic sync will pick up
    // the finished Meet link on a later pass since this event isn't ledger-locked for
    // *that* — only the task/board creation is, the calendarEvents record itself still
    // gets refreshed by every sync run.
    const callLink = data.hangoutLink || (videoEntry && videoEntry.uri) || '';

    const knownAttendees = [...new Set([creatorName, ...attendeeMembers.map(m => m.name)])];
    const guestNames = validGuestEmails.map(deriveGuestFirstName);

    // Built directly from our own known input (already IST, since that's the only
    // timezone this form works in) rather than trusting data.start/data.end's exact
    // shape back from Google — safer than assuming the response always embeds an
    // explicit offset, and sidesteps any risk of double-converting the time.
    const calendarEventEntry = {
      uid,
      title: data.summary || title,
      start: `${date}T${startTime}:00+05:30`,
      end: `${date}T${endTime}:00+05:30`,
      attendeeCount: knownAttendees.length + guestNames.length,
      knownAttendees,
      guestNames,
      // The raw addresses, not just the derived display names — needed to pre-fill
      // (and keep inviting) guests when this meeting is later edited/rescheduled.
      guestEmails: validGuestEmails,
      brand: brand || '',
      eventKind,
      location: location || '',
      organizer: creatorName,
      organizerEmail: creatorEmail,
      googleEventId: data.id || '',
      callLink,
      htmlLink: data.htmlLink || '',
      updatedAt: Date.now()
    };
    const warnings = [];
    const calEventsResp = await fbPatch('calendarEvents', { [fbSafeKey(uid)]: calendarEventEntry });
    if (!calEventsResp.ok) warnings.push(`${KIND_LABEL[eventKind]} created on Google Calendar, but saving it into Loona Hub failed — it may not show up on the Calendar tab.`);

    // Per-attendee task — same is_auto/auto_calendar_event_id shape calendar-sync.js
    // uses, and logged in the same ledger so the periodic sync doesn't duplicate it.
    const startTimeLabel = fmtIST(calendarEventEntry.start);
    const endTimeLabel = fmtIST(calendarEventEntry.end);
    const timeRange = startTimeLabel ? (endTimeLabel && endTimeLabel !== startTimeLabel ? `${startTimeLabel} – ${endTimeLabel} IST` : `${startTimeLabel} IST`) : '';
    const taskText = `${KIND_LABEL[eventKind]}: ${calendarEventEntry.title}${location ? ` @ ${location}` : ''}${timeRange ? ` (${timeRange})` : ''}`;

    const taskLog = await fbGet('calendarSyncLog/tasks') || {};
    const newTasks = {};
    const taskLogUpdate = {};
    knownAttendees.forEach(name => {
      const sig = uid + '|' + name;
      const logKey = fbSafeKey(sig);
      if (taskLog[logKey]) return;
      const key = 'auto_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + '_' + fbSafeKey(name);
      newTasks[key] = {
        member: name,
        brand: brand || '',
        task: taskText,
        priority: 'Medium',
        status: 'Not Started',
        due_date: date,
        assigned_by: 'Google Calendar',
        is_auto: true,
        auto_calendar_event_id: uid,
        meeting_link: callLink || calendarEventEntry.htmlLink || '',
        created_at: new Date().toISOString()
      };
      taskLogUpdate[logKey] = true;
    });
    if (Object.keys(newTasks).length) await fbPatch('tasks', newTasks);
    if (Object.keys(taskLogUpdate).length) await fbPatch('calendarSyncLog/tasks', taskLogUpdate);

    // Loona Board post, scoped to the actual participants only.
    const annLog = await fbGet('calendarSyncLog/announcements') || {};
    const annLogKey = fbSafeKey(uid);
    if (!annLog[annLogKey]) {
      const allNames = [...knownAttendees, ...guestNames];
      const annKey = 'auto_ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
      const annResp = await fbPatch('announcements', {
        [annKey]: {
          id: Date.now(),
          text: `${KIND_EMOJI[eventKind]} ${calendarEventEntry.title}${timeRange ? ` — ${timeRange}` : ''}${brand ? ` · ${brand}` : ''}${location ? ` · ${location}` : ''} · ${allNames.join(', ')}`,
          links: (callLink || calendarEventEntry.htmlLink) ? [callLink || calendarEventEntry.htmlLink] : [],
          author: creatorName,
          emoji: '📅',
          timestamp: new Date().toISOString(),
          calendar_event_id: uid,
          visibleTo: knownAttendees
        }
      });
      if (!annResp.ok) warnings.push('Meeting created, but the Loona Board post failed to save — it won\'t show up there.');
      else await fbPatch('calendarSyncLog/announcements', { [annLogKey]: true });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, eventId: data.id, htmlLink: data.htmlLink || '', callLink, warnings })
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
