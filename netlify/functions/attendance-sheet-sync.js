// ============================================================================
// LOONA Hub · Firebase → Google Sheets ATTENDANCE sync ("Attendance Master
// Loona")
// ----------------------------------------------------------------------------
// Companion to employee-sheet-sync.js (which fills "Loona Hub Master"'s
// employee-directory tab), targeting a SEPARATE spreadsheet. Renders Gokul's
// hand-designed dark-theme layout exactly (colors, fonts, column widths, row
// heights — see the "PALETTE"/"LAYOUT" constants below, ported 1:1 from the
// reference .xlsx he supplied) via the Sheets API's updateCells requests
// (values AND formatting together), not the plain values.update endpoint
// employee-sheet-sync.js uses — there's no way to get real cell coloring
// through that simpler endpoint.
//
//   - One tab PER MONTH (e.g. "August 2026"):
//       "MONTHLY PAYROLL SUMMARY" — one row per employee, aggregate counts
//       for the month plus fines/deductions.
//       "DETAILED MONTHLY ATTENDANCE" — one 22-row block per employee,
//       dates running across the columns: Status, Punch In/Out, Gross/Net/
//       Break/Required hours, Late By/Early Exit/Short Hours, Work Mode,
//       Leave Type/Duration, Paid or Unpaid, Approval Status/By, Late
//       Forgiven, Late/Other/Total Fine ₹, Remarks.
//   - "Yearly Summary" tab: one row per employee, JAN-DEC grouped
//     horizontally (Leave Taken/Unpaid Leave/Late Days/fines/deduction per
//     month), plus a Year Totals block and current leave balance.
//
// This re-derives the SAME day-by-day status/fine logic the live dashboard
// computes client-side in index.html (see applyLiveRecords()/dayRecord()/
// splitPeriodFine() there) — there's no server-stored "status" field to just
// read, only raw punches in /loona_attendance.
//
// Known, deliberate gaps (no real data to back these yet — shown as "—"
// rather than a fabricated value): Leave Duration (half vs full day), Paid/
// Unpaid classification and its per-day Unpaid Leave count, Approved By,
// Remarks, and any non-late ("Other") fine — none of index.html's fuller
// unpaid-leave/probation/notice-period logic is ported here. Flag to Gokul
// if any of these turn out to matter enough to port properly.
//
// Full rewrite of every tab's data range each run (same reasoning as
// employee-sheet-sync.js) — a forgiven late day retroactively clearing a
// fine needs a full rewrite to actually disappear, not just an append.
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
const YEARLY_TAB = 'Yearly Summary';

// ---- Ported attendance-policy constants (see index.html's own copies —
// keep these two files in step by hand if the policy ever changes again). ----
const POLICY_CUTOVER_DATE = '2026-08-29', OLD_GRACE_MIN = 10 * 60 + 30, GRACE_MIN = 10 * 60 + 10;
const REQ_WD = 7, REQ_SAT = 5; // required hours
const LATE_FEE = 200, LATE_FREE_DAYS = 4, TOTAL_LEAVE = 15;
// Nominal shift window used ONLY for the "Late By"/"Early Exit" display
// columns (how many minutes past/before a normal 10-7 shift someone
// punched) — a separate, purely informational figure from GRACE_MIN, which
// is what actually decides whether a day counts as "late" for fine
// purposes. Matches the reference layout's own example numbers.
const SHIFT_START_MIN = 10 * 60, SHIFT_END_MIN = 19 * 60;
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

// People this attendance policy simply doesn't apply to — the founder, and
// consultants who aren't tracked against punch-in/late/leave rules at all
// — left out of the sheet entirely (every tab: Yearly Summary and every
// month) rather than showing up as an all-blank/all-absent row. A short,
// hand-maintained list rather than a Firebase-backed flag for now — update
// it here if who counts as exempt ever changes.
const EXCLUDED_FROM_ATTENDANCE = ['Gokul', 'Ankita', 'Karnik', 'Hetal', 'Archisha'];

