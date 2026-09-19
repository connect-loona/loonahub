// Standing behavioural rules the team has taught BB — how she introduces herself, addresses
// people, adjusts her tone. Distinct from Mani's brand memory: this list is Hub-wide (one BB
// personality, not one per brand), and some rules apply everywhere while others are scoped to
// one surface (WhatsApp vs a Strategy OS session on Hub), since it's legitimate for BB to sound
// more casual in one than the other.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { loadHouseRulesText, saveHouseRuleSafe, DEFAULT_HOUSE_RULES } = require(path.join(HUB, "netlify/functions/lib/strategy/bb-house-rules"));

(async () => {
  await req("PUT", `${RTDB_URL}/bb_house_rules.json`, null);

  // The shipped defaults are always present, even with nothing taught yet — the team
  // shouldn't have to re-teach BB the same three rules after every fresh deploy.
  const whatsappDefault = await loadHouseRulesText("whatsapp");
  check("with nothing taught, WhatsApp still gets the default rules", /Hi G.*Gokul|address them by their first name/.test(whatsappDefault || ""), whatsappDefault);
  check("the WhatsApp-scoped default (quirky/casual) is included on the whatsapp channel", /quirky, casual and playful/.test(whatsappDefault || ""), whatsappDefault);
  check("the Hub-scoped default (formal) is NOT included on the whatsapp channel", !/more formal and professional/.test(whatsappDefault || ""), whatsappDefault);

  const hubDefault = await loadHouseRulesText("hub");
  check("the Hub-scoped default (formal) is included on the hub channel", /more formal and professional/.test(hubDefault || ""), hubDefault);
  check("the WhatsApp-scoped default (quirky/casual) is NOT included on the hub channel", !/quirky, casual and playful/.test(hubDefault || ""), hubDefault);
  check("the universal naming default is included on the hub channel too", /address them by their first name/.test(hubDefault || ""), hubDefault);

  check("DEFAULT_HOUSE_RULES is exported and non-empty", Array.isArray(DEFAULT_HOUSE_RULES) && DEFAULT_HOUSE_RULES.length >= 3, DEFAULT_HOUSE_RULES.length);

  // A fixed core answer for recurring questions ("who are you") — but she must be told to
  // rephrase it, not recite it, so the rule itself has to carry both halves.
  check("a standard 'who are you' core answer is shipped by default", /G's right hand at Loona/.test(whatsappDefault || ""), whatsappDefault);
  check("it explicitly tells her to rephrase rather than recite it verbatim", /never recite it as a fixed script/.test(whatsappDefault || ""), whatsappDefault);
  check("the standard-answer default also reaches the hub channel", /G's right hand at Loona/.test(hubDefault || ""), hubDefault);

  // A task-board status question must cover everyone on the board, not a curated few — the
  // exact gap a WhatsApp screenshot exposed: "what's due for each team" answered for only 5
  // of the team even though the board memory has every open task for every person.
  check("a default rule requires covering every person/brand on a status question", /go through every person and brand/.test(whatsappDefault || ""), whatsappDefault);
  check("it explicitly says not to silently drop someone to keep the reply shorter", /never silently drop someone/.test(whatsappDefault || ""), whatsappDefault);
  check("it requires including tasks with no due date or a future due date too", /no due date or a due date later than today/.test(whatsappDefault || ""), whatsappDefault);

  // WhatsApp's Business API means BB can only ever reply, never message first — a default
  // rule should tell her to keep the conversation alive with a hook, and only on WhatsApp.
  check("a default rule tells her to end WhatsApp replies with a follow-up hook", /can only ever reply.*never message someone first/s.test(whatsappDefault || ""), whatsappDefault);
  check("the follow-up-hook default is scoped to WhatsApp, not Hub", !/can only ever reply/.test(hubDefault || ""), hubDefault);

  // Naming the real blocker (who a task is waiting on) is what makes a status answer useful.
  check("a default rule requires explaining the real blocker on a status update, not just the status label", /Ankita hasn't approved it yet/.test(whatsappDefault || ""), whatsappDefault);
  check("that default reaches the hub channel too", /Ankita hasn't approved it yet/.test(hubDefault || ""), hubDefault);

  // ---- Rules taught through conversation layer on top of the defaults ----
  await saveHouseRuleSafe("When Chinmay asks who you are, add a bit more edge and banter.", "Gokul");
  const withTaught = await loadHouseRulesText("whatsapp");
  check("a taught rule with no channel is included on every surface", /Chinmay/.test(withTaught || ""), withTaught);
  const withTaughtOnHub = await loadHouseRulesText("hub");
  check("an unscoped taught rule also reaches the Hub channel", /Chinmay/.test(withTaughtOnHub || ""), withTaughtOnHub);

  await saveHouseRuleSafe("Sign off with a paw print emoji.", "Gokul", "whatsapp");
  const scopedWhatsapp = await loadHouseRulesText("whatsapp");
  const scopedHub = await loadHouseRulesText("hub");
  check("a rule taught with an explicit channel only applies there", /paw print/.test(scopedWhatsapp || "") && !/paw print/.test(scopedHub || ""), { scopedWhatsapp, scopedHub });

  await saveHouseRuleSafe("   ", "Gokul");
  const afterBlank = await loadHouseRulesText("whatsapp");
  check("a blank rule is never saved", !/^\s*-\s*$/m.test(afterBlank || ""), afterBlank);

  await req("PUT", `${RTDB_URL}/bb_house_rules.json`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
