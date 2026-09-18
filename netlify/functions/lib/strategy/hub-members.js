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

// What BB is allowed to know about a teammate: name, role, department, employee id, join
// date, birthday, mobile number — the same contact-and-org-chart information already visible
// on the Employee Directory's own main card. Never PAN, Aadhar, bank details or home address —
// those live in a completely separate, more locked-down Firebase node (/members_sensitive)
// that this file never reads from at all, the same boundary Gokul drew for the Employee
// Directory's own "Financial & ID — visible only to Gokul" section.
function directoryLine(record) {
  const name = String(record.name || "").trim();
  if (!name) return null;
  const bits = [];
  if (record.role) bits.push(record.role);
  if (record.department) bits.push(record.department);
  const role = bits.length ? bits.join(" · ") : null;
  const details = [];
  if (record.mobile) details.push(`mobile ${record.mobile}`);
  if (record.employeeId) details.push(`Employee ID ${record.employeeId}`);
  if (record.joinDate) details.push(`joined ${record.joinDate}`);
  if (record.birthdate) details.push(`birthday ${record.birthdate}`);
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  return `- ${name}${role ? ` — ${role}` : ""}${suffix}`;
}

// The Hub-wide team directory, for BB/Mani to answer "who's X", "what's Y's role", "when's
// Z's birthday" — questions about the team in general, not about whoever is currently
// speaking (that's findHubMemberByPhone's job). Included in both loadBrandBrain and
// loadGlobalBrain since who's on the team isn't specific to any one brand.
async function loadTeamDirectoryText() {
  const [members, inactiveRaw] = await Promise.all([fbGet("members"), fbGet("inactive_members")]);
  const inactiveNames = new Set(Array.isArray(inactiveRaw) ? inactiveRaw : Object.values(inactiveRaw || {}));
  const lines = Object.values(members || {})
    .filter((record) => record && record.name && !inactiveNames.has(record.name))
    .map(directoryLine)
    .filter(Boolean);
  return lines.length ? ["# Hub team directory", ...lines].join("\n") : null;
}

module.exports = { findHubMemberByPhone, loadTeamDirectoryText };
