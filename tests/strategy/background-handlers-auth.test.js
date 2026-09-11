const path = require("path");
const { HUB, check, finish } = require("../harness/shared");

const handlers = [
  "research", "strategy", "copy", "creative-direction", "deck-builder",
  "concept-propose", "concept-discard",
];

(async () => {
  for (const name of handlers) {
    const mod = require(path.join(HUB, `netlify/functions/strategy-${name}-background.js`));
    const response = await mod.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ runId: "unsigned" }) });
    check(`${name} background handler rejects unsigned calls`, response.statusCode === 401, response);
  }
  finish();
})().catch((error) => { console.error(error); process.exit(1); });