// ---- Dark-theme palette, ported 1:1 from Gokul's reference .xlsx ----
const PALETTE = {
  pageBg: '#121214', titleFg: '#F7F7F7', subtitleFg: '#B7B7BA', orange: '#FF5A1F',
  headerBg: '#211B18', monthGroupHeaderBg: '#252529',
  identityBg: '#18181B', countsBg: '#1A1A1E', moneyBg: '#241B17', amberFg: '#D6A45E',
  dateHeaderBg: '#16161A', noDataBg: '#16161A',
  group1Bg: '#151518', group2Bg: '#181615', group3Bg: '#171719',
  status: {
    present: '#20352A', late: '#20352A', wfh: '#1E293B', leave: '#36251A', weekoff: '#1B1B1F',
    // Not directly demonstrated in the reference file (its sample data
    // happened not to include these) — extended consistently from the same
    // dark palette family. Worth a look once live and worth tweaking on
    // feedback if they don't read well next to the others.
    half: '#332A18', absent: '#3A1F1F', holiday: '#241B36'
  }
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
}
// Builds one Sheets API CellData object — value + full formatting together
// (background, font, alignment, wrap, number format) — since that's the
// only way to get real cell coloring via updateCells.
function C(value, opts) {
  opts = opts || {};
  const format = {
    backgroundColor: hexToRgb(opts.bg || PALETTE.pageBg),
    textFormat: { foregroundColor: hexToRgb(opts.fg || PALETTE.titleFg), fontFamily: 'Carlito', fontSize: opts.size || 9, bold: !!opts.bold },
    horizontalAlignment: opts.align || 'CENTER',
    verticalAlignment: opts.valign || 'MIDDLE',
    wrapStrategy: opts.wrap ? 'WRAP' : 'OVERFLOW_CELL'
  };
  if (opts.numberFormat) format.numberFormat = opts.numberFormat;
  const cellData = { userEnteredFormat: format };
  if (value !== undefined && value !== null && value !== '') {
    cellData.userEnteredValue = typeof value === 'number' ? { numberValue: value } : { stringValue: String(value) };
  }
  return cellData;
}
function blankRow(width, bg) {
  const row = [];
  for (let i = 0; i < width; i++) row.push(C(null, { bg }));
  return row;
}
function padRow(cells, width, bg) {
  const out = cells.slice();
  while (out.length < width) out.push(C(null, { bg: bg || PALETTE.pageBg }));
  return out;
}
// A row whose text lives only in column A, with the given background
// spanning the FULL width — the title/section-header banner pattern used
// throughout the reference layout.
function bannerRow(text, bg, width, opts) {
  const row = [C(text, Object.assign({ bg, align: 'LEFT' }, opts))];
  for (let i = 1; i < width; i++) row.push(C(null, { bg }));
  return row;
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
function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJWT(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return signingInput + '.' + base64url(signature);
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
// Returns {title -> sheetId} for every tab that already exists, creating any
// of wantedTitles that's missing (batched into ONE addSheet call). Needed
// because updateCells requests address a tab by its numeric sheetId, not
// its title.
async function ensureTabsExist(sheetId, accessToken, wantedTitles) {
  const meta = await sheetsRequest(`${sheetId}?fields=sheets.properties.title,sheets.properties.sheetId`, accessToken);
  const byTitle = {};
  (meta.sheets || []).forEach(s => { byTitle[s.properties.title] = s.properties.sheetId; });
  const missing = wantedTitles.filter(t => !(t in byTitle));
  if (missing.length) {
    const res = await sheetsRequest(`${sheetId}:batchUpdate`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ requests: missing.map(title => ({ addSheet: { properties: { title } } })) })
    });
    (res.replies || []).forEach(r => { if (r.addSheet) byTitle[r.addSheet.properties.title] = r.addSheet.properties.sheetId; });
  }
  return byTitle;
}
function fmtIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' IST';
}

// ---- Pure date/status helpers (ported from index.html) ----
function isSat(ds) { return new Date(ds + 'T00:00:00').getDay() === 6; }
function isSun(ds) { return new Date(ds + 'T00:00:00').getDay() === 0; }
function reqMinFor(ds) { return (isSat(ds) ? REQ_SAT : REQ_WD) * 60; }
function graceMinFor(ds) { return ds < POLICY_CUTOVER_DATE ? OLD_GRACE_MIN : GRACE_MIN; }
function minToClock(min) { if (min == null) return '—'; const h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = ((h + 11) % 12) + 1; return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap; }
function minToHM(min) { if (min == null) return '—'; const sign = min < 0 ? '-' : ''; min = Math.abs(min); const h = Math.floor(min / 60), m = min % 60; return sign + h + ':' + String(m).padStart(2, '0'); }
function moLabel(mo) { return new Date(mo + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); }
function daysInMonth(mo) { const [y, m] = mo.split('-').map(Number); const out = []; const last = new Date(y, m, 0).getDate(); for (let d = 1; d <= last; d++) out.push(mo + '-' + String(d).padStart(2, '0')); return out; }
function rupee(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }

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
// triggers it, instead of just a month total.
function attributeLateFines(sortedLateDatesAsc) {
  const oldDates = sortedLateDatesAsc.filter(d => d < POLICY_CUTOVER_DATE);
  const newDates = sortedLateDatesAsc.filter(d => d >= POLICY_CUTOVER_DATE);
  const fineByDate = {};
  oldDates.forEach((d, i) => { if ((i + 1) % 3 === 0) fineByDate[d] = LATE_FEE; });
  const remainingFree = Math.max(0, LATE_FREE_DAYS - oldDates.length);
  newDates.forEach((d, i) => { if (i + 1 > remainingFree) fineByDate[d] = LATE_FEE; });
  return fineByDate;
}

// ---- Leave-balance accrual (ported from earnedLeaveAsOf()/fyStartDateFor()
// in index.html) — 15 days/year, accrued pro-rata at 1.25/month from the
// later of the financial-year start (April) or the join date. ----
function fyStartDateFor(dateObj) { const y = dateObj.getFullYear(); return new Date(dateObj.getMonth() >= 3 ? y : y - 1, 3, 1); }
function fullMonthsElapsed(start, end) { let m = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()); if (end.getDate() < start.getDate()) m--; return Math.max(0, m); }
function earnedLeaveAsOf(joinDate, dateStr) {
  const asOf = new Date(dateStr + 'T00:00:00');
  const fyS = fyStartDateFor(asOf), join = joinDate ? new Date(joinDate + 'T00:00:00') : fyS, effStart = join > fyS ? join : fyS;
  if (asOf <= effStart) return 0;
  return Math.min(TOTAL_LEAVE, Math.round(fullMonthsElapsed(effStart, asOf) * (TOTAL_LEAVE / 12) * 100) / 100);
}

const STATUS_LABEL = { holiday: 'Holiday', weekoff: 'WO', absent: 'Absent', late: 'P', half: 'Half', present: 'P', leave: 'Leave', wfh: 'Work From Home' };
const PROBATION_LABEL = { on_probation: 'On Probation', confirmed: 'Confirmed' };

