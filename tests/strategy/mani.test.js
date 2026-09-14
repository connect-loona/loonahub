// 🧠 Mani — the brand memory agent.
//
// Almost everything here guards ONE failure mode. Whatever Mani says gets treated as
// established fact about a client, so a memory agent that invents is strictly worse than no
// memory agent at all: it launders a guess into "what we know about RRO". An honest "we never
// recorded that" is the valuable answer, not the disappointing one.
//
// So: he must be given only the brand's own memory, he must be instructed never to supply
// general knowledge, and "nothing recorded" has to stay mechanically distinguishable from a
// real answer — otherwise an empty result gets pasted into a brief as a finding.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { askMani, instructions, NOTHING_RECORDED, MAX_QUESTION_CHARS } = require(path.join(HUB, "netlify/functions/lib/strategy/mani"));
const { supportAgent, STAGE_ORDER, assertCompleteRegistry } = require(path.join(HUB, "netlify/functions/lib/strategy/agents/agent-registry"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const authCookie = `loona_auth=${crypto.createHash("sha256").update("gokul:supersecret").digest("hex")}`;
const ask = require(path.join(HUB, "netlify/functions/strategy-mani-ask.js"));

function call(body) {
  return ask.handler({
    httpMethod: "POST",
    headers: { cookie: authCookie, host: "127.0.0.1:9020", "x-forwarded-proto": "http" },
    body: JSON.stringify(body),
  });
}
const json = (res) => JSON.parse(res.body);

function fakeClient(log, reply) {
  return {
    messages: {
      create: async (params) => {
        log.push({ system: params.system, user: params.messages[0].content, model: params.model });
        return { content: [{ type: "text", text: reply === undefined ? "Reels under 15s tripled saves in August and September (performance reports)." : reply }] };
      },
    },
  };
}

const MEMORY = [
  "# What we know about this brand",
  "- Never show the cap removed from the bottle.",
  "# What actually worked",
  "- Reels under 15s: 4.2x saves vs static, August and September.",
].join("\n");

(async () => {
  await req("PUT", `${RTDB_URL}/brands.json`, { "-Nx1": { brand: "RRO Foods" } });

  // ---- Mani is a support agent, not a pipeline stage ----
  // He owns no step of a run, nothing downstream waits on him, and he has no checkpoint to
  // approve. A run whose memory lookup fails is a run with less context, not a broken run.
  const mani = supportAgent("brain");
  check("Mani is registered as a real agent", mani && mani.name === "Mani", mani && mani.displayName);
  check("and is deliberately NOT a pipeline stage", !STAGE_ORDER.includes("brain"), STAGE_ORDER);
  check("he holds no tools — he answers from memory, he doesn't go and look things up",
    Array.isArray(mani.tools) && mani.tools.length === 0, mani.tools);
  check("the registry still validates with him in it", assertCompleteRegistry() === true);

  // ---- What he is told ----
  const system = instructions();
  check("his soul reaches his instructions", /Mani — Brand memory agent soul/.test(system), system.slice(0, 80));
  // The single most important line in the whole feature.
  check("he is told he has no general knowledge of the brand",
    /no general knowledge of this brand/.test(system), system);
  check("and that a gap must never be softened into an inference",
    /is not “reels probably did fine”|not 'reels probably did fine'|Never soften a gap/.test(system), system);
  check("and exactly how to say 'nothing recorded', so it stays detectable",
    new RegExp(NOTHING_RECORDED).test(system), NOTHING_RECORDED);

  // ---- A real question ----
  const log = [];
  const answered = await askMani(
    { brandId: "rro-foods", brandName: "RRO Foods", question: "Did short reels work?", memory: MEMORY },
    { client: fakeClient(log) },
  );
  check("he answers from the memory", answered.grounded === true && /tripled saves/.test(answered.answer), answered.answer);
  check("the brand's memory is what he was given", /4.2x saves/.test(log[0].user), log[0].user.slice(0, 200));
  check("along with the question", /Did short reels work\?/.test(log[0].user), log[0].user.slice(-80));
  check("and the brand's name, so he can attribute it", /RRO Foods/.test(log[0].user), log[0].user.slice(0, 60));
  // Judgement, not compression — deciding what in a long memory answers the question, and
  // being honest when none of it does. Worth more than the economy tier.
  check("he runs on a reasoning model, not the cheap extraction tier", !/haiku/.test(log[0].model), log[0].model);

  // ---- "Nothing recorded" is a first-class answer ----
  const blank = await askMani(
    { brandId: "rro-foods", question: "What is their Diwali budget?", memory: MEMORY },
    { client: fakeClient([], `${NOTHING_RECORDED}\nNo campaign budget has ever been recorded for this brand.`) },
  );
  check("a gap is reported as a gap, not as an answer", blank.nothingRecorded === true && blank.answer === null, blank);
  check("and it says what would have to exist for the answer to", /No campaign budget/.test(blank.detail), blank.detail);
  // Grounded is still true: refusing to guess IS the correct grounded behaviour.
  check("refusing to guess still counts as grounded", blank.grounded === true, blank.grounded);

  // A brand nobody has scanned yet doesn't need a model call at all to know the answer.
  const empty = await askMani({ brandId: "new-brand", brandName: "New Brand", question: "anything?", memory: null });
  check("a brand with no memory is answered without spending a model call",
    empty.nothingRecorded === true && empty.answer === null, empty);
  check("and is told how to fix it", /Scan its Drive folder/.test(empty.detail), empty.detail);

  let noQuestion = null;
  try { await askMani({ brandId: "rro-foods", question: "  ", memory: MEMORY }); } catch (e) { noQuestion = e.message; }
  check("an empty question is refused", /needs a question/.test(noQuestion || ""), noQuestion);

  // ---- Asked with no brand at all: the Hub-wide scope ----
  // The questions people actually ask belong to no single brand, so demanding one up front
  // makes them unanswerable. "What is Anjali working on?" is the normal case, not the edge.
  const wideLog = [];
  const wide = await askMani(
    { question: "Who is working on what?", memory: "# What is happening across Loona right now\n## RRO Foods\nWorking on it: Anjali.", scope: "hub" },
    { client: fakeClient(wideLog) },
  );
  check("he can be asked without naming a brand", wide.grounded === true, wide);
  check("and is told he's being asked about Loona as a whole",
    /about Loona as a whole, not one brand/.test(wideLog[0].user), wideLog[0].user.slice(0, 120));
  // Otherwise he answers a deep question from a shallow summary and sounds confident doing it.
  check("and told to name a brand rather than guess when depth is needed",
    /say which brand to ask about rather than guessing/.test(wideLog[0].user), wideLog[0].user);
  check("the scope comes back so the caller knows which he answered", wide.scope === "hub", wide.scope);

  // An empty Hub is a different sentence from an unscanned brand — telling somebody to scan a
  // Drive folder when the question was "what's happening?" would be the wrong advice.
  const emptyHub = await askMani({ question: "anything?", memory: null, scope: "hub" });
  check("an empty Hub says so in its own words, not a brand's",
    emptyHub.nothingRecorded === true && /across Hub/.test(emptyHub.detail), emptyHub.detail);

  // ---- The endpoint ----
  const noAuth = await ask.handler({ httpMethod: "POST", headers: { host: "127.0.0.1:9020" }, body: JSON.stringify({ brandId: "rro-foods", question: "x" }) });
  check("asking Mani requires auth — it reads a client's accumulated memory", noAuth.statusCode === 401, noAuth.statusCode);

  const badBrand = await call({ brandId: "Nope!", question: "x" });
  check("a malformed brandId is refused", badBrand.statusCode === 400, badBrand.body);

  const unknown = await call({ brandId: "not-a-brand", question: "x" });
  check("a brand Hub doesn't have is refused", unknown.statusCode === 404, unknown.body);

  // Omitting brandId is legitimate, not a validation error — it's how you ask about the studio.
  const wideCall = await call({ question: "what's happening?" });
  check("the endpoint accepts a question with no brand at all",
    wideCall.statusCode !== 400, { status: wideCall.statusCode, body: wideCall.body.slice(0, 120) });

  const noQ = await call({ brandId: "rro-foods", question: "" });
  check("an empty question is refused by the endpoint too", noQ.statusCode === 400, noQ.body);

  const tooLong = await call({ brandId: "rro-foods", question: "x".repeat(MAX_QUESTION_CHARS + 1) });
  check("an over-long question is refused with the limit named", tooLong.statusCode === 400 && new RegExp(String(MAX_QUESTION_CHARS)).test(json(tooLong).error), json(tooLong).error);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
