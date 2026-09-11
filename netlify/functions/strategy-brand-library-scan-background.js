// Netlify Background Function (the "-background" suffix is what makes it one: the caller
// gets an immediate 202 and this keeps running up to 15 minutes). Triggered by
// strategy-brand-library-scan.js with { brandId }.
//
// Fifteen minutes is what this needs: a first scan of a brand reads every PDF in its folder,
// and each one is a model call. Later scans are fast, because only new or changed files are
// re-read — everything else comes from memory (brand-library-memory.js).
//
// Results are written to strategy_brand_library/<brandId> by refreshBrandLibrary itself, so
// there's nothing to return; the app is already watching that node.
"use strict";
const { fbSet, fbSafeKey } = require("./lib/strategy/firebase");
const { loadBrandConfig } = require("./lib/strategy/store");
const { refreshBrandLibrary } = require("./lib/strategy/google-drive");
const { logActivity } = require("./lib/strategy/pipeline");

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const brandId = String(body.brandId || "").trim();
  if (!brandId) return { statusCode: 400, body: "brandId is required" };
  const actor = String(body.actor || "Unknown").trim();

  try {
    const config = await loadBrandConfig(brandId);
    const library = await refreshBrandLibrary(config);
    console.log(
      `Scanned ${brandId}: ${library.fileCount} files, ${library.textFileCount} readable, ` +
      `${library.filesReadThisIndex} read now, ${library.filesFromMemory} from memory.`
    );
    // logActivity writes to strategy_activity/<key>, which is keyed by runId everywhere
    // else; a scan has no run, so it gets its own brand-scoped stream rather than being
    // attached to whichever run happened to be open.
    await logActivity(
      `brand-${fbSafeKey(brandId)}`, actor, "brand.library_scanned",
      `${library.textFileCount} of ${library.fileCount} files readable — ${library.filesReadThisIndex} newly read, ${library.filesFromMemory} from memory.`
    );
  } catch (error) {
    console.error(`Brand library scan failed for ${brandId}:`, error);
    // refreshBrandLibrary only writes the library doc on success, so on failure the brand
    // would otherwise sit showing "scanning" forever. Clear the flag and keep the reason
    // where the app can show it.
    await fbSet(`strategy_brand_library/${fbSafeKey(brandId)}/scanning`, false);
    await fbSet(`strategy_brand_library/${fbSafeKey(brandId)}/scanError`, error.message || String(error));
  }
  return { statusCode: 202, body: "" };
};
