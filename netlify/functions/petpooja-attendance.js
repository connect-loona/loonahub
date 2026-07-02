// ============================================================================
// LOONA Hub · Petpooja Payroll — attendance proxy (Netlify Function)
// ----------------------------------------------------------------------------
// Holds the client secret SERVER-SIDE (env vars) and returns only safe,
// transformed punch data to the hub. Never expose CLIENT_SECRET to the browser.
//
// Env vars (set in Netlify → Site settings → Environment variables):
//   PETPOOJA_CLIENT_ID       48271593
//   PETPOOJA_CLIENT_SECRET   (your secret)
//   PETPOOJA_BASE_URL        https://payrolltp.petpooja.com
//
// Endpoint (once deployed):
//   GET /.netlify/functions/petpooja-attendance?start_date=2026-07-01&end_date=2026-07-02
// ============================================================================

const BASE = (process.env.PETPOOJA_BASE_URL || "https://payrolltp.petpooja.com").replace(/\/+$/, "");
const CLIENT_ID = process.env.PETPOOJA_CLIENT_ID;
const CLIENT_SECRET = process.env.PETPOOJA_CLIENT_SECRET;

// Simple in-memory token cache (best-effort across warm invocations).
let _access = null;
let _accessExp = 0;
let _refresh = null;

async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { success: false, message: "Non-JSON response", raw: text }; }
  return { ok: r.ok, status: r.status, body };
}

async function issueToken() {
  const { body } = await jsonFetch(BASE + "/client_auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!body || !body.success || !body.data) throw new Error("Token failed: " + (body && body.message));
  _access = body.data.access_token;
  _accessExp = Date.now() + ((body.data.access_token_expire_in || 900) * 1000);
  _refresh = body.data.refresh_token || _refresh;
  return _access;
}

async function refreshToken() {
  if (!_refresh) return issueToken();
  const { body } = await jsonFetch(BASE + "/client_auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: _refresh }),
  });
  if (!body || !body.success || !body.data) return issueToken(); // refresh expired → re-issue
  _access = body.data.access_token;
  _accessExp = Date.now() + ((body.data.access_token_expire_in || 900) * 1000);
  return _access;
}

async function getAccessToken() {
  if (_access && Date.now() < _accessExp - 30000) return _access;   // 30s safety margin
  if (_refresh) return refreshToken();
  return issueToken();
}

async function getPunches(start, end) {
  const token = await getAccessToken();
  // NOTE: the doc shows GET with a JSON body. Browsers/fetch cannot send a body on GET,
  // so we pass the range as query params (standard interpretation). If Petpooja requires
  // a body instead, switch method to "POST" and add: body: JSON.stringify({start_date,end_date}).
  const url = BASE + "/attendance/punches?start_date=" + encodeURIComponent(start) + "&end_date=" + encodeURIComponent(end);
  let res = await jsonFetch(url, { method: "GET", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" } });
  // If token was rejected (401), refresh once and retry.
  if (res.status === 401) {
    await issueToken();
    res = await jsonFetch(url, { method: "GET", headers: { "Authorization": "Bearer " + _access, "Content-Type": "application/json" } });
  }
  return res.body;
}

// Convert "2025-09-01 12:15:00" → { epoch, minOfDay }
function parseStamp(s) {
  const [d, t] = String(s).split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi, se] = (t || "0:0:0").split(":").map(Number);
  return { epoch: new Date(Y, M - 1, D, h, mi, se || 0).getTime(), min: h * 60 + mi };
}

// Turn raw punch_detail into worked/break/first-in/last-out.
// Odd punch = In, even = Out (per doc); we pair chronologically and are robust to op labels.
function summarize(emp) {
  const pd = (emp.punch_detail || []).slice().sort((a, b) =>
    a.log_date_time < b.log_date_time ? -1 : 1);
  let worked = 0, brk = 0, firstIn = null, lastOut = null, openIn = null, lastOutEpoch = null, punches = [];
  pd.forEach((p, i) => {
    const { epoch, min } = parseStamp(p.log_date_time);
    // Prefer explicit op; fall back to odd/even ordering.
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
  return {
    emp_id: emp.emp_id,
    name: emp.name,
    date: emp.payroll_date,
    first_in_min: firstIn,
    last_out_min: lastOut,
    worked_min: Math.round(worked),
    break_min: Math.round(brk),
    open: openIn !== null,   // true = missing final punch-out
    punches,
  };
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

    const raw = await getPunches(start, end);
    const list = raw && raw.data && raw.data.punch_data ? raw.data.punch_data : [];
    const records = list.map(summarize);

    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, start, end, count: records.length, records }) };
  } catch (err) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
