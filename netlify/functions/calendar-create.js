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
//   endTime (HH:MM), attendees: [member names], description }
//
// The created event isn't written into Firebase directly — the client
// triggers a calendar-sync run right after this succeeds, which picks it up
// through the normal read pipeline (same dedup/task/board logic as any other
// meeting).
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

function deriveEmail(member) {
  if (member.email) return member.email;
  return String(member.name || '').toLowerCase().replace(/\s+/g, '') + '@loona.in';
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
    const { creatorName, title, date, startTime, endTime, attendees, description } = body;
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

    const attendeeEmails = (attendees || [])
      .map(name => memberByName[String(name).toLowerCase()])
      .filter(Boolean)
      .map(deriveEmail)
      .filter(email => email.toLowerCase() !== creatorEmail.toLowerCase());

    const accessToken = await getAccessToken(creatorEmail, sa);

    const eventBody = {
      summary: title,
      description: description || '',
      start: { dateTime: `${date}T${startTime}:00`, timeZone: 'Asia/Kolkata' },
      end: { dateTime: `${date}T${endTime}:00`, timeZone: 'Asia/Kolkata' },
      attendees: attendeeEmails.map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: 'loonahub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    };

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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, eventId: data.id, htmlLink: data.htmlLink || '', callLink: data.hangoutLink || '' })
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
