// Visual Studio's chat layer, and the two things it has to get right.
//
// THE SECURITY RULE. A chat records its brand once, when it's created. Every later call names
// only the chat, and the brand is read back out of the stored chat record — never taken from
// the caller. If the browser could say "generate into chat X, and by the way that's brand Y",
// one client's prompts, references and brand memory could be written into another client's
// project by nothing more than a wrong id in a request body. Most of this file exists to prove
// a caller cannot do that, including when they try on purpose.
//
// THE RULES ARE REAL. Both UI prototypes drew "locked rules" as toggles — exact product
// geometry, no label regeneration — next to sliders that map to nothing an image API accepts.
// Shipped as drawn they'd be switches that change nothing, which is worse than not having
// them: somebody trusts "no label regeneration" and sends a client a bottle with invented text
// on it. Here a rule is exactly one thing: a sentence really prepended to the prompt. So the
// checks below assert the text actually reaches the provider.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { fbGet, fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const {
  createChat, resolveChat, touchChat, listChatsForBrand, titleFromPrompt,
} = require(path.join(HUB, "netlify/functions/lib/strategy/visual-chats"));
const {
  buildRulePreamble, applyRules, brandRuleLinesFrom, selectStandardRules, STANDARD_RULES,
} = require(path.join(HUB, "netlify/functions/lib/strategy/visual-rules"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const authCookie = `loona_auth=${crypto.createHash("sha256").update("gokul:supersecret").digest("hex")}`;
const chatFn = require(path.join(HUB, "netlify/functions/visual-chat.js"));
const generateFn = require(path.join(HUB, "netlify/functions/visual-generate.js"));

function call(fn, body) {
  return fn.handler({
    httpMethod: "POST",
    headers: { cookie: authCookie, host: "127.0.0.1:9020", "x-forwarded-proto": "http" },
    body: JSON.stringify(body),
  });
}
const json = (res) => JSON.parse(res.body);

(async () => {
  await req("PUT", `${RTDB_URL}/visual_chats.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_visual.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brain.json`, null);
  await req("PUT", `${RTDB_URL}/brands.json`, { rro: { brand: "RRO Foods" }, casa: { brand: "Casa Waters" } });

  // ---- Titles name themselves from the first thing typed ----
  check("a short prompt becomes the title as-is", titleFromPrompt("Royal Indian table") === "Royal Indian table");
  check("a long prompt is cut at a word boundary, not mid-word", (() => {
    const t = titleFromPrompt("Create an editorial product photograph using this exact RRO bottle on a warm royal table");
    return t.endsWith("…") && !/\s…$/.test(t) && t.length <= 50;
  })(), titleFromPrompt("Create an editorial product photograph using this exact RRO bottle on a warm royal table"));
  check("an empty prompt still gets a usable title", titleFromPrompt("  ") === "Untitled visual chat");

  // ---- A chat carries its brand ----
  const { id: rroChat } = await createChat({ brandId: "rro", title: "Royal Indian Table", actor: "Anjali" });
  const { id: casaChat } = await createChat({ brandId: "casa", title: "Casa de Luxo blue hour", actor: "Gokul" });
  check("a chat is created with its brand recorded", (await resolveChat(rroChat)).brandId === "rro");
  check("who started it is recorded", (await resolveChat(rroChat)).createdBy === "Anjali");

  let gone = null;
  try { await resolveChat("not-a-chat"); } catch (e) { gone = e; }
  check("an unknown chat is a not-found error, not a silent empty brand", gone && gone.notFound === true, gone && gone.message);

  // ---- Listing is filtered by the brand stored on each chat ----
  const rroChats = await listChatsForBrand("rro");
  check("a brand's chats are listed", rroChats.some((c) => c.id === rroChat), rroChats.map((c) => c.title));
  check("another brand's chats are NOT in that list", !rroChats.some((c) => c.id === casaChat), rroChats.map((c) => c.title));

  // Ordering is by real activity, so a thread someone is actually working in rises.
  await touchChat(rroChat);
  const { id: quietChat } = await createChat({ brandId: "rro", title: "Quiet thread", actor: "Gokul" });
  await fbSet(`visual_chats/${quietChat}`, Object.assign({}, await fbGet(`visual_chats/${quietChat}`), { lastActivityAt: "2020-01-01T00:00:00.000Z" }));
  const ordered = await listChatsForBrand("rro");
  check("chats are ordered by real activity, not creation", ordered[ordered.length - 1].id === quietChat, ordered.map((c) => c.title));

  // ---- An untitled chat is named by its first real prompt ----
  const { id: untitled } = await createChat({ brandId: "rro", actor: "Gokul" });
  await touchChat(untitled, { titleIfUnset: "Marine Drive picnic" });
  check("an untitled chat takes the name of its first prompt", (await resolveChat(untitled)).title === "Marine Drive picnic");
  await touchChat(rroChat, { titleIfUnset: "Should not rename" });
  check("a chat that already has a name keeps it", (await resolveChat(rroChat)).title === "Royal Indian Table");
  check("activity is counted", (await resolveChat(rroChat)).generationCount >= 1, (await resolveChat(rroChat)).generationCount);

  // ---- Rules become real prompt text ----
  check("the standard rules cover the failures that make an image unusable",
    STANDARD_RULES.map((r) => r.key).join() === "product_geometry,no_label_regeneration,no_invented_claims",
    STANDARD_RULES.map((r) => r.key));
  check("a rule can be switched off", selectStandardRules(["no_invented_claims"]).length === STANDARD_RULES.length - 1);
  check("an unknown rule key is ignored rather than breaking generation",
    selectStandardRules(["not_a_rule"]).length === STANDARD_RULES.length);

  // Only lines that read as prohibitions or requirements are lifted from the guidelines — a
  // paragraph about brand values is true but useless to an image model and costs prompt room.
  const lines = brandRuleLinesFrom([
    "- Never show the cap removed from the bottle.",
    "- The brand believes in warmth and family.",
    "- Always write Primio in title case.",
    "- Our audience is urban Indian households.",
  ].join("\n"));
  check("a prohibition is lifted from the brand's guidelines", lines.some((l) => /Never show the cap/.test(l)), lines);
  check("a requirement is lifted too", lines.some((l) => /Always write Primio/.test(l)), lines);
  check("a values paragraph is not", !lines.some((l) => /believes in warmth/.test(l)), lines);

  await fbSet("strategy_brain/rro", {
    brandId: "rro",
    sections: { guidelines: { text: "- Never show the cap removed from the bottle.", fileCount: 1 } },
  });
  const built = await buildRulePreamble("rro");
  check("the brand's own rule reaches the preamble", /Never show the cap removed/.test(built.preamble), built.preamble);
  check("the standard rules do too", /Never invent, redraw or alter text/.test(built.preamble), built.preamble.slice(0, 200));
  check("what was applied is reported, so the UI can show it rather than assert it",
    built.applied.some((r) => r.source === "brand") && built.applied.some((r) => r.source === "standard"),
    built.applied.map((r) => `${r.source}:${r.key}`));

  check("the rules come before the request, so they frame it",
    applyRules("RULES HERE", "make it warmer").startsWith("RULES HERE"), applyRules("RULES HERE", "make it warmer"));
  check("no rules means the prompt is untouched", applyRules("", " make it warmer ") === "make it warmer");

  // A brand with no brain at all must still generate — standard rules only.
  const noBrain = await buildRulePreamble("casa");
  check("a brand with nothing distilled still gets the standard rules",
    noBrain.applied.length === STANDARD_RULES.length && noBrain.preamble.length > 0, noBrain.applied.length);

  // ---- THE SECURITY RULE, end to end ----
  // Stub the provider so no key or network is needed, and capture what it was sent.
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://example.com/a.png" }] }) };
  };
  process.env.OPENAI_API_KEY = "test-key-not-real";

  try {
    // The attack: a caller names Casa's chat but claims it is RRO's. The brandId in the body
    // must be ignored entirely — not merged, not preferred, not warned about.
    const crossed = await call(generateFn, { chatId: casaChat, brandId: "rro", prompt: "a villa at blue hour" });
    check("a generation into a chat succeeds", crossed.statusCode === 200, crossed.body);
    check("the brand comes from the CHAT, not the caller's brandId",
      json(crossed).brandId === "casa", json(crossed).brandId);

    const rroRecords = await fbGet("strategy_visual/rro");
    const casaRecords = await fbGet("strategy_visual/casa");
    check("nothing was written into the brand the caller named",
      !Object.values(rroRecords || {}).some((r) => /villa at blue hour/.test(r.prompt || "")), Object.keys(rroRecords || {}).length);
    check("it was written into the chat's real brand instead",
      Object.values(casaRecords || {}).some((r) => /villa at blue hour/.test(r.prompt || "")), Object.keys(casaRecords || {}).length);

    // Same rule on the read path: history is scoped by the chat's own brand.
    const hist = await call(chatFn, { action: "history", chatId: casaChat });
    check("history resolves its brand from the chat too", json(hist).chat.brandId === "casa", json(hist).chat.brandId);
    check("and returns only that chat's rounds",
      json(hist).generations.every((g) => g.chatId === casaChat), json(hist).generations.map((g) => g.chatId));

    const missingChat = await call(generateFn, { chatId: "nope", prompt: "x" });
    check("generating into a chat that doesn't exist 404s", missingChat.statusCode === 404, missingChat.body);

    // The rules really reach the provider, rather than being a label in the UI.
    const lastSent = sent[sent.length - 1];
    check("the prompt sent to the provider carries the rules",
      /Never invent, redraw or alter text/.test(lastSent.prompt), lastSent.prompt.slice(0, 160));
    check("and still contains what the person actually asked for",
      /villa at blue hour/.test(lastSent.prompt), lastSent.prompt.slice(-80));
    // The PERSON's prompt is what's remembered — the rules are identical every round, so
    // storing them would bury the one part of the record that differs.
    const casaRow = Object.values(await fbGet("strategy_visual/casa")).find((r) => /villa/.test(r.prompt));
    check("the stored prompt is what the person wrote, not the rule-prefixed version",
      casaRow.prompt === "a villa at blue hour", casaRow.prompt);
    check("but which rules applied is stored alongside it",
      (casaRow.appliedRules || []).length > 0, casaRow.appliedRules);
    check("the round is tied to its chat", casaRow.chatId === casaChat, casaRow.chatId);

    const touched = await resolveChat(casaChat);
    check("the chat's activity moves when a round lands in it", touched.generationCount === 1, touched.generationCount);

    // A one-off generation with no chat still works, and still checks the brand against Hub.
    const oneOff = await call(generateFn, { brandId: "rro", prompt: "a quick test" });
    check("a chatless generation still works", oneOff.statusCode === 200, oneOff.body);
    check("and is recorded with no chat rather than a fake one", json(oneOff).chatId === null, json(oneOff).chatId);
    const unknown = await call(generateFn, { brandId: "not-a-brand", prompt: "x" });
    check("a chatless generation for an unknown brand is still refused", unknown.statusCode === 404, unknown.body);
  } finally {
    global.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  }

  // ---- The chat endpoint ----
  const noAuth = await chatFn.handler({ httpMethod: "POST", headers: { host: "127.0.0.1:9020" }, body: JSON.stringify({ action: "list", brandId: "rro" }) });
  check("the chat endpoint requires auth", noAuth.statusCode === 401, noAuth.statusCode);

  const created = await call(chatFn, { action: "create", brandId: "rro", title: "New thread", actor: "Vishnu" });
  check("a chat can be created through the endpoint", created.statusCode === 200 && json(created).chat.brandId === "rro", created.body);

  const badBrand = await call(chatFn, { action: "create", brandId: "not-a-brand" });
  check("a chat cannot be created for a brand Hub doesn't have", badBrand.statusCode === 404, badBrand.body);

  const listed = await call(chatFn, { action: "list", brandId: "casa" });
  check("listing returns only that brand's chats",
    json(listed).chats.every((c) => c.brandId === "casa"), json(listed).chats.map((c) => c.brandId));

  const badAction = await call(chatFn, { action: "destroy", brandId: "rro" });
  check("an unknown action is refused", badAction.statusCode === 400, badAction.body);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
