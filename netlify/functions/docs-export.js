// ============================================================================
// LOONA Hub · Export a meeting note's client-safe summary as a Google Doc
// ----------------------------------------------------------------------------
// Most client conversations happen over WhatsApp, not Gmail — so instead of
// building any kind of email integration, this turns the client-safe summary
// Loona Notes already generates into a real Google Doc with a public,
// link-shareable URL, which gets pasted into WhatsApp same as any other link.
//
// Uses the same domain-wide delegation service account calendar-sync.js
// reads with, impersonating the requester so the Doc is created in (and owned
// by) their own Drive — not an anonymous service account's.
//
// IMPORTANT: needs two more scopes authorized for this service account's
// Client ID in Workspace Admin (Security > API Controls > Domain-wide
// Delegation), alongside the existing calendar ones:
//   https://www.googleapis.com/auth/documents      (create/write the Doc)
//   https://www.googleapis.com/auth/drive.file     (set link-sharing on it —
//     scoped only to files this app itself creates, not full Drive access)
//
// POST body: { requesterName, title, brand, date, clientSafeSummary,
//   decisions: [strings], actionItems: [{task, assignee, dueDate}] }
// ============================================================================

const crypto = require('crypto');

const FB = (process.env.FIREBASE_DB_URL || 'https://loona-hub-c85d7-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file'
].join(' ');

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
    scope: SCOPES,
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

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Builds the Docs API batchUpdate requests to lay out the doc — plain
// paragraphs with bold section headers, inserted back-to-front since each
// insertText shifts every index after it (Docs API's documented approach).
function buildDocRequests({ title, brand, date, clientSafeSummary, decisions, actionItems }) {
  const blocks = []; // { text, bold }
  blocks.push({ text: title || 'Meeting Summary', bold: true, size: 18 });
  const metaParts = [fmtDate(date)].filter(Boolean);
  if (brand) metaParts.push(brand);
  if (metaParts.length) blocks.push({ text: metaParts.join(' · '), muted: true });
  blocks.push({ text: '' });
  blocks.push({ text: 'Summary', bold: true });
  blocks.push({ text: clientSafeSummary || '—' });
  if ((decisions || []).length) {
    blocks.push({ text: '' });
    blocks.push({ text: 'Decisions', bold: true });
    decisions.forEach(d => blocks.push({ text: '• ' + d }));
  }
  if ((actionItems || []).length) {
    blocks.push({ text: '' });
    blocks.push({ text: 'Next Steps', bold: true });
    actionItems.forEach(a => {
      const bits = [a.task];
      if (a.assignee) bits.push('— ' + a.assignee);
      if (a.dueDate) bits.push('(by ' + fmtDate(a.dueDate) + ')');
      blocks.push({ text: '• ' + bits.join(' ') });
    });
  }

  // Full plain text, in order, so we know each block's start/end index up front.
  let cursor = 1; // Docs bodies start at index 1
  const withRanges = blocks.map(b => {
    const text = b.text + '\n';
    const start = cursor;
    cursor += text.length;
    return { ...b, text, start, end: cursor };
  });
  const fullText = withRanges.map(b => b.text).join('');

  const requests = [{ insertText: { location: { index: 1 }, text: fullText } }];
  withRanges.forEach(b => {
    if (b.bold) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: b.start, endIndex: b.end - 1 },
          textStyle: { bold: true, fontSize: { magnitude: b.size || 12, unit: 'PT' } },
          fields: 'bold,fontSize'
        }
      });
    } else if (b.muted) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: b.start, endIndex: b.end - 1 },
          textStyle: { foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } } },
          fields: 'foregroundColor'
        }
      });
    }
  });
  return requests;
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
    const { requesterName, title, brand, date, clientSafeSummary, decisions, actionItems } = body;
    if (!requesterName || !title || !clientSafeSummary) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Missing required fields (requesterName, title, clientSafeSummary)' }) };
    }

    const membersData = await fbGet('members');
    const members = Object.values(membersData || {}).filter(m => m && m.name);
    const requester = members.find(m => String(m.name).toLowerCase() === String(requesterName).toLowerCase());
    if (!requester) throw new Error(`"${requesterName}" not found in the team roster`);
    const requesterEmail = deriveEmail(requester);

    const accessToken = await getAccessToken(requesterEmail, sa);

    const docTitle = `${title} — Client Summary`;
    const createResp = await fetch('https://docs.googleapis.com/v1/documents', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: docTitle })
    });
    const doc = await createResp.json().catch(() => ({}));
    if (!createResp.ok) throw new Error(`Docs API (create) ${createResp.status}: ${JSON.stringify(doc).slice(0, 300)}`);
    const documentId = doc.documentId;

    const requests = buildDocRequests({ title, brand, date, clientSafeSummary, decisions, actionItems });
    const updateResp = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests })
    });
    if (!updateResp.ok) {
      const errData = await updateResp.json().catch(() => ({}));
      throw new Error(`Docs API (content) ${updateResp.status}: ${JSON.stringify(errData).slice(0, 300)}`);
    }

    // "anyone with the link can view" — clients aren't in the Workspace domain, so
    // there's no internal account to grant access to instead.
    const permResp = await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}/permissions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });
    if (!permResp.ok) {
      const errData = await permResp.json().catch(() => ({}));
      throw new Error(`Drive API (sharing) ${permResp.status}: ${JSON.stringify(errData).slice(0, 300)}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, url: `https://docs.google.com/document/d/${documentId}/edit`, documentId })
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
