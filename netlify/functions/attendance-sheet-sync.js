// ============================================================================
// LOONA Hub · Firebase → Google Sheets ATTENDANCE sync ("Attendance Master
// Loona")
// ----------------------------------------------------------------------------
// Companion to employee-sheet-sync.js (which fills "Loona Hub Master"'s
// employee-directory tab), targeting a SEPARATE spreadsheet:
//   - "Master Details" tab: one row per employee, with a repeating block of
//     columns per month (Present/Late/Half Day/Absent/Leave Taken/Hours
//     Worked) for every month that has real punch data.
//   - One tab PER MONTH (e.g. "August 2026"): a full daily row for every
//     employee x every calendar day that month — punch in/out, hours
//     worked, break time, status, leave taken, and that day's late-arrival
//     fine if the day's lateness actually triggered one.
//
// This re-derives the SAME day-by-day status/fine logic the live dashboard
// computes client-side in index.html (see applyLiveRecords()/dayRecord()/
// splitPeriodFine() there) — there's no server-stored "status" field to
// just read, only raw punches in /loona_attendance. Kept deliberately
// scoped for this first pass: late-arrival fines are attributed per day
// (see attributeLateFines() below), but Half Day/short-hours-absence fines
// and forgiveness for those two are NOT — only late-forgiveness
// (/loona_late_forgiven) is applied, since that's what was asked for.
// Leave Taken is a plain yes/no per day (backed by /loona_excused, the
// same PERF_EXC source of truth used everywhere else), not broken down by
// Standard/Sick/WFH/Manual — see "Loona Hub Master"'s own admin panel for
// that level of detail.
//
// Full rewrite of every tab's data range each run (same reasoning as
// employee-sheet-sync.js) — a tab for a month that's fully closed out
// doesn't change once written, but the CURRENT month's tab does every run,
// and a forgiven late day retroactively clearing a fine needs a full
// rewrite to actually disappear.
//
// Required env vars (Netlify -> Site settings -> Environment variables):
//   GOOGLE_CALENDAR_SERVICE_ACCOUNT   (already set — same Sheets write
//                                      credential as employee-sheet-sync.js)
//   GOOGLE_ATTENDANCE_SHEET_ID        (the target spreadsheet's ID — same
//                                      one-time setup as
//                                      GOOGLE_EMPLOYEE_SHEET_ID, just a
//                                      different spreadsheet: share it with
//                                      the service account's client_email
//                                      as Editor, then set its ID here.)
//   FIREBASE_DB_URL                   (optional; same default as elsewhere)
//
// Manual run (for testing): GET /.netlify/functions/attendance-sheet-sync
// ============================================================================

const crypto = require('crypto');

const FB = (process.env.FIREBASE_DB_URL || 'https://loona-hub-c85d7-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MASTER_TAB = 'Master Details';

// ---- Ported attendance-policy constants (see index.html's own copies —
// keep these two files in step by hand if the policy ever changes again). ----
const POLICY_CUTOVER_DATE = '2026-08-29', OLD_GRACE_MIN = 10 * 60 + 30, GRACE_MIN = 10 * 60 + 10;
const REQ_WD = 7, REQ_SAT = 5; // required hours
const LATE_FEE = 200, LATE_FREE_DAYS = 4;
const OFFICIAL_HOLIDAYS = [
  { date: '2026-03-19', name: 'Gudi Padwa' },
  { date: '2026-03-21', name: 'Ramzan Eid*' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-01', name: 'Maharashtra Day' },
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-08-28', name: 'Raksha Bandhan' },
  { date: '2026-09-14', name: 'Ganesh Chaturthi' },
  { date: '2026-10-20', name: 'Dussehra' },
  { date: '2026-11-08', name: 'Diwali (Laxmi Pujan)' },
  { date: '2026-11-09', name: 'Diwali Day 2' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-26', name: 'Republic Day' },
  { date: '2027-03-24', name: 'Holi (2nd Day Rangpanchami)' },
  { date: '2027-04-08', name: 'Gudhi Padwa' },
  { date: '2027-04-09', name: 'Ramzan Eid*' }
];

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
  const jwt = signJWT({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now }, sa.private_key);
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
async function sheetsRequest(path, accessToken, init) {
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', ...(init && init.headers) }
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Sheets API ${path} failed: ${resp.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}
async function ensureTabsExist(sheetId, accessToken, wantedTitles) {
  const meta = await sheetsRequest(`${sheetId}?fields=sheets.properties.title`, accessToken);
  const existing = new Set((meta.sheets || []).map(s => s.properties.title));
  const missing = wantedTitles.filter(t => !existing.has(t));
  if (!missing.length) return;
  await sheetsRequest(`${sheetId}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ requests: missing.map(title => ({ addSheet: { properties: { title } } })) })
  });
}
async function writeTab(sheetId, accessToken, tabName, values) {
  await sheetsRequest(`${sheetId}/values/${encodeURIComponent(tabName)}!A1:AZ5000:clear`, accessToken, { method: 'POST', body: '{}' });
  await sheetsRequest(`${sheetId}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values })
  });
}
function fmtIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' IST';
}

