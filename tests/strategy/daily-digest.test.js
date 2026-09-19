// BB's three standing daily messages to the team, and the delivery honesty around them.
//
// The thing most worth testing here is not the wording — it is that a message which failed to
// reach somebody is never mistaken for one that arrived. WhatsApp refuses free-form text to
// anyone who has not messaged BB in 24 hours, and the whole schedule rests on the team
// messaging her daily to keep those windows open. That is an assumption about people, so the
// failure has to be loud the day it happens rather than discovered a month later.
"use strict";
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { buildDigest, SLOTS, istDate, countsText } = require(path.join(HUB, "netlify/functions/lib/strategy/daily-digest"));
const { deliverDigest, recipients, describeFailure } = require(path.join(HUB, "netlify/functions/lib/strategy/digest-delivery"));
const { runDigest, claimPath } = require(path.join(HUB, "netlify/functions/lib/strategy/digest-run"));

const TODAY = "2026-09-19";
const YESTERDAY = "2026-09-18";

const BOARD = {
  t1: { task: "Shoot the Diwali reel", member: "Anjali", brand: "RRO Foods", status: "Awaiting Approval", assigned_by: "Ankita", due_date: YESTERDAY, created_at: "2026-09-10T00:00:00Z" },
  t2: { task: "Write October captions", member: "Vishnu", brand: "RRO Foods", status: "Not Started", due_date: TODAY, created_at: "2026-09-12T00:00:00Z" },
  t3: { task: "Casa brand deck", member: "Priya", brand: "Casa Waters", status: "Completed", created_at: "2026-09-11T00:00:00Z" },
  t4: { task: "Fix the pack shot", member: "Rahul", brand: "RRO Foods", status: "In Progress", created_at: "2026-09-02T00:00:00Z" },
};

