// Lets BB draft (never send) a real Gmail email from conversation, on Hub and WhatsApp — same
// two callers as bb-task-actions.js/bb-calendar-actions.js.
//
// The sender is NEVER a model-supplied field, for the same reason a meeting's organizer isn't:
// it is always ctx.speakerName, the actual verified person BB is talking to — never someone she
// merely names. This only ever creates a DRAFT, sitting unsent in that person's own Gmail
// Drafts folder for them to review, edit and send by hand — there is no send_email tool at all.
"use strict";
const { createDraft } = require("../gmail-actions");
const { looksLikeConfirmation } = require("./bb-task-actions");

const EMAIL_ACTION_TOOLS = [
  {
    name: "draft_email",
    description: "Create a real Gmail draft, saved in the sender's own Drafts folder — this never sends anything. You are always the sender yourself, the same rule as booking a meeting — never ask whose inbox to draft it in, and never accept a sender from anywhere else. Write the actual subject and body yourself (suggest real wording, don't ask the team to write it for you), and confirm the recipients, cc and your drafted text with them before calling this — only call it once they've confirmed in their NEXT message.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipients — a Hub teammate's first name, or a raw email address for anyone outside Loona. At least one is required." },
        cc: { type: "array", items: { type: "string" }, description: "Anyone to cc, same rules as to. Ask whether anyone should be cc'd — don't assume nobody should be." },
        subject: { type: "string" },
        body: { type: "string", description: "The actual email text, written out in full — not a summary of what to write." },
      },
      required: ["to", "subject", "body"],
    },
  },
];

async function draftEmailAction(input, ctx, deps) {
  const sender = ctx.speakerName;
  if (!sender) throw new Error("I don't have a confirmed identity for whoever I'm talking to, so I can't draft this from a real inbox — ask them to try again once Hub/WhatsApp can verify who they are.");
  return createDraft({ senderName: sender, to: input.to, cc: input.cc, subject: input.subject, body: input.body }, deps);
}

// The one gate every write goes through, exactly the same shape as bb-task-actions.js's own
// executeTaskAction — a draft never lands until this turn's own message actually reads as a
// confirmation.
async function executeEmailAction(name, input, ctx = {}, deps = {}) {
  if (name === "draft_email") {
    if (!ctx.confirmed) {
      return {
        ok: false,
        needsConfirmation: true,
        message: "Not done — the team has not yet confirmed this draft in their own message. Show them the subject, recipients, cc and full text you're about to draft and wait for them to say yes before calling this again.",
      };
    }
    const result = await draftEmailAction(input, ctx, deps);
    return { ok: true, draft: result };
  }
  throw new Error(`Unknown email action tool "${name}".`);
}

module.exports = { EMAIL_ACTION_TOOLS, executeEmailAction, draftEmailAction, looksLikeConfirmation };
