// A fixed reference of what's actually on the Hub dashboard, so BB knows the tools exist even
// when nothing else in memory happens to mention them.
"use strict";
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { loadHubOverviewText } = require(path.join(HUB, "netlify/functions/lib/strategy/hub-overview"));

(async () => {
  const text = await loadHubOverviewText();
  check("it names the Task Board", /Task Board/.test(text), text.slice(0, 100));
  check("it names Loona Radio", /Loona Radio/.test(text), text);
  check("it names the Loona Board broadcast feed", /Loona Board/.test(text), text);
  check("it names Strategy OS and Visual Studio", /Strategy OS/.test(text) && /Visual Studio/.test(text), text);
  check("it flags payroll/financial systems as off-limits rather than silently omitting them", /financial|payroll/i.test(text), text);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
