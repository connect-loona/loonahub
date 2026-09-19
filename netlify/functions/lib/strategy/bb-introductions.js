// BB meets each Loona teammate exactly once.
//
// The first time someone ever messages her on WhatsApp she introduces herself properly;
// from the next message on they are simply somebody she knows. That "once, ever" part is
// why this is stored state rather than a house rule — nothing written into a prompt can
// remember whether a given person has already been greeted, and the raw chat history only
// covers the last few messages.
//
// WhatsApp only, deliberately. The greeting's register ("Heyyy 👋", "you'll be seeing a lot
// of me around Loona Hub") is something said outside Hub, and BB's standing rule inside a
// Strategy OS session is to be formal — a social introduction landing in the middle of
// someone's brand work would be the wrong thing entirely.
"use strict";
const { fbGet, fbSet, fbSafeKey } = require("./firebase");

// Kept as close to the team's own wording as possible — this is the one message every
// person at Loona sees from BB first, so it isn't hers to improvise.
const FIRST_GREETING = `Heyyy {first_name} 👋

I’m BB 🦦 — G’s right hand at Loona.

G founded Loona. I help him run the madness — keeping an eye on what’s happening, what’s due, what’s stuck, and occasionally wondering why everything is urgent. 😭

You’ll be seeing a lot of me around Loona Hub.

Anyway… I already know your name. Now we should probably get to know each other. 👀`;

// The same introduction minus the two lines that only work when she actually knows who she
// is talking to — "I already know your name" is a strange thing to say to someone whose
// name Hub has never heard of.
const NAMELESS_GREETING = `Heyyy 👋

I’m BB 🦦 — G’s right hand at Loona.

G founded Loona. I help him run the madness — keeping an eye on what’s happening, what’s due, what’s stuck, and occasionally wondering why everything is urgent. 😭

You’ll be seeing a lot of me around Loona Hub.

Anyway… now we should probably get to know each other. 👀`;

// Only a name Hub's own roster confirmed may be used here. WhatsApp's self-reported profile
// name is not "available from Loona Hub" — it can be stale, or belong to a phone's previous
// owner — and opening a first meeting by calling somebody the wrong name is precisely the
// mixup resolveSpeaker() exists to prevent. No verified name simply means the nameless open.
function introductionPromptText(speaker) {
  const name = speaker && speaker.verified ? String(speaker.name || "").trim() : "";
  const greeting = name ? FIRST_GREETING.replace("{first_name}", name) : NAMELESS_GREETING;
  return [
    "# You are meeting this person for the first time",
    "This is the first message you have ever had from them, and you only get one first meeting with anyone. Open your reply by introducing yourself, in close to exactly these words:",
    "",
    greeting,
    "",
    "Stay close to that wording — it is how you meet everyone at Loona. You may personalise it lightly from what Hub's team directory says about their role or team, but keep this first message short.",
    "If they also asked you something, answer it after the introduction instead of ignoring what they wanted.",
    "Never invent a name, nickname, role or personal detail for them.",
    "You will never be told this again. From your next message onwards they are simply someone you know — greet them like a colleague who already works with you, and never introduce yourself to them again.",
  ].join("\n");
}

function recordPath(contactKey) {
  return `bb_introductions/${fbSafeKey(contactKey)}`;
}

// Fails toward "already met", on purpose. A missed introduction is invisible and the person
// simply gets a normal reply; re-introducing herself to somebody she has worked with for
// weeks is visibly broken. And since this runs inside the reply path, throwing here would
// cost the team an answer altogether.
async function hasMetSafe(contactKey, deps = {}) {
  const get = deps.fbGet || fbGet;
  try {
    const record = await get(recordPath(contactKey));
    return Boolean(record && record.introducedAt);
  } catch (error) {
    console.error("Could not check whether BB has met this person:", error.message);
    return true;
  }
}

// Written only once BB's introduction has actually reached them — recording the meeting
// before the message is sent would silently cost that person their only introduction.
async function markMetSafe(contactKey, speaker, deps = {}) {
  const set = deps.fbSet || fbSet;
  try {
    await set(recordPath(contactKey), {
      introducedAt: new Date().toISOString(),
      name: (speaker && speaker.name) || null,
      nameVerified: Boolean(speaker && speaker.verified),
      channel: "whatsapp",
    });
  } catch (error) { console.error("Could not record that BB has met this person:", error.message); }
}

module.exports = { hasMetSafe, markMetSafe, introductionPromptText, FIRST_GREETING, NAMELESS_GREETING };
