// Tests strategy-brand-save.js's own validation directly (no HTTP layer needed — it's a
// pure handler({ httpMethod, headers, body }) call): auth, brandId/config.id mismatch, a
// valid save actually landing in Firebase, and Zod's strict-schema + min-length
// enforcement rejecting malformed configs with specific, useful per-field errors.
const path = require("path");
const { HUB, RTDB_URL } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const crypto = require("crypto");
const { fbSet, fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const brandSave = require(path.join(HUB, "netlify/functions/strategy-brand-save.js"));

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;

(async () => {
  await fbSet("strategy_brands/test-brand", null);

  const validConfig = require(path.join(HUB, "netlify/functions/lib/strategy/seed/rro.config.json"));
  const newBrand = JSON.parse(JSON.stringify(validConfig));
  newBrand.id = "test-brand";
  newBrand.name = "Test Brand";

  // ---- Unauthenticated request rejected ----
  const noAuth = await brandSave.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ brandId: "test-brand", config: newBrand }) });
  check("rejects an unauthenticated request", noAuth.statusCode === 401);

  // ---- brandId/config.id mismatch rejected ----
  const mismatch = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie, authorization: "Bearer test:gokul%40loona.in:Gokul:gokul-fake-uid" }, body: JSON.stringify({ brandId: "test-brand", config: Object.assign({}, newBrand, { id: "other-id" }) }) });
  check("rejects a brandId/config.id mismatch", mismatch.statusCode === 400, mismatch.body);

  // ---- Valid config saves successfully ----
  const ok = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie, authorization: "Bearer test:gokul%40loona.in:Gokul:gokul-fake-uid" }, body: JSON.stringify({ brandId: "test-brand", config: newBrand }) });
  check("a valid config saves successfully", ok.statusCode === 200, ok.body);
  const saved = await fbGet("strategy_brands/test-brand");
  check("the config actually landed in Firebase", saved && saved.name === "Test Brand");

  const staleClientConfig = { ...newBrand, canva: { enabled: true, token: "must-not-survive" } };
  const staleSave = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie, authorization: "Bearer test:gokul%40loona.in:Gokul:gokul-fake-uid" }, body: JSON.stringify({ brandId: "test-brand", config: staleClientConfig }) });
  check("one stale client can save during rollout", staleSave.statusCode === 200, staleSave.body);
  check("retired publisher configuration is never persisted", !Object.prototype.hasOwnProperty.call(await fbGet("strategy_brands/test-brand"), "canva"));

  // ---- Missing required min-length fields get a clear, specific error ----
  const broken = JSON.parse(JSON.stringify(newBrand));
  broken.market = []; // min 1 required
  broken.voice.descriptors = ["only-one"]; // min 3 required
  broken.pillars = []; // min 1 required
  const bad = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie, authorization: "Bearer test:gokul%40loona.in:Gokul:gokul-fake-uid" }, body: JSON.stringify({ brandId: "test-brand", config: broken }) });
  const badBody = JSON.parse(bad.body);
  check("an invalid config (too-short required arrays) is rejected with 422", bad.statusCode === 422);
  check("the response lists specific per-field issues, not just a generic message", Array.isArray(badBody.issues) && badBody.issues.some((i) => i.path === "market") && badBody.issues.some((i) => i.path === "pillars"), badBody.issues && badBody.issues.map((i) => i.path));

  // ---- Extra/unknown fields rejected (schema is .strict() at every level) ----
  const withExtra = JSON.parse(JSON.stringify(newBrand));
  withExtra.notARealField = "oops";
  const extraRes = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie, authorization: "Bearer test:gokul%40loona.in:Gokul:gokul-fake-uid" }, body: JSON.stringify({ brandId: "test-brand", config: withExtra }) });
  check("rejects an unknown top-level field (strict schema)", extraRes.statusCode === 422);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
