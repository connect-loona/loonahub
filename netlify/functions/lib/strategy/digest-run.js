// One run of one daily digest: have BB write it, send it to the team, and make sure any
// recipient it did not reach ends up somewhere Gokul will actually see it.
//
// Shared by the three scheduled functions rather than duplicated into each, so the morning,
// midday and evening messages cannot drift apart in how they handle a failure.
"use strict";
const { buildDigest, SLOTS, istDate } = require("./daily-digest");
const { deliverDigest } = require("./digest-delivery");
const { fbGet, fbSet, fbPush } = require("./firebase");

// Guards a manual re-run or a platform retry from sending the team the same rundown twice —
// the same ledger idea loona-daily-broadcast uses, keyed by slot as well as date since three
// of these go out a day.
function claimPath(slot, date) {
  return `bb_digest_sent/${date}/${slot}`;
}

// A digest that reached nobody, or only some of the team, is worth interrupting Gokul for.
// Posted to his own Loona Board rather than broadcast, since it is an operational problem
// rather than team news.
async function reportFailures({ slot, label, failed, attempted }, deps = {}) {
  const push = deps.fbPush || fbPush;
  const windowClosed = failed.filter((entry) => entry.reason === "window_closed").map((entry) => entry.number);
  const other = failed.filter((entry) => entry.reason !== "window_closed");
  const lines = [`⚠️ BB's ${label.toLowerCase()} did not reach everyone — ${failed.length} of ${attempted} failed.`];
  if (windowClosed.length) {
    lines.push(`Closed 24-hour window (they have not messaged BB since yesterday, so WhatsApp refused it): ${windowClosed.join(", ")}.`);
    lines.push("They will keep missing these until they message BB again.");
  }
  for (const entry of other) lines.push(`${entry.number}: ${entry.detail}`);
  try {
    await push("announcements", {
      id: Date.now(),
      text: lines.join("\n"),
      author: "Loona Board",
      emoji: "⚠️",
      timestamp: new Date().toISOString(),
      visibleTo: ["Gokul"],
      digestSlot: slot,
    });
  } catch (error) { console.error("Could not post the digest failure report:", error.message); }
}

async function runDigest(slotKey, deps = {}) {
  const slot = SLOTS[slotKey];
  if (!slot) throw new Error(`Unknown digest slot "${slotKey}".`);
  const get = deps.fbGet || fbGet;
  const set = deps.fbSet || fbSet;
  const build = deps.buildDigest || buildDigest;
  const deliver = deps.deliverDigest || deliverDigest;
  const date = deps.today || istDate();

  if (await get(claimPath(slotKey, date))) return { skipped: "already sent", slot: slotKey, date };
  await set(claimPath(slotKey, date), { claimedAt: new Date().toISOString() });

  let digest;
  try {
    digest = await build(slotKey, deps);
  } catch (error) {
    // Release the claim so the next scheduled attempt (or a manual re-run) can try again —
    // holding it would turn one bad model call into a silently skipped day.
    await set(claimPath(slotKey, date), null).catch(() => {});
    throw error;
  }

  const result = await deliver({
    text: digest.text, slot: slotKey,
    allowlist: deps.allowlist || process.env.WHATSAPP_ALLOWED_NUMBERS,
    accessToken: deps.accessToken || process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: deps.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
  }, deps);

  if (result.failed.length) {
    await reportFailures({ slot: slotKey, label: slot.label, failed: result.failed, attempted: result.attempted }, deps);
  }
  return { slot: slotKey, date, ...result };
}

module.exports = { runDigest, reportFailures, claimPath };
