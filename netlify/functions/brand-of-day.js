// ============================================================================
// LOONA Hub · Brand of the Day (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Runs once daily at 00:00 IST (see netlify.toml) so the day's rotating
// "Introduce brand of the day" task exists in Firebase even if nobody has
// the dashboard open yet. Mirrors the client-side rotation in index.html
// (brandOfDayRoster/brandOfDayPerson/isBrandOfDayOff) so both agree on
// whose turn it is.
//
// Rotation is a Firebase-persisted pointer (loona_botd_state: {date, person}),
// not a fixed date formula — adding/removing a team member only shifts the
// NEXT turn, it never needs recalibrating.
//
// Manual run (for testing): GET /.netlify/functions/brand-of-day
// ============================================================================

const https = require("https");
const { URL } = require("url");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

// Keep this list in sync with ALL_MEMBERS in index.html.
const BASE_MEMBERS = ["Gokul", "Anam", "Ankita", "Ricky", "Muskan", "Nishant", "Karnik", "Chinmay", "Majid", "Anurag", "Vivaan", "Diya", "Ananya"];

// Keep in sync with OFFICIAL_HOLIDAYS in index.html.
const OFFICIAL_HOLIDAYS = [
  { date: "2026-03-19", name: "Gudi Padwa" },
  { date: "2026-03-21", name: "Ramzan Eid*" },
  { date: "2026-04-03", name: "Good Friday" },
  { date: "2026-05-01", name: "Maharashtra Day" },
  { date: "2026-08-15", name: "Independence Day" },
  { date: "2026-08-28", name: "Raksha Bandhan" },
  { date: "2026-09-14", name: "Ganesh Chaturthi" },
  { date: "2026-10-20", name: "Dussehra" },
  { date: "2026-11-08", name: "Diwali (Laxmi Pujan)" },
  { date: "2026-11-09", name: "Diwali Day 2" },
  { date: "2026-12-25", name: "Christmas Day" },
  { date: "2027-01-01", name: "New Year's Day" },
  { date: "2027-01-26", name: "Republic Day" },
  { date: "2027-03-24", name: "Holi (2nd Day Rangpanchami)" },
  { date: "2027-04-08", name: "Gudhi Padwa" },
  { date: "2027-04-09", name: "Ramzan Eid*" }
];

// Bootstrap value only — used until Firebase has real loona_botd_state.
// Rotation went live on 2026-07-09, landing on Chinmay.
const BOTD_SEED = { date: "2026-07-09", person: "Chinmay" };

function req(method, urlStr, headers, bodyObj) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const data = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const h = Object.assign({ "Accept": "application/json" }, headers || {});
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let b; try { b = JSON.parse(buf); } catch (e) { b = { _raw: buf.slice(0, 300) }; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: String(e) } }));
    if (data) r.write(data);
    r.end();
  });
}

function fbGet(path) { return req("GET", FB + path + ".json", null, null); }
function fbPut(path, val) { return req("PUT", FB + path + ".json", null, val); }
function fbPost(path, val) { return req("POST", FB + path + ".json", null, val); }

function todayIST() {
  // IST = UTC+5:30
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}
function dayOfWeekIST(dateStr) {
  // Sunday check only needs the calendar date, safe in any timezone at noon
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}
function daysBetween(a, b) { return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000); }

async function buildRoster() {
  const [membersRes, inactiveRes] = await Promise.all([fbGet("/members"), fbGet("/inactive_members")]);
  const members = new Set(BASE_MEMBERS);
  const membersData = membersRes.body || {};
  Object.values(membersData || {}).forEach((m) => { if (m && m.name) members.add(m.name); });
  const inactive = new Set(inactiveRes.body || []);
  return Array.from(members).filter((n) => n !== "Gokul" && !inactive.has(n)).sort();
}

async function isOff(dateStr) {
  if (dateStr < BOTD_SEED.date) return true; // Anam covered 07-08 manually — automation starts 07-09
  if (dayOfWeekIST(dateStr) === 0) return true;
  if (OFFICIAL_HOLIDAYS.some((h) => h.date === dateStr)) return true;
  const holRes = await fbGet("/loona_holidays");
  const hol = holRes.body || {};
  return Object.values(hol).some((h) => h && h.date === dateStr);
}

function personFor(dateStr, roster, state) {
  if (!roster.length) return null;
  const steps = daysBetween(state.date, dateStr);
  if (steps <= 0) return state.person;
  const lastIdx = roster.indexOf(state.person);
  const idx = (((lastIdx + steps) % roster.length) + roster.length) % roster.length;
  return roster[idx];
}

exports.handler = async () => {
  try {
    const date = todayIST();
    const roster = await buildRoster();
    const off = await isOff(date);
    if (off) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "day off", date }) };

    // Already created for today? (also protects against a duplicate manual re-run)
    const claim = await fbGet("/loona_botd_created/" + date);
    if (claim.body) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "already created", date }) };
    await fbPut("/loona_botd_created/" + date, true);

    const stateRes = await fbGet("/loona_botd_state");
    const state = (stateRes.body && stateRes.body.date && stateRes.body.person) ? stateRes.body : BOTD_SEED;
    const person = personFor(date, roster, state);
    if (!person) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: "empty roster", date }) };

    const task = {
      member: person,
      brand: "",
      task: "Introduce brand of the day",
      assigned_by: "Gokul",
      priority: "Medium",
      status: "Not Started",
      due_date: date,
      asylum: "",
      is_botd: true,
      created_at: new Date().toISOString(),
      assigned_on: date
    };
    await Promise.all([
      fbPost("/tasks", task),
      fbPut("/loona_botd_state", { date, person })
    ]);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, date, person }) };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
