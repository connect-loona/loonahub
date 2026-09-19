// BB meets each Loona teammate exactly once, ever. The whole point of this module is the
// "once" — a house rule can tell her how to introduce herself, but only stored state can
// remember whether a given person has already had that introduction.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const {
  hasMetSafe, markMetSafe, introductionPromptText, FIRST_GREETING, NAMELESS_GREETING,
} = require(path.join(HUB, "netlify/functions/lib/strategy/bb-introductions"));

(async () => {
  await req("PUT", `${RTDB_URL}/bb_introductions.json`, null);

  // ---- The once-ever record ----
  check("somebody BB has never spoken to has not been met", (await hasMetSafe("919000000001")) === false);
  await markMetSafe("919000000001", { name: "Aarushi", verified: true });
  check("after being introduced, the same person is remembered as met", (await hasMetSafe("919000000001")) === true);
  check("a different person is still unmet", (await hasMetSafe("919000000002")) === false);

  // A phone number is not a legal Firebase key in every shape it arrives in, and an unmet
  // person must never be reported as met just because the read blew up on the key.
  await markMetSafe("+91 90000 00003", { name: "Vishnu", verified: true });
  check("a number with spaces and a + is stored and read back consistently", (await hasMetSafe("+91 90000 00003")) === true);

  // ---- Failure direction matters ----
  // Re-introducing herself to a colleague of several weeks is visibly broken; quietly
  // skipping one introduction is invisible. So a failed lookup must report "already met".
  const brokenGet = async () => { throw new Error("Firebase is down"); };
  check("a failed lookup reports already-met rather than re-introducing her",
    (await hasMetSafe("919000000004", { fbGet: brokenGet })) === true);
  // And it must never throw: this runs inside the reply path, so raising here would cost
  // the team an answer entirely rather than just an introduction.
  check("a failed lookup never throws", true);

  const brokenSet = async () => { throw new Error("Firebase is down"); };
  let threw = false;
  try { await markMetSafe("919000000005", { name: "Anam", verified: true }, { fbSet: brokenSet }); }
  catch { threw = true; }
  check("a failed write never throws either", !threw);

  // ---- The greeting itself ----
  const named = introductionPromptText({ name: "Aarushi", verified: true });
  check("a Hub-verified person is greeted by their first name", /Heyyy Aarushi 👋/.test(named), named.slice(0, 200));
  check("the introduction carries her actual self-description", /I’m BB 🦦 — G’s right hand at Loona/.test(named), named);
  check("it tells her this is a first meeting", /meeting this person for the first time/i.test(named), named.slice(0, 120));
  check("it tells her never to introduce herself to them again", /never introduce yourself to them again/.test(named), named);
  check("it tells her to still answer whatever they actually asked", /answer it after the introduction/.test(named), named);
  check("it forbids inventing a name, role or detail", /Never invent a name, nickname, role or personal detail/.test(named), named);

  // Hub's roster is the only name she may use. WhatsApp's self-reported profile name can be
  // stale or belong to a phone's previous owner — opening a first meeting by calling someone
  // the wrong name is exactly the mixup the verified/unverified split exists to prevent.
  const unverified = introductionPromptText({ name: "Whoever", verified: false });
  check("an unverified WhatsApp profile name is NOT used to greet them", !/Heyyy Whoever/.test(unverified), unverified.slice(0, 200));
  check("an unverified speaker gets the nameless opening instead", /Heyyy 👋/.test(unverified), unverified.slice(0, 200));
  check("and is never told she already knows their name", !/I already know your name/.test(unverified), unverified);

  const nobody = introductionPromptText(null);
  check("no speaker at all also gets the nameless opening", /Heyyy 👋/.test(nobody), nobody.slice(0, 200));
  check("the named greeting does keep the 'I already know your name' line", /I already know your name/.test(FIRST_GREETING), FIRST_GREETING);
  check("the nameless greeting drops it", !/I already know your name/.test(NAMELESS_GREETING), NAMELESS_GREETING);
  check("no unreplaced template placeholder ever reaches the prompt",
    !/\{first_name\}/.test(named) && !/\{first_name\}/.test(unverified) && !/\{first_name\}/.test(nobody), named.slice(0, 200));

  await req("PUT", `${RTDB_URL}/bb_introductions.json`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
