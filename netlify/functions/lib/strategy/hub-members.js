// "Who on the team does this phone number belong to?" — the one place that answers it.
//
// WhatsApp reports a sender's own self-chosen profile display name (contactName), which is
// not the same thing as "a real Hub teammate" — it can be wrong, stale, or missing, and BB
// must never present it as a verified identity. Hub's own /members roster (the same tree
// employee-sheet-sync.js reads) has each person's mobile number on file; matching against
// that — not WhatsApp's self-reported name — is the only identity signal BB can actually
// trust.
"use strict";
const { fbGet } = require("./firebase");

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function firstName(value) {
  return String(value || "").trim().split(/\s+/)[0] || "";
}

// A short, hand-maintained override for how BB addresses someone by name — same idea as
// EXCLUDED_FROM_EMPLOYEE_SHEET in employee-sheet-sync.js. Keyed by the last 10 digits of the
// phone number, since that's what findHubMemberByPhone already matches on. Add an entry here
// only when someone specifically wants BB to use something other than their Hub-recorded
// first name.
const PREFERRED_NAMES = {
  "9946008112": "G",
};

// Returns { name } for the Hub teammate whose /members.mobile matches this phone number, or
// null if nobody on the roster has it on file. Matched on the LAST 10 digits so a number
// saved with or without the country code (or with a leading 0) still resolves the same way.
// The name returned is first-name-only (or the hand-maintained preferred name above) — BB
// addresses people casually, not by their full Hub Employee Directory name.
async function findHubMemberByPhone(phone) {
  const wanted = digitsOnly(phone).slice(-10);
  if (wanted.length !== 10) return null;

  const preferred = PREFERRED_NAMES[wanted];
  if (preferred) return { name: preferred };

  const members = (await fbGet("members")) || {};
  for (const record of Object.values(members)) {
    if (!record || !record.name) continue;
    if (digitsOnly(record.mobile).slice(-10) === wanted) return { name: firstName(record.name) };
  }
  return null;
}

module.exports = { findHubMemberByPhone };
