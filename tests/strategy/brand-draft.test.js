// Drafting a brand config from its Drive folder (lib/strategy/brand-draft.js), plus the
// endpoint that kicks it off.
//
// The important properties here are about honesty, not cleverness: a draft must never be
// produced from a folder nothing could be read from, the guidelines must outrank the monthly
// content plans when the prompt is assembled, and the files that COULDN'T be read have to
// reach the model so the draft can admit what it doesn't know.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { fbGet, fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { BrandDraftSchema, draftBrandFromLibrary, orderedFiles, buildInput } = require(path.join(HUB, "netlify/functions/lib/strategy/brand-draft"));
const draftEndpoint = require(path.join(HUB, "netlify/functions/strategy-brand-draft.js"));
const crypto = require("crypto");

process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;
const call = (body) => draftEndpoint.handler({
  httpMethod: "POST",
  headers: { cookie: authCookie, host: "127.0.0.1:9020", "x-forwarded-proto": "http" },
  body: JSON.stringify(body),
});

const library = {
  fileCount: 5, textFileCount: 3,
  files: [
    { name: "September Content Plan.pdf", path: "RRO/Approved work/September Content Plan.pdf", text: "Monthly posting calendar." },
    { name: "RRO Brand guidelines.pdf", path: "RRO/Brand guidelines/RRO Brand guidelines.pdf", text: "Never say 'pure'. Voice is plain and warm." },
    { name: "Thought Starters.pdf", path: "RRO/Brand guidelines/General/Thought Starters.pdf", text: "Territories we keep coming back to." },
    { name: "cover.png", path: "RRO/cover.png" },
  ],
  unreadFiles: [{ name: "Big deck.pdf", reason: "Too large to read (96MB)." }],
};

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_brands.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brand_drafts.json`, null);

  // ---- The guidelines must outrank the content plans in the prompt ----
  const ordered = orderedFiles(library);
  check("only files with text are sent", ordered.length === 3, ordered.map((f) => f.name));
  check("the brand guidelines come first, not the newest content plan", /guidelines/i.test(ordered[0].name), ordered.map((f) => f.name));
  check("the content plan sinks to last", /Content Plan/i.test(ordered[ordered.length - 1].name), ordered.map((f) => f.name));

  // ---- What couldn't be read has to reach the model, so the draft can say so ----
  const input = buildInput("RRO", library);
  check("unreadable files are declared to the model", input.filesNotRead.length === 1 && /96MB/.test(input.filesNotRead[0]), input.filesNotRead);
  check("document contents are included", input.documents[0].content.length > 0, input.documents[0].name);

  // ---- Never draft from a folder that yielded nothing ----
  let threw = null;
  try {
    await draftBrandFromLibrary({ runStage: async () => ({}) }, "Casa Waters", { files: [{ name: "a.pdf" }], unreadFiles: [] });
  } catch (e) { threw = e; }
  check("refuses to draft when nothing could be read", Boolean(threw) && /nothing to draft from/i.test(threw.message), threw && threw.message);
  check("and says what to do about it", /Re-export/i.test(threw.message), threw && threw.message);

  // ---- A real draft passes the schema through and returns what the model produced ----
  let seen = null;
  const fakeRuntime = {
    runStage: async (request) => {
      seen = request;
      return {
        category: "Cooking oil", market: ["Kerala"], aspirationalMarkets: [], website: null,
        oneLineTruth: "The oil your family already cooks with.",
        voice: { descriptors: ["plain", "warm", "direct"], principles: ["Say the thing"], bannedWords: ["pure"], bannedMoves: [] },
        audiences: [{ description: "Home cooks in Kerala", tension: "Inherited recipes never taste the same" }],
        pillars: [{ id: "recipes", name: "Recipes", intent: "Show the oil in real cooking" }],
        products: [], sources: [{ field: "voice", basis: "RRO Brand guidelines.pdf" }], gaps: ["No pricing anywhere in the folder"],
      };
    },
  };
  const draft = await draftBrandFromLibrary(fakeRuntime, "RRO", library);
  check("the draft comes back", draft.oneLineTruth.includes("family"), draft.oneLineTruth);
  check("it is schema-shaped", BrandDraftSchema.safeParse(draft).success, BrandDraftSchema.safeParse(draft).error);
  check("gaps are preserved rather than smoothed over", draft.gaps.length === 1, draft.gaps);
  check("the schema is handed to the runtime so the model is constrained", seen.outputSchema === BrandDraftSchema);
  check("no web search for a drafting pass", seen.toolProfile === "none", seen.toolProfile);

  // ---- Schema rejects a draft that skips the parts that matter ----
  const thin = BrandDraftSchema.safeParse({ category: "Oil", market: [], aspirationalMarkets: [], website: null, oneLineTruth: "", voice: { descriptors: ["a"], principles: [], bannedWords: [], bannedMoves: [] }, audiences: [], pillars: [] });
  check("a draft with no market, truth, audience or pillars is rejected", !thin.success);

  // ---- Endpoint guards ----
  const noAuth = await draftEndpoint.handler({ httpMethod: "POST", headers: { host: "x" }, body: JSON.stringify({ brandId: "casa-waters" }) });
  check("drafting requires auth", noAuth.statusCode === 401, noAuth.statusCode);

  const badId = await call({ brandId: "Casa Waters", name: "Casa", folderId: "abc" });
  check("rejects a malformed brandId", badId.statusCode === 400, badId.body);

  // An existing brand must not be silently overwritten by a draft.
  await fbSet("strategy_brands/rro", { id: "rro", name: "RRO Foods" });
  const dupe = await call({ brandId: "rro", name: "RRO Foods", folderId: "abc123" });
  check("refuses to draft over a brand that already exists", dupe.statusCode === 409, dupe.body);

  const started = await call({ brandId: "casa-waters", name: "Casa Waters", folderId: "18LlPPn68OZc2XdfIJLE0VbW4LtAkl-Ul" });
  check("starts a draft for a brand that doesn't exist yet", started.statusCode === 202, started.body);
  const stored = await fbGet("strategy_brand_drafts/casa-waters");
  check("the draft record names the folder it will read", stored.folderId === "18LlPPn68OZc2XdfIJLE0VbW4LtAkl-Ul", stored.folderId);
  // The background half ran synchronously in this harness and failed (no Drive credentials
  // here) — which is the half worth pinning: a failed draft must record why, not sit at
  // "drafting" forever.
  check("a failed draft records its reason", stored.status === "failed" && Boolean(stored.error), stored);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
