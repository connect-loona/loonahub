// ============================================================================
// LOONA Hub · Leave request email notifier (Netlify Function)
// ----------------------------------------------------------------------------
// Fired by index.html right after a leave request is written to Firebase
// (see submitLeaveRequest() there) — best-effort, fire-and-forget: the leave
// request itself has already succeeded in Firebase by the time this runs, so
// a failure here (network hiccup, Gmail scope not yet authorized, etc.) must
// never surface as an error to the person submitting the request, and never
// blocks or delays their submission.
//
// Sends via the Gmail API, impersonating g@loona.in through the SAME Google
// service account already used for Calendar sync (calendar-sync.js/
// calendar-create.js/calendar-update.js) — domain-wide delegation, no new
// credential to create.
//
// ONE-TIME SETUP required beyond what Calendar sync already has: in Google
// Workspace Admin -> Security -> Access and data control -> API controls ->
// Domain-wide Delegation, find this same service account's Client ID (the
// one already authorized for the Calendar scope) and ADD this scope to its
// existing entry:
//   https://www.googleapis.com/auth/gmail.send
// Until that scope is added, every send attempt here will fail with an
// "unauthorized_client" / insufficient-scope error — logged, swallowed,
// never surfaced to the submitter.
//
// Env vars: GOOGLE_CALENDAR_SERVICE_ACCOUNT (already set).
//
// Manual test: POST /.netlify/functions/notify-leave-request
//   { "member": "Nishant", "from_date": "2026-09-10", "to_date": "2026-09-12",
//     "leave_type": "standard", "reason": "Family function",
//     "effective_days": 3, "requires_management_approval": false }
// ============================================================================

const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
// Impersonated mailbox — must be a real, existing address in the Workspace
// domain the service account has delegation over (it is: this is Gokul's
// own address). Recipients are separate from the sender — the same service
// account's delegation lets it send AS g@loona.in TO anyone, itself included.
const SENDER = 'g@loona.in';
const RECIPIENTS = ['g@loona.in', 'accounts@loona.in'];

const LEAVE_TYPE_LABEL = { standard: 'Standard Leave', sick: 'Sick Leave', wfh: 'Work From Home', other: 'Other' };

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJWT(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return signingInput + '.' + base64url(signature);
}
// Same domain-wide-delegation JWT Bearer flow as calendar-sync.js's own
// getAccessToken() — "sub" is what impersonates SENDER without them ever
// granting consent themselves, since a Workspace admin authorized this
// service account for the whole domain up front (see setup note above).
async function getAccessToken(sa, sub) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJWT({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now, sub }, sa.private_key);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`Gmail auth failed: ${JSON.stringify(data).slice(0, 300)}`);
  return data.access_token;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(ds) {
  if (!ds) return '—';
  const d = new Date(ds + 'T00:00:00');
  if (isNaN(d)) return ds;
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// Pure — takes the same leave-request object shape submitLeaveRequest()
// builds (member/from_date/to_date/reason/leave_type/effective_days/
// probation/notice_shortfall/sandwich_days) and produces the email subject
// + HTML body. Split out from the handler so it's directly unit-testable
// without touching the network.
function buildEmail(req) {
  const sameDay = req.from_date === req.to_date;
  const dateRange = fmtDate(req.from_date) + (sameDay ? '' : ' – ' + fmtDate(req.to_date));
  const typeLabel = LEAVE_TYPE_LABEL[req.leave_type] || req.leave_type || 'Leave';
  const days = req.effective_days;
  const flags = [];
  if (req.probation) flags.push('on probation');
  if (req.notice_shortfall) flags.push('short notice');
  if (req.sandwich_days) flags.push(req.sandwich_days + ' sandwich day' + (req.sandwich_days === 1 ? '' : 's'));
  const flagLine = flags.length
    ? `<p style="color:#b33a3a;font-weight:600;margin:14px 0 0">&#9888; ${escapeHtml(flags.join(' · '))} — requires your direct approval.</p>`
    : '';
  const subject = `Leave request: ${req.member} · ${dateRange}`;
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">'
    + `<h2 style="margin:0 0 12px">New leave request — ${escapeHtml(req.member)}</h2>`
    + '<table style="border-collapse:collapse">'
    + `<tr><td style="padding:4px 12px 4px 0;color:#666">Type</td><td>${escapeHtml(typeLabel)}</td></tr>`
    + `<tr><td style="padding:4px 12px 4px 0;color:#666">Dates</td><td>${escapeHtml(dateRange)}${days != null ? ' (' + days + ' day' + (days === 1 ? '' : 's') + ')' : ''}</td></tr>`
    + `<tr><td style="padding:4px 12px 4px 0;color:#666">Reason</td><td>${escapeHtml(req.reason || '—')}</td></tr>`
    + '</table>'
    + flagLine
    + '<p style="margin-top:18px"><a href="https://flag.loona.in" style="background:#ff5a1f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Review on Loona Hub</a></p>'
    + '</div>';
  return { subject, html };
}

// Raw RFC 2822 message, base64url-encoded exactly as Gmail's
// users.messages.send expects in its "raw" field. Subject is
// RFC 2047-encoded (=?UTF-8?B?...?=) since it can contain non-ASCII names.
function buildRawMessage({ from, to, subject, html }) {
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html
  ];
  return base64url(Buffer.from(lines.join('\r\n'), 'utf8'));
}

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };
  try {
    const saRaw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
    if (!saRaw) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT not set');
    let sa;
    try { sa = JSON.parse(saRaw); } catch (e) { throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON'); }
    if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key');

    let req;
    try { req = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, message: 'Invalid JSON body' }) }; }
    if (!req.member || !req.from_date) return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, message: 'Missing member/from_date' }) };

    const accessToken = await getAccessToken(sa, SENDER);
    const { subject, html } = buildEmail(req);
    const raw = buildRawMessage({ from: SENDER, to: RECIPIENTS, subject, html });

    const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Gmail send failed: ${resp.status} ${JSON.stringify(data).slice(0, 300)}`);

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, id: data.id }) };
  } catch (err) {
    console.error('notify-leave-request FAILED:', err && err.stack ? err.stack : err);
    return { statusCode: 502, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};

// Exported for tests only.
exports._internal = { buildEmail, buildRawMessage, escapeHtml, fmtDate, SENDER, RECIPIENTS };
