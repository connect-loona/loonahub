// Leave and WFH requests are dates/type/status/reason only — never a balance, a paid/unpaid
// split, or any other figure, since that math is computed elsewhere and never persisted here.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { loadLeaveText } = require(path.join(HUB, "netlify/functions/lib/strategy/leave-memory"));

const TODAY = "2026-09-18";

(async () => {
  await req("PUT", `${RTDB_URL}/leave_requests.json`, null);

  const empty = await loadLeaveText({ today: TODAY });
  check("no leave requests yields null rather than an empty heading", empty === null, empty);

  await req("PUT", `${RTDB_URL}/leave_requests.json`, {
    r1: { member: "Anjali", from_date: "2026-09-22", to_date: "2026-09-23", reason: "Family function", leave_type: "standard", status: "approved" },
    r2: { member: "Rahul", from_date: "2026-09-19", to_date: "2026-09-19", reason: "Fever", leave_type: "sick", status: "pending" },
    r3: { member: "Priya", from_date: "2026-08-01", to_date: "2026-08-01", reason: "old and out of window", leave_type: "standard", status: "approved" },
    r4: { member: "Vishnu", from_date: "2026-09-20", to_date: "2026-09-20", reason: "changed my mind", leave_type: "standard", status: "cancelled" },
    r5: { member: "Karnik", from_date: "2026-09-21", to_date: "2026-09-21", reason: "asked and refused", leave_type: "standard", status: "declined" },
    r6: { member: "Meera", from_date: "2026-09-25", to_date: "2026-09-25", reason: "working from Pune", leave_type: "wfh", status: "approved" },
  });

  const text = await loadLeaveText({ today: TODAY });
  check("an approved leave in the window is included, with its date range", /Anjali/.test(text) && /2026-09-22/.test(text), text);
  check("a pending request is included too", /Rahul/.test(text) && /pending/.test(text), text);
  check("WFH shows as its own type", /Meera/.test(text) && /WFH/.test(text), text);
  check("a leave far outside the lookback window is excluded", !/Priya/.test(text), text);
  check("a cancelled request is excluded", !/Vishnu/.test(text), text);
  check("a declined request is excluded", !/Karnik/.test(text), text);
  check("the reason is quoted", /Family function/.test(text), text);
  check("it's explicitly framed as having no financial figures", /balance/.test(text) && /paid\/unpaid/.test(text), text);
  check("no field looks like a rupee amount", !/₹|balance_after|paid_days/.test(text), text);

  await req("PUT", `${RTDB_URL}/leave_requests.json`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
