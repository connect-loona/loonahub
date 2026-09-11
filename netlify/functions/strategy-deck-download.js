// Authenticated JSON/PPTX export for a finished deck. Both formats are generated directly
// from the validated checkpoint and have no third-party publishing dependency.
"use strict";
const { fbGet } = require("./lib/strategy/firebase");
const { buildDeckPptx } = require("./lib/strategy/pptx");
const { checkAuthorization } = require("./lib/strategy/auth");
const { DeckSpecSchema, PRODUCTION_STATUSES } = require("./lib/strategy/contracts");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = await checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: `Unauthorized — ${auth.reason}` };

  let request;
  try { request = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers: cors(), body: "Invalid JSON" }; }
  const runId = request.runId;
  const format = request.format || "pptx";
  if (!runId) return { statusCode: 400, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: "runId is required" };
  if (!new Set(["json", "pptx"]).has(format)) return { statusCode: 400, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: "format must be json or pptx" };

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    const deckStage = run && run.stages && run.stages["deck-builder"];
    const rawDeck = deckStage && deckStage.checkpoint;
    if (!rawDeck) {
      return { statusCode: 404, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: "This run has no finished deck yet." };
    }
    const coreDeck = DeckSpecSchema.parse({
      ...rawDeck,
      pages: rawDeck.pages.map(({ owner: _owner, productionStatus: _status, ...page }) => page),
    });
    const deck = {
      ...coreDeck,
      pages: coreDeck.pages.map((page, index) => {
        const operational = rawDeck.pages[index] || {};
        const owner = operational.owner == null ? null : String(operational.owner);
        const productionStatus = PRODUCTION_STATUSES.includes(operational.productionStatus) ? operational.productionStatus : "not_started";
        return { ...page, owner, productionStatus };
      }),
    };

    const brandId = (run.brandId || "brand").replace(/[^a-z0-9-]/gi, "_");
    const basename = `${brandId}-${run.month || "deck"}-strategy-deck`;

    if (format === "json") {
      return {
        statusCode: 200,
        headers: Object.assign(cors(), {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${basename}.json"`,
        }),
        body: JSON.stringify(deck, null, 2),
      };
    }

    const buffer = await buildDeckPptx(deck);

    return {
      statusCode: 200,
      headers: Object.assign(cors(), {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="${basename}.pptx"`,
      }),
      isBase64Encoded: true,
      body: buffer.toString("base64"),
    };
  } catch (error) {
    console.error(`strategy-deck-download failed for run ${runId}:`, error);
    return { statusCode: 500, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: `Could not build the deck file: ${error.message || error}` };
  }
};
