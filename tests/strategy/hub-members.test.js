// A phone number matched against Hub's own /members roster is the only identity signal BB
// should trust for WhatsApp — see hub-members.js's own header comment for why WhatsApp's
// self-reported profile name isn't good enough on its own.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { findHubMemberByPhone } = require(path.join(HUB, "netlify/functions/lib/strategy/hub-members"));

(async () => {
  await fbSet("members", null);
  await fbSet("members", {
    m1: { name: "Chinmay", mobile: "+91 90047 99134", role: "Designer" },
    m2: { name: "Anam", mobile: "9745998501x_stray" }, // deliberately malformed — must not crash the scan
  });

  const exact = await findHubMemberByPhone("+919004799134");
  check("a phone number stored with spaces/plus matches a plain digit lookup", exact && exact.name === "Chinmay", exact);

  const noCountryCode = await findHubMemberByPhone("9004799134");
  check("the same person matches without a country code, by the last 10 digits", noCountryCode && noCountryCode.name === "Chinmay", noCountryCode);

  const differentFormatting = await findHubMemberByPhone("91-90047-99134");
  check("dashes and a leading country code don't prevent a match", differentFormatting && differentFormatting.name === "Chinmay", differentFormatting);

  const noMatch = await findHubMemberByPhone("+919372789819");
  check("a number nobody on the roster has on file finds nothing", noMatch === null, noMatch);

  const malformed = await findHubMemberByPhone("garbage");
  check("an unusable input finds nothing rather than throwing", malformed === null, malformed);

  await fbSet("members", null);
  const emptyRoster = await findHubMemberByPhone("+919004799134");
  check("an empty roster finds nothing rather than throwing", emptyRoster === null, emptyRoster);

  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