// ---- Pure date/status helpers (ported from index.html) ----
function isSat(ds) { return new Date(ds + 'T00:00:00').getDay() === 6; }
function isSun(ds) { return new Date(ds + 'T00:00:00').getDay() === 0; }
function reqMinFor(ds) { return (isSat(ds) ? REQ_SAT : REQ_WD) * 60; }
function graceMinFor(ds) { return ds < POLICY_CUTOVER_DATE ? OLD_GRACE_MIN : GRACE_MIN; }
function minToClock(min) { if (min == null) return '—'; const h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am', h12 = ((h + 11) % 12) + 1; return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap; }
function minToHrs(min) { if (min == null) return '—'; const h = Math.floor(min / 60), m = min % 60; return String(h).padStart(2, '0') + 'h ' + String(m).padStart(2, '0') + 'm'; }
function moLabel(mo) { return new Date(mo + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); }
function daysInMonth(mo) { const [y, m] = mo.split('-').map(Number); const out = []; const last = new Date(y, m, 0).getDate(); for (let d = 1; d <= last; d++) out.push(mo + '-' + String(d).padStart(2, '0')); return out; }

function isHolidayFactory(liveHolidays) {
  return function (ds) {
    for (const h of OFFICIAL_HOLIDAYS) if (h.date === ds) return h.name;
    for (const h of liveHolidays) if (h.date === ds) return h.name || 'Holiday';
    return null;
  };
}

// Same priority order as dayRecordRaw()/dayRecord() in index.html: holiday
// > weekoff (Sunday) > no punch at all -> absent (or Leave if excused) >
// under-half-hours -> absent > late arrival -> late (status only; the fee
// is a separate, month-aware pass — see attributeLateFines()) > under full
// hours but past half -> half day > present.
function computeDayStatus(rec, ds, isHolidayFn, excused) {
  const holName = isHolidayFn(ds);
  if (holName) return { status: 'holiday', label: holName };
  if (isSun(ds)) return { status: 'weekoff' };
  if (!rec || rec.i == null) {
    return excused ? { status: 'leave' } : { status: 'absent' };
  }
  const reqMin = reqMinFor(ds), halfMin = reqMin / 2;
  const lateDay = rec.i > graceMinFor(ds);
  const worked = rec.w || 0;
  if (worked < halfMin) return { status: 'absent' };
  if (lateDay) return { status: 'late' };
  if (worked < reqMin) return { status: 'half' };
  return { status: 'present' };
}

// Walks one employee's late (and un-forgiven) days for a month in
// chronological order, replicating splitPeriodFine()'s exact math
// (index.html) but attributing the ₹200 to the SPECIFIC occurrence that
// triggers it, instead of just a month total:
//  - Old-period (pre-cutover) dates use the old block formula
//    (floor(n/3)*FEE) — a charge lands on every 3rd occurrence.
//  - New-period dates get the shared LATE_FREE_DAYS allowance, reduced by
//    however many old-period occurrences already used it up — every
//    occurrence past that remaining allowance is charged individually.
function attributeLateFines(sortedLateDatesAsc) {
  const oldDates = sortedLateDatesAsc.filter(d => d < POLICY_CUTOVER_DATE);
  const newDates = sortedLateDatesAsc.filter(d => d >= POLICY_CUTOVER_DATE);
  const fineByDate = {};
  oldDates.forEach((d, i) => { if ((i + 1) % 3 === 0) fineByDate[d] = LATE_FEE; });
  const remainingFree = Math.max(0, LATE_FREE_DAYS - oldDates.length);
  newDates.forEach((d, i) => { if (i + 1 > remainingFree) fineByDate[d] = LATE_FEE; });
  return fineByDate;
}

async function runSync() {
  const saRaw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT not set');
  let sa;
  try { sa = JSON.parse(saRaw); } catch (e) { throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key');

  const sheetId = process.env.GOOGLE_ATTENDANCE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_ATTENDANCE_SHEET_ID not set');

  const [membersRaw, inactiveRaw, attendanceRaw, excusedRaw, holidaysRaw, lateFgvRaw] = await Promise.all([
    fbGet('members'), fbGet('inactive_members'), fbGet('loona_attendance'), fbGet('loona_excused'), fbGet('loona_holidays'), fbGet('loona_late_forgiven')
  ]);

  const members = membersRaw || {};
  const inactiveNames = new Set(Array.isArray(inactiveRaw) ? inactiveRaw : Object.values(inactiveRaw || {}));
  const liveHolidays = Object.values(holidaysRaw || {}).filter(h => h && h.date);
  const isHolidayFn = isHolidayFactory(liveHolidays);
  const excused = excusedRaw || {}; // { name: { date: true } }
  const lateFgv = lateFgvRaw || {}; // { name: { date: true } }

  // /loona_attendance is keyed by date -> employeeCode -> {n,i,o,w,b}. Flip
  // it into name -> date -> rec so it's indexed the same way excused/lateFgv
  // already are, and collect which months actually have real data.
  const byNameDate = {};
  const monthsWithData = new Set();
  Object.keys(attendanceRaw || {}).forEach(ds => {
    monthsWithData.add(ds.slice(0, 7));
    const day = attendanceRaw[ds] || {};
    Object.keys(day).forEach(code => {
      const r = day[code] || {};
      const nm = r.n; if (!nm) return;
      byNameDate[nm] = byNameDate[nm] || {};
      byNameDate[nm][ds] = { i: r.i == null ? null : r.i, o: r.o == null ? null : r.o, w: r.w || 0, b: r.b || 0 };
    });
  });
  const months = Array.from(monthsWithData).sort();

  const empKeys = Object.keys(members).filter(k => members[k] && members[k].name);
  empKeys.sort((a, b) => String(members[a].name).localeCompare(String(members[b].name)));

  // ---- Per-month daily tabs ----
  const dailyHeaders = ['Date', 'Day', 'Employee Name', 'Employee Code', 'Punch In', 'Punch Out', 'Hours Worked', 'Break Time', 'Status', 'Leave Taken', 'Late Fine (₹)'];
  const monthSummaries = {}; // mo -> { [name]: {present,late,half,absent,leave,workedMin} }
  const dailyTabWrites = [];

  months.forEach(mo => {
    const rows = [];
    monthSummaries[mo] = {};
    empKeys.forEach(k => {
      const m = members[k];
      const name = m.name;
      const joinDate = m.joinDate;
      monthSummaries[mo][name] = { present: 0, late: 0, half: 0, absent: 0, leave: 0, workedMin: 0 };
      const empLateDates = [];
      daysInMonth(mo).forEach(ds => {
        if (joinDate && ds < joinDate) return; // not employed yet
        const rec = (byNameDate[name] || {})[ds];
        const isExcused = !!(excused[name] && excused[name][ds]);
        const info = computeDayStatus(rec, ds, isHolidayFn, isExcused);
        if (info.status === 'late') empLateDates.push(ds);

        const s = monthSummaries[mo][name];
        if (info.status === 'late') { s.present++; s.late++; }
        else if (info.status === 'present') s.present++;
        else if (info.status === 'half') s.half++;
        else if (info.status === 'absent') s.absent++;
        else if (info.status === 'leave') s.leave++;
        if (rec && rec.w) s.workedMin += rec.w;

        rows.push({ ds, name, code: m.employeeId || '—', rec, status: info.status });
      });
      // Late-fine attribution needs the WHOLE month's late dates for this
      // employee up front (see attributeLateFines()), so it's computed
      // after the day loop above, then merged into that employee's rows.
      const forgiven = new Set(Object.keys((lateFgv[name] || {})).filter(d => lateFgv[name][d]));
      const fineByDate = attributeLateFines(empLateDates.filter(d => !forgiven.has(d)));
      rows.forEach(r => { if (r.name === name) r._fine = fineByDate[r.ds] || 0; });
    });

    const STATUS_LABEL = { holiday: 'Holiday', weekoff: 'Week Off', absent: 'Absent', late: 'Late', half: 'Half Day', present: 'Present', leave: 'On Leave' };
    const values = [dailyHeaders, ...rows.map(r => [
      r.ds, new Date(r.ds + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }), r.name, r.code,
      r.rec ? minToClock(r.rec.i) : '—', r.rec ? minToClock(r.rec.o) : '—',
      r.rec ? minToHrs(r.rec.w) : '—', r.rec ? minToHrs(r.rec.b) : '—',
      STATUS_LABEL[r.status] || r.status,
      r.status === 'leave' ? 'Yes' : 'No',
      r._fine ? r._fine : '—'
    ])];
    dailyTabWrites.push({ tabName: moLabel(mo), values });
  });

  // ---- Master Details tab: one row per employee, months as repeating column blocks ----
  const masterHeaders = ['Name', 'Employee Code', 'Start Date', 'Employment Status', 'Probation Status'];
  months.forEach(mo => {
    const lbl = moLabel(mo);
    masterHeaders.push(lbl + ' - Present', lbl + ' - Late', lbl + ' - Half Day', lbl + ' - Absent', lbl + ' - Leave Taken', lbl + ' - Hours Worked');
  });
  const PROBATION_LABEL = { on_probation: 'On Probation', confirmed: 'Confirmed' };
  const masterRows = empKeys.map(k => {
    const m = members[k];
    const row = [m.name, m.employeeId || '—', m.joinDate || '—', inactiveNames.has(m.name) ? 'Inactive' : 'Active', PROBATION_LABEL[m.probationStatus] || '—'];
    months.forEach(mo => {
      const s = (monthSummaries[mo] || {})[m.name] || { present: 0, late: 0, half: 0, absent: 0, leave: 0, workedMin: 0 };
      row.push(s.present, s.late, s.half, s.absent, s.leave, minToHrs(s.workedMin));
    });
    return row;
  });

  const accessToken = await getAccessToken(sa, SHEETS_SCOPE);
  const allTabNames = [MASTER_TAB, ...dailyTabWrites.map(t => t.tabName)];
  await ensureTabsExist(sheetId, accessToken, allTabNames);

  await writeTab(sheetId, accessToken, MASTER_TAB, [masterHeaders, ...masterRows]);
  for (const t of dailyTabWrites) await writeTab(sheetId, accessToken, t.tabName, t.values);

  const noteRow = masterRows.length + 3;
  await sheetsRequest(`${sheetId}/values/${encodeURIComponent(MASTER_TAB)}!A${noteRow}?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: [[`Last synced: ${fmtIST()} · ${masterRows.length} employee(s) · ${months.length} month(s) of data`]] })
  });

  return { synced: masterRows.length, months: months.length, monthList: months };
}

exports.handler = async (event) => {
  try {
    const result = await runSync();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