async function runSync() {
  const saRaw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDER_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT not set');
  let sa;
  try { sa = JSON.parse(saRaw); } catch (e) { throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is missing client_email/private_key');

  const sheetId = (process.env.GOOGLE_ATTENDANCE_SHEET_ID || '').trim();
  if (!sheetId) throw new Error('GOOGLE_ATTENDANCE_SHEET_ID not set');
  console.log('attendance-sheet-sync: using sheetId =', JSON.stringify(sheetId));

  const [membersRaw, inactiveRaw, attendanceRaw, excusedRaw, holidaysRaw, lateFgvRaw, leaveReqRaw] = await Promise.all([
    fbGet('members'), fbGet('inactive_members'), fbGet('loona_attendance'), fbGet('loona_excused'), fbGet('loona_holidays'), fbGet('loona_late_forgiven'), fbGet('leave_requests')
  ]);
  console.log('attendance-sheet-sync: fetched', Object.keys(membersRaw || {}).length, 'members,',
    Object.keys(attendanceRaw || {}).length, 'dates of raw attendance data');

  const members = membersRaw || {};
  const inactiveNames = new Set(Array.isArray(inactiveRaw) ? inactiveRaw : Object.values(inactiveRaw || {}));
  const liveHolidays = Object.values(holidaysRaw || {}).filter(h => h && h.date);
  const isHolidayFn = isHolidayFactory(liveHolidays);
  const excused = excusedRaw || {}; // { name: { date: true } }
  const lateFgv = lateFgvRaw || {}; // { name: { date: true } }
  const leaveRequests = Object.values(leaveReqRaw || {}).filter(r => r && r.member);

  // /loona_attendance is keyed by date -> employeeCode -> {n,i,o,w,b}. Flip
  // it into employeeCode -> date -> rec, and collect which months actually
  // have real data. Deliberately keyed by CODE, not the 'n' (name) field
  // stored inside each record — index.html's own applyLiveRecords() never
  // trusts that inner field for identity either; it matches purely via
  // LIVE.empMap[emp_id] (built from each member's own employeeId). 'n' is
  // whatever name happened to be current when a punch was recorded and can
  // drift out of sync with someone's CURRENT profile (a rename, a fixed
  // typo) — matching by the day's own key instead is what actually stays
  // correct.
  const byCodeDate = {};
  const monthsWithData = new Set();
  Object.keys(attendanceRaw || {}).forEach(ds => {
    monthsWithData.add(ds.slice(0, 7));
    const day = attendanceRaw[ds] || {};
    Object.keys(day).forEach(code => {
      const r = day[code] || {};
      byCodeDate[code] = byCodeDate[code] || {};
      byCodeDate[code][ds] = { i: r.i == null ? null : r.i, o: r.o == null ? null : r.o, w: r.w || 0, b: r.b || 0 };
    });
  });
  const months = Array.from(monthsWithData).sort();
  console.log('attendance-sheet-sync: months with real punch data:', JSON.stringify(months));

  // Same field-by-field duplicate merge as employee-sheet-sync.js — last
  // non-empty value in Firebase key order wins, matching index.html's own
  // 'members' listener precedence, so this sheet agrees with the profile.
  const allKeys = Object.keys(members).filter(k => members[k] && members[k].name);
  const mergedByName = {};
  allKeys.forEach(k => {
    const m = members[k];
    const merged = mergedByName[m.name] || {};
    Object.keys(m).forEach(f => { if (m[f] !== null && m[f] !== undefined && m[f] !== '') merged[f] = m[f]; });
    mergedByName[m.name] = merged;
  });
  const names = Object.keys(mergedByName).filter(n => !EXCLUDED_FROM_ATTENDANCE.includes(n));
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

  // Every formal (leave_requests-backed) approved leave date, per name —
  // used for Leave Type/Approval Status in the detail tabs and for Leave
  // Taken/Current Leave Balance in the Yearly Summary.
  const formalLeaveByNameDate = {}; // name -> date -> leave_type
  leaveRequests.forEach(r => {
    if (r.status !== 'approved') return;
    let d = new Date(r.from_date + 'T00:00:00');
    const end = new Date(r.to_date + 'T00:00:00');
    while (d <= end) {
      const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      formalLeaveByNameDate[r.member] = formalLeaveByNameDate[r.member] || {};
      formalLeaveByNameDate[r.member][ds] = r.leave_type || 'standard';
      d.setDate(d.getDate() + 1);
    }
  });
  const LEAVE_TYPE_LABEL = { standard: 'Standard', sick: 'Sick', wfh: 'Work From Home', other: 'Other' };

  // An inactive member's data shouldn't keep getting "carried ahead" past
  // the day they actually left — every day after that would otherwise show
  // up as an indefinite string of Absent days, which is just noise. Ends
  // at whichever is set: an explicit m.lastWorkingDay override (for the
  // rare case punch data doesn't reflect the real last day — a stray
  // post-departure punch, or someone who left without ever punching out
  // cleanly), falling back to their own last real punch date otherwise.
  // Active members have no end date at all.
  const lastPunchDateByName = {};
  names.forEach(name => {
    const code = mergedByName[name].employeeId;
    if (!code || !byCodeDate[code]) return;
    const dates = Object.keys(byCodeDate[code]).sort();
    if (dates.length) lastPunchDateByName[name] = dates[dates.length - 1];
  });
  function effectiveEndDateFor(name) {
    if (!inactiveNames.has(name)) return null;
    const m = mergedByName[name];
    return m.lastWorkingDay || lastPunchDateByName[name] || null;
  }
  // Whether ANY day of month `mo` falls within name's employment window —
  // used by the Yearly Summary to tell "genuinely zero that month" apart
  // from "not employed that month at all" (shown as a dash, not a 0).
  function monthOverlapsEmployment(name, mo) {
    const m = mergedByName[name], endDate = effectiveEndDateFor(name);
    const monthDates = daysInMonth(mo);
    if (m.joinDate && m.joinDate > monthDates[monthDates.length - 1]) return false;
    if (endDate && endDate < monthDates[0]) return false;
    return true;
  }

  // ---- Per-day info for every name x every date across ALL months with
  // data — computed once, reused by both the per-month detail tabs and the
  // Yearly Summary's per-month aggregate columns. ----
  function computeMonth(mo) {
    const perName = {};
    names.forEach(name => {
      const m = mergedByName[name];
      const joinDate = m.joinDate;
      const endDate = effectiveEndDateFor(name);
      const days = [];
      const empLateDates = [];
      daysInMonth(mo).forEach(ds => {
        if (joinDate && ds < joinDate) { days.push({ ds, outsideEmployment: true }); return; }
        if (endDate && ds > endDate) { days.push({ ds, outsideEmployment: true }); return; }
        const rec = m.employeeId ? (byCodeDate[m.employeeId] || {})[ds] : undefined;
        const isExcused = !!(excused[name] && excused[name][ds]);
        const info = computeDayStatus(rec, ds, isHolidayFn, isExcused);
        if (info.status === 'late') empLateDates.push(ds);
        const formalType = (formalLeaveByNameDate[name] || {})[ds];
        // computeDayStatus() only knows "excused or not" — a WFH day is
        // recorded as an ordinary excusal too (approving a WFH leave
        // request sets loona_excused just like any other leave type), so
        // the only way to tell them apart is the leave_requests record's
        // own leave_type. A WFH day usually still has real punches (worked
        // from home, just still clocked in/out), so computeDayStatus would
        // otherwise call it a perfectly ordinary 'present'/'late'/'half'
        // day — recover the WFH tag here, downstream of the shared status
        // logic, for anything that isn't a holiday/weekoff/absence (an
        // approved-but-never-actually-worked WFH day stays 'absent').
        const status = (formalType === 'wfh' && ['present', 'late', 'half', 'leave'].includes(info.status)) ? 'wfh' : info.status;
        // isLate tracks the underlying lateness independently of the WFH
        // display override above — someone who worked from home late is
        // still late for fine/forgiveness purposes, even though the
        // Status column shows "Work From Home" rather than "P".
        days.push({ ds, rec, status, isLate: info.status === 'late', formalType });
      });
      const forgiven = new Set(Object.keys((lateFgv[name] || {})).filter(d => lateFgv[name][d]));
      const fineByDate = attributeLateFines(empLateDates.filter(d => !forgiven.has(d)));
      days.forEach(d => { d.lateFine = fineByDate[d.ds] || 0; d.lateForgiven = d.isLate && forgiven.has(d.ds); });

      const s = { present: 0, half: 0, wfh: 0, standard: 0, sick: 0, other: 0, absent: 0, late: 0, forgivenLate: 0, lateFine: 0, workedMin: 0, leaveTaken: 0 };
      days.forEach(d => {
        if (d.outsideEmployment) return;
        if (d.status === 'wfh') s.wfh++;
        else if (d.status === 'present' || d.status === 'late') s.present++;
        else if (d.status === 'half') s.half++;
        else if (d.status === 'absent') s.absent++;
        else if (d.status === 'leave') {
          s.leaveTaken++;
          const t = d.formalType || 'other';
          if (t === 'standard') s.standard++; else if (t === 'sick') s.sick++; else s.other++;
        }
        if (d.isLate) { s.late++; if (d.lateForgiven) s.forgivenLate++; s.lateFine += d.lateFine; }
        if (d.rec && d.rec.w) s.workedMin += d.rec.w;
      });
      perName[name] = { days, summary: s };
    });
    return perName;
  }

  // ============================================================
  // Per-month "MONTHLY PAYROLL SUMMARY" + "DETAILED MONTHLY ATTENDANCE" tabs
  // ============================================================
  const SUMMARY_HEADERS = [
    'Employee', 'Code', 'Department', 'Working Days', 'Present', 'Half Days', 'Work From Home',
    'Standard Leave', 'Sick Leave', 'Other Approved', 'Unpaid Leave', 'Absent', 'Late Days', 'Forgiven Late',
    'Late Fine ₹', 'Other Fine ₹', 'Total Fine ₹', 'Unpaid Leave Deduction ₹', 'Total Attendance Deduction ₹',
    'Leave Taken', 'Leave Balance'
  ];
  const DETAIL_ROWS = [
    'Status', 'Punch In', 'Punch Out', 'Gross Hours', 'Break Time', 'Net Hours', 'Required Hours',
    'Late By', 'Early Exit', 'Short Hours', 'Work Mode', 'Leave Type', 'Leave Duration', 'Paid / Unpaid',
    'Unpaid Leave', 'Approval Status', 'Approved By', 'Late Forgiven', 'Late Fine ₹', 'Other Fine ₹', 'Total Fine ₹', 'Remarks'
  ];
  // Row-group background per detail row (Status is special-cased per-status
  // below); amber font for the money/leave-count rows.
  const ROW_STYLE = {
    'Status': { bg: null, bold: true }, // per-status color, handled specially
    'Punch In': { bg: PALETTE.group1Bg }, 'Punch Out': { bg: PALETTE.group1Bg }, 'Gross Hours': { bg: PALETTE.group1Bg },
    'Break Time': { bg: PALETTE.group1Bg }, 'Net Hours': { bg: PALETTE.group1Bg }, 'Required Hours': { bg: PALETTE.group1Bg },
    'Late By': { bg: PALETTE.group2Bg }, 'Early Exit': { bg: PALETTE.group2Bg }, 'Short Hours': { bg: PALETTE.group2Bg },
    'Work Mode': { bg: PALETTE.group2Bg }, 'Leave Type': { bg: PALETTE.group2Bg }, 'Leave Duration': { bg: PALETTE.group2Bg },
    'Paid / Unpaid': { bg: PALETTE.group2Bg }, 'Unpaid Leave': { bg: PALETTE.group2Bg, fg: PALETTE.amberFg },
    'Approval Status': { bg: PALETTE.group3Bg }, 'Approved By': { bg: PALETTE.group3Bg }, 'Late Forgiven': { bg: PALETTE.group3Bg },
    'Late Fine ₹': { bg: PALETTE.group3Bg, fg: PALETTE.amberFg }, 'Other Fine ₹': { bg: PALETTE.group3Bg, fg: PALETTE.amberFg },
    'Total Fine ₹': { bg: PALETTE.group3Bg, fg: PALETTE.amberFg }, 'Remarks': { bg: PALETTE.group3Bg }
  };

  const monthTabs = []; // { tabName, W, grid }
  months.forEach(mo => {
    const perName = computeMonth(mo);
    const dates = daysInMonth(mo);
    const W = 2 + dates.length;
    const grid = [];

    grid.push(bannerRow('LOONA · MONTHLY ATTENDANCE', PALETTE.pageBg, W, { fg: PALETTE.titleFg, size: 17, bold: true, valign: 'MIDDLE' }));
    grid.push(bannerRow(moLabel(mo).toUpperCase() + ' · Auto-synced from Loona Hub', PALETTE.pageBg, W, { fg: PALETTE.subtitleFg, size: 10 }));
    grid.push(blankRow(W, PALETTE.pageBg));
    grid.push(bannerRow('MONTHLY PAYROLL SUMMARY', PALETTE.orange, W, { fg: PALETTE.titleFg, size: 11, bold: true }));

    const summaryHeaderRow = SUMMARY_HEADERS.map(h => C(h, { bg: PALETTE.headerBg, bold: true, size: 8, wrap: true }));
    grid.push(padRow(summaryHeaderRow, W));

    const empKeysForMonth = names.filter(name => {
      const m = mergedByName[name]; const endDate = effectiveEndDateFor(name);
      return (!m.joinDate || m.joinDate <= dates[dates.length - 1]) && (!endDate || endDate >= dates[0]);
    });
    empKeysForMonth.forEach(name => {
      const m = mergedByName[name];
      const endDate = effectiveEndDateFor(name);
      const s = perName[name].summary;
      const workingDays = dates.filter(ds => (!m.joinDate || ds >= m.joinDate) && (!endDate || ds <= endDate) && !isSun(ds) && !isHolidayFn(ds)).length;
      const otherFine = 0; // not yet attributed per-day — see file header note
      const totalFine = s.lateFine + otherFine;
      const unpaidLeaveDeduction = 0; // paid/unpaid classification not yet ported — see file header note
      const totalDeduction = totalFine + unpaidLeaveDeduction;
      const asOfDate = endDate && endDate < dates[dates.length - 1] ? endDate : dates[dates.length - 1];
      const leaveLeft = Math.round((earnedLeaveAsOf(m.joinDate, asOfDate) - s.leaveTaken) * 100) / 100;
      const row = [
        C(m.name, { bg: PALETTE.identityBg, bold: true, size: 9, align: 'LEFT' }),
        C(m.employeeId || '—', { bg: PALETTE.identityBg, size: 9, align: 'LEFT' }),
        C(m.department || '—', { bg: PALETTE.identityBg, size: 9, align: 'LEFT' }),
        C(workingDays, { bg: PALETTE.countsBg, size: 9 }),
        C(s.present, { bg: PALETTE.countsBg, size: 9 }),
        C(s.half, { bg: PALETTE.countsBg, size: 9 }),
        C(s.wfh, { bg: PALETTE.countsBg, size: 9 }),
        C(s.standard, { bg: PALETTE.countsBg, size: 9 }),
        C(s.sick, { bg: PALETTE.countsBg, size: 9 }),
        C(s.other, { bg: PALETTE.countsBg, size: 9 }),
        C(0, { bg: PALETTE.moneyBg, fg: PALETTE.amberFg, bold: true, size: 9 }), // Unpaid Leave (count) — see note
        C(s.absent, { bg: PALETTE.moneyBg, size: 9 }),
        C(s.late, { bg: PALETTE.moneyBg, size: 9 }),
        C(s.forgivenLate, { bg: PALETTE.moneyBg, size: 9 }),
        C(s.lateFine, { bg: PALETTE.moneyBg, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }),
        C(otherFine, { bg: PALETTE.moneyBg, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }),
        C(totalFine, { bg: PALETTE.moneyBg, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }),
        C(unpaidLeaveDeduction, { bg: PALETTE.moneyBg, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }),
        C(totalDeduction, { bg: PALETTE.moneyBg, fg: PALETTE.orange, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }),
        C(s.leaveTaken, { bg: PALETTE.countsBg, size: 9 }),
        C(leaveLeft, { bg: PALETTE.countsBg, size: 9 })
      ];
      grid.push(padRow(row, W));
    });

    grid.push(blankRow(W, PALETTE.pageBg));
    grid.push(blankRow(W, PALETTE.pageBg));
    grid.push(bannerRow('DETAILED MONTHLY ATTENDANCE', PALETTE.orange, W, { fg: PALETTE.titleFg, size: 11, bold: true }));

    const detailHeaderRow = [
      C('Employee', { bg: PALETTE.headerBg, bold: true, size: 8, wrap: true }),
      C('Detail', { bg: PALETTE.headerBg, bold: true, size: 8, wrap: true })
    ];
    dates.forEach(ds => {
      const d = new Date(ds + 'T00:00:00');
      const wk = d.toLocaleDateString('en-IN', { weekday: 'short' }).toUpperCase();
      detailHeaderRow.push(C(d.getDate() + '\n' + wk, { bg: PALETTE.dateHeaderBg, bold: true, size: 8, wrap: true }));
    });
    grid.push(detailHeaderRow);

    empKeysForMonth.forEach(name => {
      const m = mergedByName[name];
      const days = perName[name].days;
      DETAIL_ROWS.forEach((rowLabel, ri) => {
        const style = ROW_STYLE[rowLabel];
        const row = [];
        row.push(ri === 0
          ? C([m.name, m.employeeId || '—', m.department || '—'].join('\n'), { bg: PALETTE.identityBg, bold: true, size: 9, align: 'LEFT', valign: 'TOP', wrap: true })
          : C(null, { bg: PALETTE.identityBg }));
        row.push(C(rowLabel, { bg: style.bg || PALETTE.group1Bg, bold: true, size: 8, align: 'LEFT' }));
        days.forEach(d => {
          const cell = detailCellFor(rowLabel, d, style);
          row.push(cell);
        });
        grid.push(row);
      });
      grid.push(blankRow(W, PALETTE.pageBg));
      grid.push(blankRow(W, PALETTE.pageBg));
    });

    monthTabs.push({ tabName: moLabel(mo), W, grid, rowsCount: grid.length, empCount: empKeysForMonth.length });
  });

  // Renders one data cell in the "DETAILED MONTHLY ATTENDANCE" block for a
  // single employee/day/row-label combination.
  function detailCellFor(rowLabel, d, style) {
    if (d.outsideEmployment) return C('—', { bg: PALETTE.noDataBg, size: 8 });
    const status = d.status;
    if (rowLabel === 'Status') {
      return C(STATUS_LABEL[status] || status, { bg: PALETTE.status[status] || PALETTE.group1Bg, bold: true, size: 8 });
    }
    const isWorkDay = status !== 'weekoff' && status !== 'holiday';
    const hasPunch = !!(d.rec && d.rec.i != null);
    const na = () => C('—', { bg: PALETTE.noDataBg, size: 8 });

    switch (rowLabel) {
      case 'Punch In': return hasPunch ? C(minToClock(d.rec.i), { bg: style.bg, size: 8 }) : na();
      case 'Punch Out': return hasPunch && d.rec.o != null ? C(minToClock(d.rec.o), { bg: style.bg, size: 8 }) : na();
      case 'Gross Hours': return hasPunch && d.rec.o != null ? C(minToHM(d.rec.o - d.rec.i), { bg: style.bg, size: 8 }) : na();
      case 'Break Time': return hasPunch ? C(minToHM(d.rec.b || 0), { bg: style.bg, size: 8 }) : na();
      case 'Net Hours': return hasPunch ? C(minToHM(d.rec.w || 0), { bg: style.bg, size: 8 }) : na();
      case 'Required Hours': return isWorkDay ? C(minToHM(reqMinFor(d.ds)), { bg: style.bg, size: 8 }) : na();
      case 'Late By': return hasPunch && d.rec.i > SHIFT_START_MIN ? C(minToHM(d.rec.i - SHIFT_START_MIN), { bg: style.bg, size: 8 }) : na();
      case 'Early Exit': return hasPunch && d.rec.o != null && d.rec.o < SHIFT_END_MIN ? C(minToHM(SHIFT_END_MIN - d.rec.o), { bg: style.bg, size: 8 }) : na();
      case 'Short Hours': { if (!isWorkDay) return na(); const short = reqMinFor(d.ds) - (d.rec ? (d.rec.w || 0) : 0); return short > 0 ? C(minToHM(short), { bg: style.bg, size: 8 }) : na(); }
      case 'Work Mode': return status === 'wfh' ? C('Work From Home', { bg: style.bg, size: 8 }) : (status === 'present' || status === 'late' || status === 'half') ? C('Office', { bg: style.bg, size: 8 }) : na();
      case 'Leave Type': return status === 'leave' ? C(LEAVE_TYPE_LABEL[d.formalType] || 'Other', { bg: style.bg, size: 8 }) : isWorkDay ? C('None', { bg: style.bg, size: 8 }) : na();
      case 'Leave Duration': return status === 'leave' ? C('Full Day', { bg: style.bg, size: 8 }) : isWorkDay ? C('None', { bg: style.bg, size: 8 }) : na();
      case 'Paid / Unpaid': return na(); // classification not ported — see file header note
      case 'Unpaid Leave': return na(); // see file header note
      case 'Approval Status': return status === 'leave' ? C('Approved', { bg: style.bg, size: 8 }) : isWorkDay ? C('Not Required', { bg: style.bg, size: 8 }) : na();
      case 'Approved By': return na(); // no approver identity tracked per day
      case 'Late Forgiven': return d.isLate ? C(d.lateForgiven ? 'Yes' : 'No', { bg: style.bg, size: 8 }) : na();
      case 'Late Fine ₹': return d.isLate ? C(rupee(d.lateFine), { bg: style.bg, size: 8 }) : na();
      case 'Other Fine ₹': return isWorkDay ? C(rupee(0), { bg: style.bg, size: 8 }) : na(); // not attributed per-day yet
      case 'Total Fine ₹': return isWorkDay ? C(rupee(d.isLate ? d.lateFine : 0), { bg: style.bg, size: 8 }) : na();
      case 'Remarks': return na(); // no free-text remarks tracked per day
      default: return na();
    }
  }

  // ============================================================
  // "Yearly Summary" tab
  // ============================================================
  const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const yearNow = new Date(Date.now() + 5.5 * 3600 * 1000).getFullYear();
  const monthKeysOfYear = MONTH_ABBR.map((_, i) => yearNow + '-' + String(i + 1).padStart(2, '0'));
  const monthDataCache = {};
  months.forEach(mo => { monthDataCache[mo] = computeMonth(mo); });

  const yearlyW = 3 + 12 * 7 + 8;
  const yGrid = [];
  yGrid.push(bannerRow('LOONA · YEARLY ATTENDANCE & PAYROLL SUMMARY', PALETTE.pageBg, yearlyW, { fg: PALETTE.titleFg, size: 17, bold: true }));
  yGrid.push(bannerRow(yearNow + ' · Auto-synced from Loona Hub', PALETTE.pageBg, yearlyW, { fg: PALETTE.subtitleFg, size: 10 }));
  yGrid.push(blankRow(yearlyW, PALETTE.pageBg));

  const yHeader1 = [
    C('Employee', { bg: PALETTE.headerBg, bold: true, size: 9, wrap: true }),
    C('Code', { bg: PALETTE.headerBg, bold: true, size: 9, wrap: true }),
    C('Department', { bg: PALETTE.headerBg, bold: true, size: 9, wrap: true })
  ];
  MONTH_ABBR.forEach(mLbl => {
    yHeader1.push(C(mLbl, { bg: PALETTE.monthGroupHeaderBg, bold: true, size: 10 }));
    for (let i = 1; i < 7; i++) yHeader1.push(C(null, { bg: PALETTE.monthGroupHeaderBg }));
  });
  yHeader1.push(C('YEAR TOTALS', { bg: PALETTE.monthGroupHeaderBg, bold: true, size: 10 }));
  for (let i = 1; i < 8; i++) yHeader1.push(C(null, { bg: PALETTE.monthGroupHeaderBg }));
  yGrid.push(yHeader1);

  const MONTH_METRIC_HEADERS = ['Leave Taken', 'Unpaid Leave', 'Late Days', 'Late Fine ₹', 'Other Fine ₹', 'Total Fine ₹', 'Attendance Deduction ₹'];
  const YEAR_TOTAL_HEADERS = ['Total Leave Taken', 'Total Unpaid Leave', 'Total Late Days', 'Total Late Fine ₹', 'Total Other Fine ₹', 'Total Fine ₹', 'Total Attendance Deduction ₹', 'Current Leave Balance'];
  const yHeader2 = [C(null, { bg: PALETTE.headerBg }), C(null, { bg: PALETTE.headerBg }), C(null, { bg: PALETTE.headerBg })];
  for (let mo = 0; mo < 12; mo++) MONTH_METRIC_HEADERS.forEach(h => yHeader2.push(C(h, { bg: PALETTE.headerBg, bold: true, size: 8, wrap: true })));
  YEAR_TOTAL_HEADERS.forEach(h => yHeader2.push(C(h, { bg: PALETTE.headerBg, bold: true, size: 8, wrap: true })));
  yGrid.push(yHeader2);

  names.forEach(name => {
    const m = mergedByName[name];
    const row = [
      C(m.name, { bg: PALETTE.identityBg, bold: true, size: 9, align: 'LEFT' }),
      C(m.employeeId || '—', { bg: PALETTE.identityBg, size: 9, align: 'LEFT' }),
      C(m.department || '—', { bg: PALETTE.identityBg, size: 9, align: 'LEFT' })
    ];
    let totalLeave = 0, totalLate = 0, totalLateFine = 0;
    monthKeysOfYear.forEach(mo => {
      const perName = monthDataCache[mo];
      const s = perName && perName[name] && perName[name].summary;
      if (!s || !monthOverlapsEmployment(name, mo)) { for (let i = 0; i < 6; i++) row.push(C('—', { bg: PALETTE.countsBg, size: 9 })); row.push(C('—', { bg: PALETTE.moneyBg, size: 9 })); return; }
      totalLeave += s.leaveTaken; totalLate += s.late; totalLateFine += s.lateFine;
      row.push(C(s.leaveTaken, { bg: PALETTE.countsBg, size: 9 }));
      row.push(C(0, { bg: PALETTE.countsBg, size: 9 })); // Unpaid Leave — see file header note
      row.push(C(s.late, { bg: PALETTE.countsBg, size: 9 }));
      row.push(C(s.lateFine, { bg: PALETTE.countsBg, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }));
      row.push(C(0, { bg: PALETTE.countsBg, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } })); // Other Fine — see note
      row.push(C(s.lateFine, { bg: PALETTE.countsBg, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }));
      row.push(C(s.lateFine, { bg: PALETTE.moneyBg, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }));
    });
    // Someone who's left shouldn't keep accruing leave past their own last
    // working day just because other, still-active people have later data.
    const latestDataDate = months.length ? daysInMonth(months[months.length - 1]).slice(-1)[0] : (yearNow + '-12-31');
    const personEndDate = effectiveEndDateFor(name);
    const asOfDate = personEndDate && personEndDate < latestDataDate ? personEndDate : latestDataDate;
    const leaveBalance = Math.round((earnedLeaveAsOf(m.joinDate, asOfDate) - totalLeave) * 100) / 100;
    row.push(C(totalLeave, { bg: PALETTE.moneyBg, bold: true, size: 9 }));
    row.push(C(0, { bg: PALETTE.moneyBg, bold: true, size: 9 })); // Total Unpaid Leave — see note
    row.push(C(totalLate, { bg: PALETTE.moneyBg, bold: true, size: 9 }));
    row.push(C(totalLateFine, { bg: PALETTE.moneyBg, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }));
    row.push(C(0, { bg: PALETTE.moneyBg, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } })); // Total Other Fine — see note
    row.push(C(totalLateFine, { bg: PALETTE.moneyBg, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }));
    row.push(C(totalLateFine, { bg: PALETTE.moneyBg, fg: PALETTE.orange, bold: true, size: 9, numberFormat: { type: 'CURRENCY', pattern: '₹#,##0' } }));
    row.push(C(leaveBalance, { bg: PALETTE.moneyBg, fg: PALETTE.amberFg, bold: true, size: 9 }));
    yGrid.push(row);
  });

  // ---- Write everything ----
  const accessToken = await getAccessToken(sa, SHEETS_SCOPE);
  console.log('attendance-sheet-sync: got Sheets access token, ensuring tabs exist...');
  const allTabNames = [YEARLY_TAB, ...monthTabs.map(t => t.tabName)];
  const sheetIdByTitle = await ensureTabsExist(sheetId, accessToken, allTabNames);
  console.log('attendance-sheet-sync: tabs ready (', allTabNames.join(', '), ')');

  await writeFormattedTab(sheetId, accessToken, sheetIdByTitle[YEARLY_TAB], yGrid, yearlyW, [
    { col: 0, px: 140 }, { col: 1, px: 90 }, { col: 2, px: 110 },
    ...Array.from({ length: 12 * 7 }, (_, i) => ({ col: 3 + i, px: [90, 90, 75, 90, 90, 90, 130][i % 7] })),
    ...Array.from({ length: 8 }, (_, i) => ({ col: 3 + 84 + i, px: [110, 110, 100, 110, 110, 100, 140, 110][i] }))
  ], [
    { row: 0, px: 40 }, { row: 1, px: 30 }, { row: 3, px: 46 }, { row: 4, px: 46 }
  ]);
  console.log('attendance-sheet-sync: wrote tab', YEARLY_TAB, '(', names.length, 'employees )');

  for (const t of monthTabs) {
    await writeFormattedTab(sheetId, accessToken, sheetIdByTitle[t.tabName], t.grid, t.W, [
      { col: 0, px: 150 }, { col: 1, px: 150 },
      ...Array.from({ length: t.W - 2 }, (_, i) => ({ col: 2 + i, px: 60 }))
    ], [
      { row: 0, px: 40 }, { row: 1, px: 30 }, { row: 3, px: 32 }, { row: 4, px: 50 },
      // Detail header row index computed below per-tab (blank rows + summary rows + gutter)
    ]);
    console.log('attendance-sheet-sync: wrote tab', t.tabName, '(', t.rowsCount, 'rows,', t.empCount, 'employees )');
  }

  const noteText = `Last synced: ${fmtIST()} · ${names.length} employee(s) · ${months.length} month(s) of real punch data`;
  const noteRow = yGrid.length + 2;
  await writeFormattedTab(sheetId, accessToken, sheetIdByTitle[YEARLY_TAB], [padRow([C(noteText, { bg: PALETTE.pageBg, fg: PALETTE.subtitleFg, size: 9, align: 'LEFT' })], yearlyW)], yearlyW, null, null, noteRow);

  return { synced: names.length, months: months.length, monthList: months };
}

