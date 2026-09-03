// ============================================================================
// LOONA Hub · Petpooja → Firebase daily sync (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Runs on a schedule (see netlify.toml). Pulls the last ~35 days of punches and
// writes a compact per-day summary into Firebase Realtime DB so attendance
// history persists and is shared across everyone — no per-open API calls needed.
//
// Firebase path:  /loona_attendance/{YYYY-MM-DD}/{emp_id} = { n, i, w, b }
//   n = name, i = first_in minute-of-day, w = worked minutes, b = break minutes
//
// Env vars:
//   PETPOOJA_CLIENT_ID, PETPOOJA_CLIENT_SECRET, PETPOOJA_BASE_URL  (as before)
//   FIREBASE_DB_URL  (default: the loona-hub RTDB URL below)
//
// Manual run (for testing): GET /.netlify/functions/petpooja-sync?days=7
// ============================================================================

const https = require("https");
const { URL } = require("url");

const BASE = (process.env.PETPOOJA_BASE_URL || "https://payrolltp.petpooja.com").replace(/\/+$/, "");
const CLIENT_ID = process.env.PETPOOJA_CLIENT_ID;
const CLIENT_SECRET = process.env.PETPOOJA_CLIENT_SECRET;
const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

let _access = null, _accessExp = 0;

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

async function token() {
  if (_access && Date.now() < _accessExp - 30000) return _access;
  const { body } = await req("POST", BASE + "/client_auth/token", null, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  if (!body || !body.success) throw new Error("token failed: " + (body && body.message));
  _access = body.data.access_token;
  _accessExp = Date.now() + ((body.data.access_token_expire_in || 900) * 1000);
  return _access;
}

function parseStamp(s) {
  const [d, t] = String(s).split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi, se] = (t || "0:0:0").split(":").map(Number);
  return { epoch: new Date(Y, M - 1, D, h, mi, se || 0).getTime(), min: h * 60 + mi };
}
function summarize(emp) {
  const pd = (emp.punch_detail || []).slice().sort((a, b) => (a.log_date_time < b.log_date_time ? -1 : 1));
  let worked = 0, brk = 0, firstIn = null, openIn = null, lastOutEpoch = null, lastOut = null;
  pd.forEach((p, i) => {
    const { epoch, min } = parseStamp(p.log_date_time);
    let op = (p.op || "").toLowerCase(); if (op !== "in" && op !== "out") op = (i % 2 === 0) ? "in" : "out";
    if (op === "in") { if (firstIn === null) firstIn = min; if (lastOutEpoch !== null) brk += Math.max(0, (epoch - lastOutEpoch) / 60000); openIn = epoch; }
    else { if (openIn !== null) { worked += Math.max(0, (epoch - openIn) / 60000); openIn = null; } lastOutEpoch = epoch; lastOut = min; }
  });
  return { n: emp.name, i: firstIn, o: lastOut, w: Math.round(worked), b: Math.round(brk) };
}

async function fetchDay(day) {
  const t = await token();
  const r = await req("GET", BASE + "/attendance/punches", { "Authorization": "Bearer " + t }, { start_date: day, end_date: day });
  return (r.body && r.body.data && r.body.data.punch_data) || [];
}

// Firebase RTDB REST — PATCH merges the day's employees under /loona_attendance/{date}
async function fbPatchDay(date, obj) {
  return req("PATCH", FB + "/loona_attendance/" + date + ".json", null, obj);
}

function fmt(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

async function runSync(days) {
  const out = [];
  const today = new Date();
  for (let k = 0; k < days; k++) {
    const d = new Date(today.getTime() - k * 86400000);
    const date = fmt(d);
    const rows = await fetchDay(date);
    const dayObj = {};
    rows.forEach((e) => { if (e.emp_id) dayObj[e.emp_id] = summarize(e); });
    if (Object.keys(dayObj).length) { await fbPatchDay(date, dayObj); out.push({ date, employees: Object.keys(dayObj).length }); }
    else { out.push({ date, employees: 0 }); }
  }
  return out;
}

exports.handler = async (event) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return { statusCode: 500, body: JSON.stringify({ success: false, message: "Missing Petpooja env vars" }) };
  try {
    const q = (event && event.queryStringParameters) || {};
    const days = Math.min(parseInt(q.days || "35", 10) || 35, 60);
    const result = await runSync(days);
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ success: true, synced: result }) };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};

// Exposed so attendance-sheet-sync.js can force a fresh pull of just the
// last day or two right before it reads /loona_attendance — this daily
// scheduled sync only refreshes Firebase once a day (8pm IST), so a punch
// that Petpooja finalizes/corrects afterward (e.g. a late punch-out landing
// after that run) sits stale in Firebase, understating hours worked and
// misclassifying what should be a Late/Present day as Absent, until the
// NEXT nightly run happens to touch it again. See the "Chinmay showing
// Absent, no punch-out, on a day the dashboard has fully punched out and
// Late" investigation this fixed.
exports.runSync = runSync;
exports.hasCredentials = () => !!(CLIENT_ID && CLIENT_SECRET);
// Exported for tests only.
exports._internal = { summarize, parseStamp };
