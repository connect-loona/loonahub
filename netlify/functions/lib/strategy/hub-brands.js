// "Does Hub know this brand?" — asked the same way everywhere.
//
// Hub's `brands` node is keyed by arbitrary push ids (b1, -N4x...), with the human name in a
// `brand` field. Strategy OS and Visual Studio both key by a slug of that name ("rro-foods").
// So checking `brands/<brandId>` directly always misses — the key is never the slug — and a
// caller ends up told a brand doesn't exist when Hub knows it perfectly well.
//
// Every place that needs this join now goes through here, so there is one rule rather than
// four subtly different ones. It's the same slug the Drive folder matcher and the task-board
// join already use (google-drive.js's slugForFolder, team-activity.js) — a brand that resolves
// one way resolves them all.
"use strict";
const { fbGet, fbSafeKey } = require("./firebase");

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Returns { id, name, inactive } for a brand Hub knows, or null. Strategy OS's own
// strategy_brands entry counts too: a brand fully configured there is unambiguously real, and
// requiring it to also be live in Hub would break the brands onboarded before Hub's roster
// became the source of truth.
async function findHubBrand(brandId) {
  const wanted = slug(brandId);
  if (!wanted) return null;

  const hub = (await fbGet("brands")) || {};
  for (const record of Object.values(hub)) {
    if (!record || !record.brand) continue;
    if (slug(record.brand) === wanted) {
      return { id: wanted, name: record.brand, inactive: Boolean(record.inactive) };
    }
  }

  const configured = await fbGet(`strategy_brands/${fbSafeKey(brandId)}`);
  if (configured) return { id: wanted, name: configured.name || brandId, inactive: false };

  return null;
}

async function hubBrandExists(brandId) {
  return Boolean(await findHubBrand(brandId));
}

module.exports = { findHubBrand, hubBrandExists, slug };
