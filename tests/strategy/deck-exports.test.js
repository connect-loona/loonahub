const path = require("path");
const crypto = require("crypto");
const { HUB, RTDB_URL, TEST_BEARER, check, finish } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";

const { fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const deckExport = require(path.join(HUB, "netlify/functions/strategy-deck-download.js"));
const deck = require(path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10/deck-builder.json"));
const cookie = `loona_auth=${crypto.createHash("sha256").update(process.env.BASIC_AUTH_CREDENTIALS).digest("hex")}`;

function call(format) {
  return deckExport.handler({
    httpMethod: "POST",
    headers: { cookie, authorization: `Bearer ${TEST_BEARER}` },
    body: JSON.stringify({ runId: "export-run", format }),
  });
}

(async () => {
  const enrichedDeck = { ...deck, pages: deck.pages.map((page) => ({ ...page, owner: null, productionStatus: "not_started" })) };
  await fbSet("strategy_runs/export-run", {
    runId: "export-run", brandId: "rro", month: "2026-10",
    stages: { "deck-builder": { status: "approved", checkpoint: enrichedDeck } },
  });
  delete process.env.CANVA_ACCESS_TOKEN;
  delete process.env.CANVA_BRAND_TEMPLATE_ID;
  delete process.env.CANVA_SOURCE_DESIGN_ID;

  const json = await call("json");
  const parsed = JSON.parse(json.body);
  check("JSON export succeeds without publisher configuration", json.statusCode === 200 && parsed.pages.length === deck.pages.length, json.headers);
  check("JSON export has the expected filename", /strategy-deck\.json/.test(json.headers["Content-Disposition"]), json.headers);

  const pptx = await call("pptx");
  const bytes = Buffer.from(pptx.body, "base64");
  check("PPTX export succeeds without publisher configuration", pptx.statusCode === 200 && pptx.isBase64Encoded === true, pptx.headers);
  check("PPTX export is a non-empty ZIP package", bytes.length > 10000 && bytes.subarray(0, 2).toString() === "PK", bytes.length);

  const invalid = await call("pdf");
  check("unsupported export formats are rejected", invalid.statusCode === 400, invalid.body);
  finish();
})().catch((error) => { console.error(error); process.exit(1); });
