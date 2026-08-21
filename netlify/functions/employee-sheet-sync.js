// ============================================================================
// LOONA Hub · Firebase → Google Sheets employee directory sync
// ----------------------------------------------------------------------------
// Keeps one Google Sheet in step with whatever's actually live in Firebase's
// /members + /inactive_members — the same fields the Admin → Employee
// Directory editor writes (name, employeeId, role, department, joinDate,
// birthdate, workEmail), plus a computed Active/Inactive status. Runs on a
// schedule (see netlify.toml), the same pattern calendar-sync.js already
// uses for talking to Google — full rewrite of the sheet's data range each
// run, not an incremental patch, so a removed member simply stops appearing
// instead of needing to be diffed out.
//
// Reuses the SAME service account as calendar-sync.js/calendar-create.js
// (GOOGLE_CALENDAR_SERVICE_ACCOUNT) — no new credential to create. Unlike
// those two, this does NOT need domain-wide delegation/impersonation (no
// "sub" claim): Sheets access here is just the service account acting as
// itself, authorized the ordinary way by sharing the target spreadsheet with
// its own client_email as an Editor. See the setup note in netlify.toml.
//
// Required env vars (Netlify → Site settings → Environment variables):
//   GOOGLE_CALENDAR_SERVICE_ACCOUNT   (already set for calendar-sync.js)
//   GOOGLE_EMPLOYEE_SHEET_ID          (the target spreadsheet's ID — the long
//                                      id/ segment in its URL. That sheet
//                                      must be shared with the service
//                                      account's client_email as Editor.)
//   FIREBASE_DB_URL                   (optional; same default as elsewhere)
//
// Manual run (for testing): GET /.netlify/functions/employee-sheet-sync
// ============================================================================

const crypto = require('crypto');

const FB = (process.env.FIREBASE_DB_URL || 'https://loona-hub-c85d7-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEET_TAB = 'Employees';

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJWT(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return signingInput + '.' + base64url(signature);
}

// No "sub" here on purpose — this authenticates as the service account
// itself (direct-share access to one spreadsheet), not as an impersonated
// Workspace user, so it needs no domain-wide delegation setup at all.
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJWT({
    iss: sa.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }, sa.private_key);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

async function fbGet(path) {
  const resp = await fetch(FB + '/' + path + '.json');
  return resp.json().catch(() => null);
}

function fmtIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' IST';
}

async function sheetsRequest(path, accessToken, init) {
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', ...(init && init.headers) }
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Sheets API ${path} failed: ${resp.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Makes sure the target tab exists (a brand-new spreadsheet only has
// "Sheet1") — creates it once, quietly no-ops if it's already there.
async function ensureTabExists(sheetId, accessToken) {
  const meta = await sheetsRequest(`${sheetId}?fields=sheets.properties.title`, accessToken);
  const titles = (meta.sheets || []).map(s => s.properties.title);
  if (titles.includes(SHEET_TAB)) return;
  await sheetsRequest(`${sheetId}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] })
  });
}

async function runSync() {
  const saRaw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT not set');
  let sa;
  try { sa = JSON.parse(saRaw); } catch (e) { throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key');

  const sheetId = process.env.GOOGLE_EMPLOYEE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_EMPLOYEE_SHEET_ID not set');

  const [membersData, inactiveRaw] = await Promise.all([fbGet('members'), fbGet('inactive_members')]);
  const members = Object.values(membersData || {}).filter(m => m && m.name);
  const inactiveNames = new Set(
    Array.isArray(inactiveRaw) ? inactiveRaw : Object.values(inactiveRaw || {})
  );

  members.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const headers = ['Name', 'Employee Code', 'Designation', 'Department', 'Date Joined', 'Birthdate', 'Work Email', 'Status'];
  const rows = members.map(m => [
    m.name || '',
    m.employeeId || '—',
    m.role || '—',
    m.department || '—',
    m.joinDate || '—',
    m.birthdate || '—',
    m.workEmail || '—',
    inactiveNames.has(m.name) ? 'Inactive' : 'Active'
  ]);

  const accessToken = await getAccessToken(sa);
  await ensureTabExists(sheetId, accessToken);

  // Clear a generous range first — a straight overwrite would leave stale
  // trailing rows behind whenever the roster shrinks (someone removed, or a
  // duplicate cleaned up), same reasoning as the roster-filter fix on the
  // dashboard itself: absence has to actively clear old state, not just
  // rely on new state stopping short of it.
  await sheetsRequest(`${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!A1:Z1000:clear`, accessToken, { method: 'POST', body: '{}' });

  await sheetsRequest(`${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!A1?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers, ...rows] })
  });

  const noteRow = rows.length + 3;
  await sheetsRequest(`${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!A${noteRow}?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: [[`Last synced: ${fmtIST()} · ${rows.length} total (${rows.filter(r => r[7] === 'Active').length} active)`]] })
  });

  return { synced: rows.length, active: rows.filter(r => r[7] === 'Active').length, inactive: rows.filter(r => r[7] === 'Inactive').length };
}

exports.handler = async (event) => {
  try {
    const result = await runSync();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
