// ============================================================================
// LOONA Hub · Firebase → Google Sheets employee directory sync
// ----------------------------------------------------------------------------
// Keeps "Master Employee Data" in step with whatever's actually live in
// Firebase's /members + /inactive_members (the same fields the Admin →
// Employee Directory editor writes) plus /members_sensitive (PAN, Aadhar,
// bank details — see the auth section below for why that one needs a
// different credential). Runs on a schedule (see netlify.toml), the same
// pattern calendar-sync.js already uses for talking to Google — full
// rewrite of the sheet's data range each run, not an incremental patch, so
// a removed member simply stops appearing instead of needing to be diffed
// out.
//
// Reuses the SAME service account as calendar-sync.js/calendar-create.js
// (GOOGLE_CALENDAR_SERVICE_ACCOUNT) for the Sheets write side — no new
// credential to create for that part. Unlike those two, this does NOT need
// domain-wide delegation/impersonation for Sheets (no "sub" claim): access
// there is just the service account acting as itself, authorized the
// ordinary way by sharing the target spreadsheet with its own client_email
// as an Editor. See the setup note in netlify.toml.
//
// members_sensitive has a tighter Firebase security rule than the rest of
// the tree (see the comment at the members-backfill site in index.html) —
// an ordinary unauthenticated REST read (what /members and
// /inactive_members use below) gets denied there. Reading it needs a real
// Firebase Admin credential, which bypasses database rules entirely by
// design — that's a DIFFERENT, more powerful key than the Sheets one above,
// generated from Firebase Console -> Project Settings -> Service Accounts
// -> "Generate new private key". Sensitive columns are simply skipped
// (left as "—") if that credential isn't configured, so the rest of the
// sync still runs fine without it.
//
// Required env vars (Netlify -> Site settings -> Environment variables):
//   GOOGLE_CALENDAR_SERVICE_ACCOUNT   (already set for calendar-sync.js) —
//                                      used for the Sheets write.
//   GOOGLE_EMPLOYEE_SHEET_ID          (the target spreadsheet's ID — the long
//                                      id/ segment in its URL. That sheet
//                                      must be shared with the Sheets
//                                      service account's client_email as
//                                      Editor.)
//   FIREBASE_ADMIN_SERVICE_ACCOUNT    (optional — a Firebase Admin service
//                                      account JSON key for THIS project,
//                                      needed only to include PAN/Aadhar/
//                                      bank details. Omit to sync
//                                      everything else and leave those
//                                      columns blank.)
//   FIREBASE_DB_URL                   (optional; same default as elsewhere)
//
// Manual run (for testing): GET /.netlify/functions/employee-sheet-sync
// ============================================================================

const crypto = require('crypto');

