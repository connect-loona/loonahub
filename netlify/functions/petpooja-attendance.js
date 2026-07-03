// ============================================================================
// LOONA Hub · Petpooja Payroll — attendance proxy (Netlify Function) v2
// ----------------------------------------------------------------------------
// Holds the client secret SERVER-SIDE (env vars). Returns only safe,
// transformed punch data to the hub. Never expose CLIENT_SECRET to the browser.
//
// Env vars (Netlify → Site settings → Environment variables):
//   PETPOOJA_CLIENT_ID       48271593
//   PETPOOJA_CLIENT_SECRET   (your secret)
//   PETPOOJA_BASE_URL        https://payrolltp.petpooja.com
//
// Endpoint:
//   GET /.netlify/functions/petpooja-attendance?start_date=2026-07-01&end_date=2026-07-02
//   add &debug=1 to see the raw attempts (method / status / message).
//
// The Petpooja doc shows GET /attendance/punches WITH a JSON body. Standard
// fetch can't send a GET body, so this version uses Node's https module (which
// can) and tries: (1) GET+body, (2) POST+body, (3) GET query-params — returning
// the first that yields punch records.
// ============================================================================

const https = require("https");
const http = require("http");
const { URL } = require("url");

const BASE = (process.env.PETPOOJA_BASE_URL || "https://payrolltp.petpooja.com").replace(/\/+$/, "");
const CLIENT_ID = process.env.PETPOOJA_CLIENT_ID;
const CLIENT_SECRET = process.env.PETPOOJA_CLIENT_SECRET;

let _access = null, _accessExp = 0, _refresh = null;

// Low-level JSON request — CAN send a body on GET (unlike fetch).
function req(method, urlStr, headers, bodyObj) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "http:" ? http : https;
    const data = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const h = Object.assign({ "Accept": "application/json" }, headers || {});
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const r = lib.request(
      { method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: h },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let body;
          try { body = JSON.parse(buf); } catch (e) { body = { success: false, message: "Non-JSON response", raw: buf.slice(0, 400) }; }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    r.on("error", (e) => resolve({ status: 0, body: { success: false, message: String(e && e.message || e) } }));
    if (data) r.write(data);
    r.end();
  });
}

async function issueToken() {
  const { body } = await req("POST", BASE + "/client_auth/token", null, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  if (!body || !body.success || !body.data) throw new Error("Token failed: " + (body && body.message));
  _access = body.data.access_token;
  _accessExp = Date.now() + ((body.data.access_token_expire_in || 900) * 1000);
  _refresh = body.data.refresh_token || _refresh;
  return _access;
}
async function getAccessToken() {
  if (_access && Date.now() < _accessExp - 30000) return _access;
  if (_refresh) {
    const { body } = await req("POST", BASE + "/client_auth/refresh", null, { refresh_token: _refresh });
    if (body && body.success && body.data) {
      _access = body.data.access_token;
      _accessExp = Date.now() + ((body.data.access_token_expire_in || 900) * 1000);
      return _access;
    }
  }
  return issueToken();
}

function punchCount(body) {
  return (body && body.data && Array.isArray(body.data.punch_data)) ? body.data.punch_data.length : 0;
}

function fmtDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// Petpooja requires start_date == end_date, so we enumerate each day in the range.
function eachDate(start, end) {
  const out = [];
  let d = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  let guard = 0;
  while (d <= e && guard < 62) { out.push(fmtDate(d)); d.setDate(d.getDate() + 1); guard++; }
  return out.length ? out : [start];
}

// Fetch one day (GET with JSON body, start==end). Retries once on 401.
async function fetchDay(day) {
  const token = await getAccessToken();
  const body = { start_date: day, end_date: day };
  let r = await req("GET", BASE + "/attendance/punches", { "Authorization": "Bearer " + token }, body);
  if (r.status === 401) {
    await issueToken();
    r = await req("GET", BASE + "/attendance/punches", { "Authorization": "Bearer " + _access }, body);
  }
  return r;
}

async function getPunches(start, end, attempts) {
  await getAccessToken();                       // warm the token once before fanning out
  const days = eachDate(start, end);
  const results = await Promise.all(days.map(fetchDay));
  const all = [];
  results.forEach((r, i) => {
    const cnt = punchCount(r.body);
    if (attempts && (attempts.length < 10)) attempts.push({ date: days[i], status: r.status, count: cnt, message: r.body && r.body.message });
    if (r.body && r.body.data && Array.isArray(r.body.data.punch_data)) {
      r.body.data.punch_data.forEach((e) => all.push(e));
    }
  });
  return { success: true, data: { punch_data: all } };
}

function parseStamp(s) {
  const [d, t] = String(s).split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi, se] = (t || "0:0:0").split(":").map(Number);
  return { epoch: new Date(Y, M - 1, D, h, mi, se || 0).getTime(), min: h * 60 + mi };
}
function summarize(emp) {
  const pd = (emp.punch_detail || []).slice().sort((a, b) => (a.log_date_time < b.log_date_time ? -1 : 1));
  let worked = 0, brk = 0, firstIn = null, lastOut = null, openIn = null, lastOutEpoch = null, punches = [];
  pd.forEach((p, i) => {
    const { epoch, min } = parseStamp(p.log_date_time);
    let op = (p.op || "").toLowerCase();
    if (op !== "in" && op !== "out") op = (i % 2 === 0) ? "in" : "out";
    punches.push({ t: p.log_date_time, op });
    if (op === "in") {
      if (firstIn === null) firstIn = min;
      if (lastOutEpoch !== null) brk += Math.max(0, (epoch - lastOutEpoch) / 60000);
      openIn = epoch;
    } else {
      if (openIn !== null) { worked += Math.max(0, (epoch - openIn) / 60000); openIn = null; }
      lastOut = min; lastOutEpoch = epoch;
    }
  });
  return { emp_id: emp.emp_id, name: emp.name, date: emp.payroll_date, first_in_min: firstIn, last_out_min: lastOut, worked_min: Math.round(worked), break_min: Math.round(brk), open: openIn !== null, punches };
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, message: "Server not configured: set PETPOOJA_CLIENT_ID and PETPOOJA_CLIENT_SECRET env vars." }) };
  }
  try {
    const q = event.queryStringParameters || {};
    const today = new Date().toISOString().slice(0, 10);
    const start = q.start_date || today;
    const end = q.end_date || start;

    const attempts = [];
    const raw = await getPunches(start, end, attempts);
    const list = raw && raw.data && raw.data.punch_data ? raw.data.punch_data : [];
    const records = list.map(summarize);

    const out = { success: true, start, end, count: records.length, records };
    // When empty (or debug requested) include how each method fared + a sample of the raw envelope.
    if (records.length === 0 || q.debug) {
      out.attempts = attempts;
      out.raw_sample = raw && { success: raw.success, message: raw.message, keys: raw.data ? Object.keys(raw.data) : null };
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
