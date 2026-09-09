// GET /.netlify/functions/strategy-deck-download?runId=<id> — generates and returns a
// .pptx for a run's finished deck, built fresh from Firebase on every request (see
// lib/strategy/pptx.js's header comment for why this exists alongside — not instead of —
// the Canva publish path). Plain GET + browser navigation (not fetch), so the same-origin
// loona_auth cookie rides along automatically; a direct link download, not a JSON API.
"use strict";
const { fbGet } = require("./lib/strategy/firebase");
const { buildDeckPptx } = require("./lib/strategy/pptx");
const { checkAuthorization } = require("./lib/strategy/auth");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: `Unauthorized — ${auth.reason}` };

  const runId = event.queryStringParameters && event.queryStringParameters.runId;
  if (!runId) return { statusCode: 400, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: "runId is required" };

  try {
    const run = await fbGet(`strategy_runs/${runId}`);
    const deckStage = run && run.stages && run.stages["deck-builder"];
    const deck = deckStage && deckStage.checkpoint;
    if (!deck) {
      return { statusCode: 404, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: "This run has no finished deck yet." };
    }

    const buffer = await buildDeckPptx(deck);
    const brandId = (run.brandId || "brand").replace(/[^a-z0-9-]/gi, "_");
    const filename = `${brandId}-${run.month || "deck"}-strategy-deck.pptx`;

    return {
      statusCode: 200,
      headers: Object.assign(cors(), {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="${filename}"`,
      }),
      isBase64Encoded: true,
      body: buffer.toString("base64"),
    };
  } catch (error) {
    console.error(`strategy-deck-download failed for run ${runId}:`, error);
    return { statusCode: 500, headers: Object.assign(cors(), { "Content-Type": "text/plain" }), body: `Could not build the deck file: ${error.message || error}` };
  }
};