const FB = (process.env.FIREBASE_DB_URL || 'https://loona-hub-c85d7-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const FIREBASE_ADMIN_SCOPE = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';
const SHEET_TAB = 'Master Employee Data';

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJWT(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return signingInput + '.' + base64url(signature);
}

async function getAccessToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJWT({
    iss: sa.client_email,
    scope,
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

// Unauthenticated reads for the parts of the tree that are already
// publicly readable by Firebase rules (matches the existing, already-
// working pattern for /members and /inactive_members).
async function fbGet(path) {
  const resp = await fetch(FB + '/' + path + '.json');
  return resp.json().catch(() => null);
}

// Authenticated (Admin-token) read for members_sensitive — a valid Google
// OAuth token for a service account Firebase recognizes as an Admin SDK
// identity on this project bypasses database rules entirely, which is the
// only way to reach a path this locked-down from a server context.
async function fbGetAdmin(path, adminToken) {
  const resp = await fetch(FB + '/' + path + '.json', { headers: { Authorization: 'Bearer ' + adminToken } });
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

// Mirrors index.html's fbMemberKey() exactly — members_sensitive is keyed
// by this, one entry per name (not duplicated the way /members can be), so
// looking it up needs the canonical key derived from the name, not
// whichever raw /members key happened to win the merge below.
function fbMemberKey(name) {
  return (name || '').replace(/[.#$/\[\]\s]/g, '_');
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

const PROBATION_LABEL = { on_probation: 'On Probation', confirmed: 'Confirmed' };

async function runSync() {
  const saRaw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT not set');
  let sa;
  try { sa = JSON.parse(saRaw); } catch (e) { throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key');

  // Trimmed defensively — a stray trailing newline/space from copy-pasting
  // the ID into Netlify's env var UI would otherwise silently 404 against
  // the Sheets API with no obvious clue why.
  const sheetId = (process.env.GOOGLE_EMPLOYEE_SHEET_ID || '').trim();
  if (!sheetId) throw new Error('GOOGLE_EMPLOYEE_SHEET_ID not set');
  console.log('employee-sheet-sync: using sheetId =', JSON.stringify(sheetId));

  const [membersData, inactiveRaw] = await Promise.all([fbGet('members'), fbGet('inactive_members')]);
  const members = membersData || {};
  const inactiveNames = new Set(
    Array.isArray(inactiveRaw) ? inactiveRaw : Object.values(inactiveRaw || {})
  );
  console.log('employee-sheet-sync: fetched', Object.keys(members).length, 'members,', inactiveNames.size, 'inactive');

  // Sensitive fields are opt-in — only attempted when a Firebase Admin
  // credential is actually configured, and any failure there degrades to
  // "not included" rather than failing the whole sync.
  let sensitiveData = {}, sensitiveSkippedReason = null;
  const adminSaRaw = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (adminSaRaw) {
    try {
      const adminSa = JSON.parse(adminSaRaw);
      const adminToken = await getAccessToken(adminSa, FIREBASE_ADMIN_SCOPE);
      sensitiveData = (await fbGetAdmin('members_sensitive', adminToken)) || {};
    } catch (e) {
      sensitiveSkippedReason = 'FIREBASE_ADMIN_SERVICE_ACCOUNT present but failed: ' + String((e && e.message) || e);
      console.error('employee-sheet-sync: sensitive-fields fetch failed (non-fatal):', e && e.stack ? e.stack : e);
      sensitiveData = {};
    }
  } else {
    sensitiveSkippedReason = 'FIREBASE_ADMIN_SERVICE_ACCOUNT not set — PAN/Aadhar/bank columns left blank';
  }

  // Firebase's /members tree can end up with more than one record for the
  // same person (e.g. re-added under a slightly different key at some
  // point) — collapse those down to ONE merged record per name before
  // anything else. This is a presentation-layer safety net for the sheet
  // only; it doesn't touch the underlying duplicate records in Firebase
  // itself, which are still worth cleaning up separately in the Admin
  // panel (scanAndMergeDuplicateMembers).
  //
  // Merges field-by-field using the exact same precedence index.html's own
  // 'members' listener uses to build what shows on a person's profile:
  // walk every duplicate in Firebase's own key order and let each
  // non-empty field overwrite the previous one, so whichever record was
  // written to LAST wins per field. That guarantees this sheet always
  // matches "the final info" on that person's own profile — not just
  // whichever single duplicate happens to have the most fields filled in
  // overall (a field updated on the OTHER duplicate after the "more
  // complete" one was created would otherwise get silently dropped).
  const allKeys = Object.keys(members).filter(k => members[k] && members[k].name);
  const mergedByName = {};
  allKeys.forEach(k => {
    const m = members[k];
    const merged = mergedByName[m.name] || {};
    Object.keys(m).forEach(f => { if (m[f] !== null && m[f] !== undefined && m[f] !== '') merged[f] = m[f]; });
    mergedByName[m.name] = merged;
  });
  const names = Object.keys(mergedByName);
  if (allKeys.length !== names.length) {
    console.log('employee-sheet-sync: collapsed', allKeys.length - names.length, 'duplicate member record(s) by name —',
      allKeys.length, 'raw records ->', names.length, 'unique people');
  }

  // Active employees first, Inactive ones grouped at the end; within each
  // group, ordered by Employee Code (missing codes sort last), with name
  // as the tiebreak when codes match or are both missing.
  names.sort((a, b) => {
    const ma = mergedByName[a], mb = mergedByName[b];
    const aInactive = inactiveNames.has(a) ? 1 : 0, bInactive = inactiveNames.has(b) ? 1 : 0;
    if (aInactive !== bInactive) return aInactive - bInactive;
    const aCode = ma.employeeId || '', bCode = mb.employeeId || '';
    if (!aCode && bCode) return 1;
    if (aCode && !bCode) return -1;
    if (aCode !== bCode) return aCode.localeCompare(bCode, undefined, { numeric: true });
    return String(a).localeCompare(String(b));
  });

  const headers = [
    'Name', 'Last Name', 'Employee Code', 'Designation', 'Department',
    'Date Joined', 'Birthdate', 'Gender', 'Blood Group',
    'Mobile', 'Personal Email', 'Work Email', 'Google Calendar Email', 'Address',
    'Emergency Contact Name', 'Emergency Contact Phone',
    'Employment Status', 'Probation Status', 'Probation Start Date',
    'PAN', 'Aadhar', 'Bank Account Holder Name', 'Bank Name', 'Bank Branch', 'Bank Account Number', 'Bank IFSC'
  ];
  const rows = names.map(name => {
    const m = mergedByName[name];
    const s = sensitiveData[fbMemberKey(name)] || {};
    return [
      m.name || name || '',
      m.lastName || '—',
      m.employeeId || '—',
      m.role || '—',
      m.department || '—',
      m.joinDate || '—',
      m.birthdate || '—',
      m.gender || '—',
      m.bloodGroup || '—',
      m.mobile || '—',
      m.personalEmail || '—',
      m.workEmail || '—',
      m.email || '—',
      m.address || '—',
      m.emergencyContactName || '—',
      m.emergencyContactPhone || '—',
      inactiveNames.has(name) ? 'Inactive' : 'Active',
      PROBATION_LABEL[m.probationStatus] || '—',
      m.probationStartDate || '—',
      s.pan || '—',
      s.aadhar || '—',
      s.bankAccountName || '—',
      s.bankName || '—',
      s.bankBranch || '—',
      s.bankAccount || '—',
      s.bankIFSC || '—'
    ];
  });

  const accessToken = await getAccessToken(sa, SHEETS_SCOPE);
  console.log('employee-sheet-sync: got Sheets access token, ensuring tab exists...');
  await ensureTabExists(sheetId, accessToken);
  console.log('employee-sheet-sync: tab ready, writing', rows.length, 'rows...');

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
  const activeCount = rows.filter(r => r[16] === 'Active').length;
  const noteText = `Last synced: ${fmtIST()} · ${rows.length} total (${activeCount} active)` + (sensitiveSkippedReason ? ` · ${sensitiveSkippedReason}` : '');
  await sheetsRequest(`${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!A${noteRow}?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: [[noteText]] })
  });

  return { synced: rows.length, active: activeCount, inactive: rows.length - activeCount, sensitiveIncluded: !sensitiveSkippedReason };
}

exports.handler = async (event) => {
  try {
    const result = await runSync();
    console.log('employee-sheet-sync OK:', JSON.stringify(result));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    // Logged explicitly — the HTTP response body alone isn't visible from
    // a mobile browser or a scheduled/cron invocation, only Netlify's
    // function log is, so the real failure reason needs to land here too.
    console.error('employee-sheet-sync FAILED:', err && err.stack ? err.stack : err);
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