// Pushes one grid (array of CellData rows, all the same width W) into a
// tab via updateCells — the only Sheets API path that carries formatting
// alongside values. Chunked by row-range to keep individual requests a
// reasonable size. Optionally also sets column widths / row heights (only
// meaningful the first time a tab's shape is established) and can target a
// specific startRow (for appending a footer note below existing content).
async function writeFormattedTab(sheetId, accessToken, tabSheetId, grid, W, colWidths, rowHeights, startRow) {
  startRow = startRow || 0;
  const requests = [];
  const gridRowCount = Math.max(1000, startRow + grid.length), gridColCount = Math.max(26, W);
  // A newly created tab (and Sheet1's own starting tab) defaults to
  // Google's standard 26-column x 1000-row grid — updateCells rejects any
  // range reaching past that with "beyond the last requested column"
  // (this layout needs up to 95 columns for Yearly Summary). Grow the grid
  // FIRST, in the same batchUpdate call, before writing any cells into it.
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: tabSheetId, gridProperties: { rowCount: gridRowCount, columnCount: gridColCount } },
      fields: 'gridProperties.rowCount,gridProperties.columnCount'
    }
  });
  // Only on the main content write (startRow 0, not the footer-note
  // follow-up call): wipe the WHOLE grid — values AND formatting — before
  // laying down the new content. A tab that's been synced before under an
  // EARLIER version of this layout (or the old flat-table format) can have
  // leftover rows/columns past wherever this run's content ends; plain
  // updateCells only overwrites the cells it actually addresses; it never
  // clears what it doesn't touch, so stale data (with stale, undark
  // formatting) would otherwise linger indefinitely below/beside the real
  // content. repeatCell with no value in its CellData clears both the
  // value and the background in one shot, painting everything the same
  // page background the real content will draw over a moment later.
  if (!startRow) {
    requests.push({
      repeatCell: {
        range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: gridRowCount, startColumnIndex: 0, endColumnIndex: gridColCount },
        cell: { userEnteredFormat: { backgroundColor: hexToRgb(PALETTE.pageBg) } },
        fields: 'userEnteredValue,userEnteredFormat.backgroundColor'
      }
    });
  }
  const CHUNK = 200;
  for (let i = 0; i < grid.length; i += CHUNK) {
    const chunk = grid.slice(i, i + CHUNK);
    requests.push({
      updateCells: {
        rows: chunk.map(r => ({ values: r })),
        fields: 'userEnteredValue,userEnteredFormat',
        range: { sheetId: tabSheetId, startRowIndex: startRow + i, endRowIndex: startRow + i + chunk.length, startColumnIndex: 0, endColumnIndex: W }
      }
    });
  }
  if (colWidths) colWidths.forEach(cw => {
    requests.push({ updateDimensionProperties: { range: { sheetId: tabSheetId, dimension: 'COLUMNS', startIndex: cw.col, endIndex: cw.col + 1 }, properties: { pixelSize: cw.px }, fields: 'pixelSize' } });
  });
  if (rowHeights) rowHeights.forEach(rh => {
    requests.push({ updateDimensionProperties: { range: { sheetId: tabSheetId, dimension: 'ROWS', startIndex: rh.row, endIndex: rh.row + 1 }, properties: { pixelSize: rh.px }, fields: 'pixelSize' } });
  });
  await sheetsRequest(`${sheetId}:batchUpdate`, accessToken, { method: 'POST', body: JSON.stringify({ requests }) });
}

exports.handler = async (event) => {
  try {
    const result = await runSync();
    console.log('attendance-sheet-sync OK:', JSON.stringify(result));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    // Logged explicitly — the HTTP response body alone isn't visible from
    // a mobile browser or a scheduled/cron invocation, only Netlify's
    // function log is, so the real failure reason needs to land here too.
    console.error('attendance-sheet-sync FAILED:', err && err.stack ? err.stack : err);
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};

// Exported for tests only.
exports._internal = { PALETTE, C, computeDayStatus, attributeLateFines, earnedLeaveAsOf, minToHM, minToClock };
