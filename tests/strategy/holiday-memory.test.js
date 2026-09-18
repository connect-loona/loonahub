// The holiday calendar: a fixed official list mirrored from index.html, plus founder-added
// extras synced live from /loona_holidays.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { loadHolidayText, OFFICIAL_HOLIDAYS } = require(path.join(HUB, "netlify/functions/lib/strategy/holiday-memory"));

const TODAY = "2026-09-18";

(async () => {
  await req("PUT", `${RTDB_URL}/loona_holidays.json`, null);

  const officialOnly = await loadHolidayText({ today: TODAY });
  check("an official holiday within the lookahead window is included", /2026-10-20: Dussehra/.test(officialOnly || ""), officialOnly);
  check("a far-future official holiday is excluded by the lookahead window", !/2027-01-26/.test(officialOnly || ""), officialOnly);
  check("a past official holiday is excluded", !/Ganesh Chaturthi/.test(officialOnly || ""), officialOnly);

  await req("PUT", `${RTDB_URL}/loona_holidays.json`, { h1: { date: "2026-09-30", name: "Founder-added day off" } });
  const withExtra = await loadHolidayText({ today: TODAY });
  check("a founder-added extra holiday is included alongside the official ones", /Founder-added day off/.test(withExtra), withExtra);
  check("earlier holidays are listed before later ones", withExtra.indexOf("Founder-added day off") < withExtra.indexOf("Dussehra"), withExtra);

  await req("PUT", `${RTDB_URL}/loona_holidays.json`, null);
  const farFuture = await loadHolidayText({ today: "2030-01-01" });
  check("no holidays in the window yields null", farFuture === null, farFuture);
  check("the mirrored official list is non-empty", OFFICIAL_HOLIDAYS.length > 0, OFFICIAL_HOLIDAYS.length);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
