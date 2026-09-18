// Standing behavioural rules the team has taught BB — how she introduces herself, adjusts her
// tone for a person, etc. Distinct from Mani's brand memory: this list is Hub-wide (one voice
// for BB everywhere), not per-brand, and is meant to be read as instructions, not evidence.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { loadHouseRulesText, saveHouseRuleSafe } = require(path.join(HUB, "netlify/functions/lib/strategy/bb-house-rules"));

(async () => {
  await req("PUT", `${RTDB_URL}/bb_house_rules.json`, null);

  const empty = await loadHouseRulesText();
  check("no house rules yields null rather than an empty heading", empty === null, empty);

  await saveHouseRuleSafe("When Chinmay asks who you are, add a bit more edge and banter.", "Gokul");
  await saveHouseRuleSafe("Keep it professional but warm with someone you haven't spoken to before.", "Gokul");

  const text = await loadHouseRulesText();
  check("a saved rule is included", /Chinmay/.test(text || ""), text);
  check("multiple rules are all included", /professional but warm/.test(text || ""), text);
  check("rules render as a plain list, not prose", /^- /m.test(text || ""), text);

  await saveHouseRuleSafe("   ", "Gokul");
  const afterBlank = await loadHouseRulesText();
  check("a blank rule is never saved", !/^\s*-\s*$/m.test(afterBlank || ""), afterBlank);

  await req("PUT", `${RTDB_URL}/bb_house_rules.json`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
