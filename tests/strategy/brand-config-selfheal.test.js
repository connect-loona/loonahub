// Verifies store.js self-heals when Firebase holds a broken cached copy of the brand
// config/month input — reproducing a real live symptom (a corrupted strategy_brands/rro
// stuck there from before a bug was fixed, missing approvedFacts/approvedClaims/
// prohibitedClaims on some products) and confirming it gets replaced with valid seed data
// instead of permanently failing every future run.
const path = require("path");
const { HUB, wipeFirebase, check, finish } = require("../harness/shared");
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const { fbSet, fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { loadBrandConfig, loadMonthInput } = require(path.join(HUB, "netlify/functions/lib/strategy/store"));

(async () => {
  await fbSet("strategy_brands", null);
  await fbSet("strategy_months", null);

  // ---- 1. Firebase holds a config that's missing required array fields on some products
  // (reproducing the exact reported error shape) ----
  const validConfig = require(path.join(HUB, "netlify/functions/lib/strategy/seed/rro.config.json"));
  const brokenConfig = JSON.parse(JSON.stringify(validConfig));
  // Strip the fields the live error named, on a few products in portfolio[1], same shape
  // as what was actually seen: "expected array, received undefined".
  for (let i = 7; i <= 13 && i < brokenConfig.portfolios[1].products.length; i++) {
    delete brokenConfig.portfolios[1].products[i].approvedFacts;
    delete brokenConfig.portfolios[1].products[i].approvedClaims;
    delete brokenConfig.portfolios[1].products[i].prohibitedClaims;
  }
  await fbSet("strategy_brands/rro", brokenConfig);

  const cfg = await loadBrandConfig("rro");
  check("loadBrandConfig recovers instead of throwing when Firebase holds a broken copy", cfg && cfg.id === "rro" && Array.isArray(cfg.portfolios[1].products[7].approvedFacts), cfg && cfg.portfolios[1].products[7]);

  const healedInFirebase = await fbGet("strategy_brands/rro");
  check("the broken copy in Firebase gets overwritten with the valid seed (self-healed, not just papered over in memory)", healedInFirebase && Array.isArray(healedInFirebase.portfolios[1].products[7].approvedFacts));

  // ---- 2. Firebase holds a genuinely valid config already — used as-is, no drama ----
  await fbSet("strategy_brands/rro", validConfig);
  const cfg2 = await loadBrandConfig("rro");
  check("a genuinely valid cached copy is accepted normally", cfg2.id === "rro");

  // ---- 3. Firebase has nothing at all — falls back to seed, same as before ----
  await fbSet("strategy_brands/rro", null);
  const cfg3 = await loadBrandConfig("rro");
  check("an empty Firebase still falls back to the seed normally", cfg3.id === "rro");

  // ---- 4. Firebase holds a month input with the wrong month declared inside it ----
  await fbSet("strategy_months", null);
  await fbSet("strategy_months/rro/2026-10", { month: "2026-09", objectives: [], campaigns: [], momentsToConsider: [], exclusions: [], notes: [] });
  const month = await loadMonthInput("rro", "2026-10");
  check("loadMonthInput recovers when the cached copy declares the wrong month", month.month === "2026-10", month.month);

  finish();
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
