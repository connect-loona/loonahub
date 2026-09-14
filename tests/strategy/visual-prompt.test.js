// The prompt rewrite — the single biggest thing standing between this and what the team gets
// from ChatGPT today.
//
// The image model is the same one ChatGPT uses. What ChatGPT does that a bare API call doesn't
// is rewrite your words before generating: type "make the table warmer" and the image model
// never sees that phrase — it sees a paragraph reconstructing the scene, the product, the
// light and the framing, with the change applied. Send the four words raw and you get a
// correspondingly worse image from the identical engine.
//
// So the two things worth guarding here are: the rewriter is actually GIVEN what it needs (the
// thread, the brand's memory, what each reference is for), and a failure in it never blocks
// somebody from generating — a worse image beats no image every time.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const {
  expandPrompt, historyForPrompt, MAX_HISTORY_TURNS,
} = require(path.join(HUB, "netlify/functions/lib/strategy/visual-prompt"));

function fakeClient(log, reply) {
  return {
    messages: {
      create: async (params) => {
        log.push({ system: params.system, user: params.messages[0].content, model: params.model });
        return { content: [{ type: "text", text: reply === undefined ? "A long, specific rewritten prompt." : reply }] };
      },
    },
  };
}

(async () => {
  // ---- The thread, as the rewriter reads it ----
  const rounds = [
    { prompt: "Primio bottle on a marble counter", createdAt: "2026-09-10T00:00:00Z", pickedIndex: 1, pickNote: "cleaner label read" },
    { prompt: "same but a wider crop", createdAt: "2026-09-10T00:05:00Z", pickedIndex: null },
  ];
  const history = historyForPrompt(rounds);
  check("the conversation is given oldest-first, the way it happened",
    history.indexOf("marble counter") < history.indexOf("wider crop"), history);
  // A pick is the part that says which direction the thread actually went — without it the
  // rewriter can't tell an accepted round from a rejected one.
  check("what they kept is included", /kept take 2/.test(history), history);
  check("and why they kept it", /cleaner label read/.test(history), history);
  check("a round nobody kept says so rather than looking accepted",
    /didn't keep any of these/.test(history), history);

  const many = Array.from({ length: 20 }, (_, i) => ({ prompt: `round ${i}`, createdAt: `2026-09-10T00:${String(i).padStart(2, "0")}:00Z`, pickedIndex: null }));
  const trimmed = historyForPrompt(many);
  check("a long thread is trimmed to the most recent turns", trimmed.split("\n").length === MAX_HISTORY_TURNS, trimmed.split("\n").length);
  check("and keeps the LATEST ones, not the oldest", /round 19/.test(trimmed) && !/round 0"/.test(trimmed), trimmed.slice(-80));

  check("an empty thread is simply empty", historyForPrompt([]) === "");

  // ---- What the rewriter is actually given ----
  const log = [];
  const result = await expandPrompt({
    prompt: "make the table warmer",
    history,
    brandBrain: "# What we know\n- RRO's approved work is warm and domestic.",
    brandRules: [{ key: "no_label_regeneration", label: "No label regeneration" }],
    referenceRoles: ["Product identity", ""],
  }, { client: fakeClient(log) });

  check("the prompt is rewritten", result.expanded === true && result.prompt === "A long, specific rewritten prompt.", result);
  const sent = log[0].user;
  check("the rewriter is given what the designer typed", /make the table warmer/.test(sent), sent.slice(-120));
  check("and the conversation it belongs to", /marble counter/.test(sent), sent.slice(0, 200));
  check("and what the brand's memory says", /warm and domestic/.test(sent), sent.slice(0, 200));
  check("and the rules it must not contradict", /No label regeneration/.test(sent), sent.slice(0, 300));
  check("and what each attached reference is for", /Reference 1: Product identity/.test(sent), sent);
  check("a reference with no stated role asks the model to infer it rather than dropping it",
    /Reference 2: \(not specified — infer it\)/.test(sent), sent);

  // The instruction that does the actual work: resolving "make the table warmer" into a whole
  // scene, and keeping everything the designer didn't ask to change.
  check("it is told to resolve references to earlier turns", /Resolve every reference to earlier turns/.test(log[0].system), log[0].system.slice(0, 400));
  check("and to carry forward what wasn't asked to change", /they want kept/.test(log[0].system), log[0].system);
  check("and never to contradict the brand's rules", /Never contradict them/.test(log[0].system), log[0].system);
  check("and to output the prompt only, with no preamble", /Output the prompt only/.test(log[0].system), log[0].system);

  // In front of every single generation, so it has to be cheap.
  check("the rewrite runs on the economy tier", /haiku/.test(log[0].model), log[0].model);

  // ---- It must never block a generation ----
  // A worse image is far better than no image: nobody should be stopped from generating
  // because a helper step had a bad minute.
  const broken = await expandPrompt(
    { prompt: "make the table warmer" },
    { client: { messages: { create: async () => { throw new Error("model exploded"); } } } },
  );
  check("a failed rewrite falls back to exactly what the person typed",
    broken.prompt === "make the table warmer" && broken.expanded === false, broken);
  check("and records why, for the logs", /model exploded/.test(broken.reason || ""), broken.reason);

  const empty = await expandPrompt({ prompt: "make the table warmer" }, { client: fakeClient([], "") });
  check("an empty rewrite falls back too rather than sending nothing",
    empty.prompt === "make the table warmer" && empty.expanded === false, empty);

  // No key configured is a normal state, not a failure — the app still generates.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedClaude = process.env.CLAUDE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
  const noKey = await expandPrompt({ prompt: "make the table warmer" });
  check("with no key the person's own words are used, and nothing breaks",
    noKey.prompt === "make the table warmer" && noKey.expanded === false, noKey);
  check("and it says why", /No Anthropic key/.test(noKey.reason || ""), noKey.reason);
  if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedClaude) process.env.CLAUDE_API_KEY = savedClaude;

  const blank = await expandPrompt({ prompt: "   " }, { client: fakeClient([]) });
  check("an empty prompt isn't sent for rewriting at all", blank.expanded === false, blank);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