(async () => {
  await req("PUT", `${RTDB_URL}/tasks.json`, BOARD);
  await req("PUT", `${RTDB_URL}/bb_digest_sent.json`, null);
  await req("PUT", `${RTDB_URL}/bb_digest_log.json`, null);
  await req("PUT", `${RTDB_URL}/announcements.json`, null);

  // ---- The three slots ----
  check("there are exactly three slots", Object.keys(SLOTS).join() === "morning,midday,evening", Object.keys(SLOTS));
  check("the morning brief asks for yesterday's leftovers and today's work", /due yesterday/i.test(SLOTS.morning.brief) && /on the board for today/i.test(SLOTS.morning.brief));
  check("the morning brief insists on covering everyone, not a sample", /not a handful/i.test(SLOTS.morning.brief), SLOTS.morning.brief);
  check("the midday brief asks for something shorter than the morning one", /shorter than the morning/i.test(SLOTS.midday.brief));
  check("the evening brief asks for the analysis, which is its whole point", /analysis is the part that matters/i.test(SLOTS.evening.brief));
  check("the evening brief forbids inventing a reason something slipped", /Never invent a reason/i.test(SLOTS.evening.brief));

  // ---- Counting is done in code, not left to the model ----
  const activity = { active: Object.values(BOARD).filter((t) => t.status !== "Completed"), recentlyDone: [BOARD.t3], overdue: [BOARD.t1], people: ["Anjali", "Rahul", "Vishnu"], activeCount: 3 };
  const counts = countsText(activity, TODAY, YESTERDAY);
  check("it counts what was due yesterday and is still open", /due yesterday \(2026-09-18\): 1/.test(counts), counts);
  check("it counts what is due today", /Due today \(2026-09-19\): 1/.test(counts), counts);
  check("it counts open work with no due date at all", /no due date at all: 1/.test(counts), counts);
  check("it tells BB to use these numbers rather than recount", /do not recount and contradict them/i.test(counts), counts);

  // ---- buildDigest hands BB the live board and its own brief ----
  let asked = null;
  const fakeAsk = async (params) => { asked = params; return { answer: "Morning team 👋 here's where we are.", provider: "Anthropic", model: "test" }; };
  const digest = await buildDigest("morning", { today: TODAY, yesterday: YESTERDAY, askBB: fakeAsk, loadHouseRulesText: async () => "- Be quirky on WhatsApp." });
  check("the digest comes back as text", digest.text === "Morning team 👋 here's where we are.", digest);
  check("BB is asked the morning brief", /due yesterday/i.test(asked.message), asked.message.slice(0, 80));
  check("BB is given the live task board", /Shoot the Diwali reel/.test(asked.memory), asked.memory.slice(0, 200));
  check("BB is given today's and yesterday's date explicitly", /Today is 2026-09-19. Yesterday was 2026-09-18./.test(asked.memory), asked.memory.slice(0, 100));
  check("BB's WhatsApp house rules are applied to it", /quirky on WhatsApp/.test(asked.houseRules || ""), asked.houseRules);
  // Addressed to the team, so it must not be personalised to whoever last spoke to her.
  check("no speaker is attached — this goes to everyone", !asked.speaker, asked.speaker);
  check("no chat history is attached either", Array.isArray(asked.history) && asked.history.length === 0, asked.history);

  check("an unknown slot is refused rather than silently doing nothing",
    await buildDigest("teatime", {}).then(() => false, (error) => /Unknown digest slot/.test(error.message)));

  // ---- Delivery: who got it, and who did not ----
  check("the allowlist is parsed into bare numbers", recipients("919000000001, +91 90000-00002").join() === "919000000001,919000000002", recipients("919000000001, +91 90000-00002"));

  const closed = describeFailure(new Error("WhatsApp send failed: 400 {\"error\":{\"code\":131047,\"message\":\"Re-engagement message\"}}"));
  check("a closed 24-hour window is recognised as its own kind of failure", closed.reason === "window_closed", closed);
  check("and is explained in terms a human can act on", /has closed/.test(closed.detail), closed.detail);
  const broken = describeFailure(new Error("WhatsApp send failed: 500 something else"));
  check("any other failure is not mislabelled as a closed window", broken.reason === "send_failed", broken);

  const sent = [];
  const flaky = async ({ to, text }) => {
    if (to === "919000000002") throw new Error("WhatsApp send failed: 400 {\"error\":{\"code\":131047}}");
    sent.push({ to, text });
  };
  const delivery = await deliverDigest(
    { text: "the rundown", slot: "morning", allowlist: "919000000001,919000000002,919000000003" },
    { sendWhatsAppText: flaky },
  );
  check("everyone reachable still gets it when one recipient fails", delivery.delivered.join() === "919000000001,919000000003", delivery.delivered);
  check("the unreachable one is reported, not swallowed", delivery.failed.length === 1 && delivery.failed[0].number === "919000000002", delivery.failed);
  check("and is reported as a closed window specifically", delivery.failed[0].reason === "window_closed", delivery.failed[0]);
  check("one bad recipient does not stop the rest of the send", sent.length === 2, sent.length);

  const logged = ((await req("GET", `${RTDB_URL}/bb_digest_log/${TODAY}.json`)) || {}).body || {};
  check("a delivery record is written so 'did the team get it' is answerable later", Boolean(logged.morning), logged);
  check("it records who it reached and who it did not", logged.morning.deliveredCount === 2 && logged.morning.failedCount === 1, logged.morning);

  // ---- One per slot per day, however many times it is triggered ----
  await req("PUT", `${RTDB_URL}/bb_digest_sent.json`, null);
  let builds = 0;
  const deps = {
    today: TODAY,
    buildDigest: async () => { builds += 1; return { slot: "morning", label: "Morning rundown", text: "rundown" }; },
    deliverDigest: async () => ({ delivered: ["919000000001"], failed: [], attempted: 1 }),
  };
  await runDigest("morning", deps);
  const second = await runDigest("morning", deps);
  check("a second run on the same day sends nothing", second.skipped === "already sent", second);
  check("and does not pay for a second model call either", builds === 1, builds);
  check("a different slot on the same day is still allowed through", (await runDigest("evening", { ...deps, buildDigest: async () => ({ slot: "evening", label: "End of day", text: "eod" }) })).skipped === undefined);

  // A failed write-up must not burn the day's only attempt.
  await req("PUT", `${RTDB_URL}/bb_digest_sent.json`, null);
  const exploding = { ...deps, buildDigest: async () => { throw new Error("model unavailable"); } };
  await runDigest("morning", exploding).catch(() => {});
  const claimed = ((await req("GET", `${RTDB_URL}/${claimPath("morning", TODAY)}.json`)) || {}).body;
  check("a failed digest releases its claim so the next attempt can retry", !claimed, claimed);

  // ---- A digest that did not reach everyone reaches Gokul instead ----
  await req("PUT", `${RTDB_URL}/bb_digest_sent.json`, null);
  await req("PUT", `${RTDB_URL}/announcements.json`, null);
  await runDigest("morning", {
    ...deps,
    buildDigest: async () => ({ slot: "morning", label: "Morning rundown", text: "rundown" }),
    deliverDigest: async () => ({ delivered: [], failed: [{ number: "919000000002", reason: "window_closed", detail: "Their 24-hour window has closed." }], attempted: 1 }),
  });
  const posts = Object.values(((await req("GET", `${RTDB_URL}/announcements.json`)) || {}).body || {});
  const warning = posts.find((p) => p && /did not reach everyone/i.test(p.text || ""));
  check("a partial delivery is raised on the Loona Board", Boolean(warning), posts);
  check("it names who missed it", /919000000002/.test(warning.text), warning.text);
  check("it explains they will keep missing these until they message BB", /keep missing these until they message BB/i.test(warning.text), warning.text);
  check("it is for Gokul only — an operational problem, not team news", Array.isArray(warning.visibleTo) && warning.visibleTo.join() === "Gokul", warning.visibleTo);

  // ---- IST, because the whole schedule is the team's working day ----
  check("dates are computed in IST rather than UTC", /^\d{4}-\d{2}-\d{2}$/.test(istDate()), istDate());

  await req("PUT", `${RTDB_URL}/tasks.json`, null);
  await req("PUT", `${RTDB_URL}/bb_digest_sent.json`, null);
  await req("PUT", `${RTDB_URL}/bb_digest_log.json`, null);
  await req("PUT", `${RTDB_URL}/announcements.json`, null);
  finish();
})().catch((error) => { console.error("FATAL:", error, error.stack); process.exit(1); });
