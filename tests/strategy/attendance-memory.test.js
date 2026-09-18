// Check-in/check-out only — this is the one line in the whole codebase drawing the boundary
// between "who's in today" (fine for BB to know) and Petpooja's payroll/fine/leave machinery
// in attendance-sheet-sync.js (never fine for BB to know, or even see).
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { loadAttendanceText } = require(path.join(HUB, "netlify/functions/lib/strategy/attendance-memory"));
const { loadGlobalBrain } = require(path.join(HUB, "netlify/functions/lib/strategy/store"));

function today() { return new Date().toISOString().slice(0, 10); }

(async () => {
  await fbSet(`loona_attendance/${today()}`, null);
  await fbSet("mani_brand_notes/global", null);
  await fbSet("mani_events", null);
  await fbSet("members", null);

  await fbSet(`loona_attendance/${today()}`, {
    e1: { n: "Ankita", i: 615, o: 1080, w: 420, b: 45 }, // 10:15 AM in, 6:00 PM out, 7h worked
    e2: { n: "Karnik", i: 540 }, // 9:00 AM in, still working — no check-out yet
    // A payroll/fine field that must never surface even if it were present on this same
    // record — attendanceLine() only ever reads n/i/o/w, structurally, not by omission.
    e3: { n: "Hetal", i: 570, lateFine: 200, leaveBalance: 3 },
  });

  const text = await loadAttendanceText();
  check("today's attendance names who checked in", /Ankita/.test(text || "") && /Karnik/.test(text || ""), text);
  check("check-in time is human-readable", /10:15 AM/.test(text || ""), text);
  check("check-out time is included when present", /6:00 PM/.test(text || ""), text);
  check("worked duration is included", /7h 0m/.test(text || ""), text);
  check("someone still checked in with no check-out yet is shown without one", /Karnik: checked in at 9:00 AM\./.test(text || ""), text);
  check("a payroll fine field is never surfaced even when present on the record", !/lateFine|leaveBalance|₹|200\b/.test(text || ""), text);
  check("the memory block itself warns against inferring payroll figures", /never mention or infer a fine, leave balance, salary/i.test(text || ""), text);

  await fbSet(`loona_attendance/${today()}`, { e1: { n: "Nobody Checked In Today" } });
  const noTimeYet = await loadAttendanceText();
  check("someone with a record but no check-in time yet is still named, not silently dropped", /Nobody Checked In Today: no check-in recorded today\./.test(noTimeYet || ""), noTimeYet);

  await fbSet(`loona_attendance/${today()}`, null);
  const emptyDay = await loadAttendanceText();
  check("a day with nobody synced yet has no attendance memory rather than an empty-but-truthy block", emptyDay === null, emptyDay);

  // ---- wired into Global BB's actual composed memory ----
  await fbSet(`loona_attendance/${today()}`, { e1: { n: "Ankita", i: 615, o: 1080, w: 420 } });
  const memory = await loadGlobalBrain();
  check("Global BB memory includes today's attendance", /Ankita.*10:15 AM/.test(memory || ""), memory);

  await fbSet(`loona_attendance/${today()}`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
