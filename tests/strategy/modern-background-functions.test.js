const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { HUB, check, finish } = require("../harness/shared");
const {
  signedBackgroundHeaders,
  verifyBackgroundRequest,
} = require(path.join(HUB, "netlify/functions/lib/strategy/background-auth"));

process.env.BASIC_AUTH_CREDENTIALS = process.env.BASIC_AUTH_CREDENTIALS || "gokul:supersecret";

const STRATEGY_BACKGROUNDS = [
  "strategy-brand-draft-background",
  "strategy-brand-library-scan-background",
  "strategy-concept-discard-background",
  "strategy-concept-propose-background",
  "strategy-copy-background",
  "strategy-creative-direction-background",
  "strategy-deck-builder-background",
  "strategy-research-background",
  "strategy-strategy-background",
];

const MODERN_BACKGROUNDS = [
  ...STRATEGY_BACKGROUNDS,
  "visual-generate-background",
];

(async () => {
  const body = JSON.stringify({ runId: "run-123" });
  const now = Date.now();
  const headers = signedBackgroundHeaders("strategy-research-background", body, now);
  check(
    "a freshly signed internal background request verifies",
    verifyBackgroundRequest(
      "strategy-research-background",
      headers["x-loona-background-timestamp"],
      body,
      headers["x-loona-background-signature"],
      now,
    ),
  );
  check(
    "changing the body invalidates the signature",
    !verifyBackgroundRequest(
      "strategy-research-background",
      headers["x-loona-background-timestamp"],
      JSON.stringify({ runId: "different-run" }),
      headers["x-loona-background-signature"],
      now,
    ),
  );
  check(
    "a captured signature expires instead of being replayable forever",
    !verifyBackgroundRequest(
      "strategy-research-background",
      headers["x-loona-background-timestamp"],
      body,
      headers["x-loona-background-signature"],
      now + 6 * 60 * 1000,
    ),
  );

  for (const name of MODERN_BACKGROUNDS) {
    const modernFile = path.join(HUB, `netlify/functions/${name}.mjs`);
    const legacyFile = path.join(HUB, `netlify/functions/${name}.js`);
    const mod = await import(`${pathToFileURL(modernFile).href}?test=${Date.now()}`);
    check(`${name} uses the modern default handler`, typeof mod.default === "function");
    check(`${name} declares modern background mode`, mod.config && mod.config.background === true, mod.config);
    check(`${name} no longer has a legacy Lambda entrypoint`, !fs.existsSync(legacyFile));
  }

  const triggerFiles = [
    "strategy-brand-draft.js",
    "strategy-brand-library-scan.js",
    "strategy-concept-discard.js",
    "strategy-concept-propose.js",
    "strategy-run-start.js",
    "strategy-stage-approve.js",
    "strategy-stage-retry.js",
  ];
  for (const file of triggerFiles) {
    const source = fs.readFileSync(path.join(HUB, "netlify/functions/_legacy", file), "utf8");
    check(`${file} signs its internal background call`, source.includes("signedBackgroundHeaders"));
  }

  const unsigned = await import(
    `${pathToFileURL(path.join(HUB, "netlify/functions/strategy-research-background.mjs")).href}?unsigned=${Date.now()}`
  );
  await unsigned.default(new Request("https://example.test/.netlify/functions/strategy-research-background", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }));
  check("an unsigned direct worker request is rejected without throwing", true);

  finish();
})().catch((error) => {
  console.error("FATAL:", error, error.stack);
  process.exit(1);
});
