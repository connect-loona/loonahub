// Who's on leave, when, and why — for BB to answer "is X off this week" or "who's on leave
// Friday" without anyone having to check the Admin panel.
//
// Reads /leave_requests/{id} = { member, from_date, to_date, reason, leave_type, status,
// charge_dates, span_days, sandwich_days, effective_days, probation, notice_shortfall,
// requested_at, decided_at, decided_by }. Every one of those fields is a date, a status word,
// or free text — nothing here is money. The balance/paid-vs-unpaid math (estimateLeaveBalance
// Impact() and friends in index.html) is computed on the fly from attendance data and is never
// written back to this record, so there is nothing financial to accidentally pick up even by
// reading the whole record.
"use strict";
const { fbGet } = require("./firebase");

const LOOKBACK_DAYS = 14;
const LOOKAHEAD_DAYS = 45;
const MAX_LINES = 40;

const TYPE_LABEL = { standard: "Leave", sick: "Sick leave", wfh: "WFH", flexible: "Flexible timing" };

function dateRange(record) {
  return record.from_date === record.to_date
    ? record.from_date
    : `${record.from_date} to ${record.to_date}`;
}

function leaveLine(record) {
  const member = String(record.member || "").trim();
  if (!member || !record.from_date) return null;
  const type = TYPE_LABEL[record.leave_type] || "Leave";
  const status = String(record.status || "pending");
  const reason = record.reason ? ` — "${String(record.reason).trim()}"` : "";
  return `- ${member}: ${dateRange(record)}, ${type} (${status})${reason}`;
}

function inWindow(record, from, to) {
  const start = String(record.from_date || "");
  const end = String(record.to_date || start);
  return start && end >= from && start <= to;
}

// A window around today, not the whole history — this answers "who's off around now",
// not "audit every leave request ever filed".
async function loadLeaveText(deps = {}) {
  const get = deps.fbGet || fbGet;
  const raw = (await get("leave_requests")) || {};
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const from = new Date(new Date(today).getTime() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const to = new Date(new Date(today).getTime() + LOOKAHEAD_DAYS * 86400000).toISOString().slice(0, 10);

  const relevant = Object.values(raw)
    .filter((record) => record && record.status !== "cancelled" && record.status !== "declined")
    .filter((record) => inWindow(record, from, to))
    .sort((a, b) => String(a.from_date || "").localeCompare(String(b.from_date || "")));

  const lines = relevant.slice(0, MAX_LINES).map(leaveLine).filter(Boolean);
  if (!lines.length) return null;
  return [
    "# Leave and WFH requests (recent and upcoming)",
    "Dates, type and status only — never a leave balance, a paid/unpaid split, or any other figure. That math lives elsewhere and is not something you have access to.",
    ...lines,
  ].join("\n");
}

module.exports = { loadLeaveText };
