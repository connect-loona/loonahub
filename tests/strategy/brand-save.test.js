// Tests strategy-brand-save.js's own validation directly (no HTTP layer needed — it's a
// pure handler({ httpMethod, headers, body }) call). Since "Normalize brand onboarding
// configurations on server" the endpoint no longer validates a caller-supplied full
// BrandConfigSchema object: it takes a handful of simple onboarding fields (name, category,
// market, driveFolderUrl, deliverables, ...), rebuilds a normalized, always-schema-valid
// config from them server-side, and writes that. So the only ways left to reject a save are
// auth, the brandId format, and the two fields this endpoint still requires explicitly
// (driveFolderUrl, at least one deliverable) — everything else gets a placeholder default
// or is silently dropped rather than causing a validation error.
const path = require("path");
const { HUB, RTDB_URL } = require("../harness/shared");
process.env.FIREBASE_DB_URL = RTDB_URL;
process.env.BASIC_AUTH_CREDENTIALS = "gokul:supersecret";
const crypto = require("crypto");
const { fbSet, fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const brandSave = require(path.join(HUB, "netlify/functions/_legacy/strategy-brand-save.js"));

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}
const token = crypto.createHash("sha256").update("gokul:supersecret").digest("hex");
const authCookie = `loona_auth=${token}`;

(async () => {
  await fbSet("strategy_brands/test-brand", null);

  const onboarding = {
    id: "test-brand",
    name: "Test Brand",
    category: "Test category",
    market: ["Test market"],
    driveFolderUrl: "https://drive.google.com/drive/folders/test-brand-folder",
    deliverables: { reel: 4, carousel: 2 },
  };

  // ---- Unauthenticated request rejected ----
  const noAuth = await brandSave.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ brandId: "test-brand", config: onboarding }) });
  check("rejects an unauthenticated request", noAuth.statusCode === 401);

  // ---- A brand Google Drive folder link is still required ----
  const noFolder = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie }, body: JSON.stringify({ brandId: "test-brand", config: Object.assign({}, onboarding, { driveFolderUrl: "" }) }) });
  check("rejects a config with no Google Drive folder link", noFolder.statusCode === 422, noFolder.body);
  check("names the missing folder link specifically", JSON.parse(noFolder.body).error === "A brand Google Drive folder link is required.", noFolder.body);

  // ---- At least one deliverable above zero is still required ----
  const noDeliverables = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie }, body: JSON.stringify({ brandId: "test-brand", config: Object.assign({}, onboarding, { deliverables: { reel: 0, carousel: 0 } }) }) });
  check("rejects a config with no deliverable above zero", noDeliverables.statusCode === 422, noDeliverables.body);

  // ---- A valid onboarding submission saves successfully ----
  const ok = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie }, body: JSON.stringify({ brandId: "test-brand", config: onboarding }) });
  check("a valid config saves successfully", ok.statusCode === 200, ok.body);
  const saved = await fbGet("strategy_brands/test-brand");
  check("the config actually landed in Firebase", saved && saved.name === "Test Brand");
  check("the submitted market and driveFolderUrl are kept", saved && saved.market[0] === "Test market" && saved.driveFolderUrl === onboarding.driveFolderUrl, saved);
  check("the submitted deliverable counts are kept", saved && saved.deliverables.reel === 4 && saved.deliverables.carousel === 2, saved && saved.deliverables);

  // ---- The saved config is always written under the URL's brandId, regardless of what
  // config.id the caller sent — normalizeConfig rebuilds the record from scratch and never
  // reads config.id back out of the submitted body. ----
  const mismatch = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie }, body: JSON.stringify({ brandId: "test-brand", config: Object.assign({}, onboarding, { id: "other-id" }) }) });
  check("a mismatched config.id is normalized away rather than rejected", mismatch.statusCode === 200, mismatch.body);
  const afterMismatch = await fbGet("strategy_brands/test-brand");
  check("the saved config's id is always the brandId from the URL", afterMismatch && afterMismatch.id === "test-brand", afterMismatch && afterMismatch.id);

  // ---- Omitted optional fields fall back to clear placeholders, not blanks ----
  const minimal = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie }, body: JSON.stringify({ brandId: "test-brand", config: { driveFolderUrl: onboarding.driveFolderUrl, deliverables: { reel: 1 } } }) });
  check("a minimal config (only the two required fields) still saves", minimal.statusCode === 200, minimal.body);
  const minimalSaved = await fbGet("strategy_brands/test-brand");
  check("name falls back to the brandId when omitted", minimalSaved && minimalSaved.name === "test-brand", minimalSaved && minimalSaved.name);
  check("category falls back to a clear placeholder when omitted", minimalSaved && minimalSaved.category === "To be defined", minimalSaved && minimalSaved.category);
  check("market falls back to a clear placeholder when omitted", minimalSaved && Array.isArray(minimalSaved.market) && minimalSaved.market[0] === "To be defined", minimalSaved && minimalSaved.market);

  // ---- Unknown top-level fields are dropped, not rejected — normalizeConfig only ever
  // copies the fields it knows about into the record it builds. ----
  const withExtra = await brandSave.handler({ httpMethod: "POST", headers: { cookie: authCookie }, body: JSON.stringify({ brandId: "test-brand", config: Object.assign({}, onboarding, { notARealField: "oops" }) }) });
  check("an unknown top-level field does not cause a rejection", withExtra.statusCode === 200, withExtra.body);
  const extraSaved = await fbGet("strategy_brands/test-brand");
  check("the unknown field is dropped rather than stored", extraSaved && !("notARealField" in extraSaved), extraSaved);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
