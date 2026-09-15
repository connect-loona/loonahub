import firebase from "./lib/strategy/firebase.js";
import store from "./lib/strategy/store.js";
import drive from "./lib/strategy/google-drive.js";
import pipeline from "./lib/strategy/pipeline.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";

const FUNCTION_NAME = "strategy-brand-library-scan-background";
const { fbSet, fbSafeKey } = firebase;
const { loadBrandConfig } = store;
const { refreshBrandLibrary } = drive;
const { logActivity } = pipeline;

export default async function (request) {
  const body = await readSignedBackgroundBody(request, FUNCTION_NAME);
  if (!body) return;
  const brandId = String(body.brandId || "").trim();
  if (!brandId) return;
  const actor = String(body.actor || "Unknown").trim();
  try {
    const config = await loadBrandConfig(brandId);
    const library = await refreshBrandLibrary(config);
    console.log(
      `Scanned ${brandId}: ${library.fileCount} files, ${library.textFileCount} readable, ` +
      `${library.filesReadThisIndex} read now, ${library.filesFromMemory} from memory.`,
    );
    await logActivity(
      `brand-${fbSafeKey(brandId)}`,
      actor,
      "brand.library_scanned",
      `${library.textFileCount} of ${library.fileCount} files readable — ${library.filesReadThisIndex} newly read, ${library.filesFromMemory} from memory.`,
    );
  } catch (error) {
    console.error(`Brand library scan failed for ${brandId}:`, error);
    await fbSet(`strategy_brand_library/${fbSafeKey(brandId)}/scanning`, false);
    await fbSet(`strategy_brand_library/${fbSafeKey(brandId)}/scanError`, error.message || String(error));
  }
}

export const config = backgroundConfig;
