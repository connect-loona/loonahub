// Netlify Background Function. Reads a Drive brand folder and drafts a brand config from it.
// Triggered by strategy-brand-draft.js with { brandId, name, folderId }.
//
// Two slow steps, which is why this isn't synchronous: indexing the folder (every PDF is a
// model call the first time — later drafts reuse that memory, see brand-library-memory.js),
// then one more call to turn what was read into a draft config.
"use strict";
const { fbSet, fbSafeKey } = require("./lib/strategy/firebase");
const { buildLibrary } = require("./lib/strategy/google-drive");
const { createRuntime } = require("./lib/strategy/pipeline");
const { draftBrandFromLibrary } = require("./lib/strategy/brand-draft");

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const brandId = String(body.brandId || "").trim();
  const name = String(body.name || "").trim();
  const folderId = String(body.folderId || "").trim();
  if (!brandId || !name || !folderId) return { statusCode: 400, body: "brandId, name and folderId are required" };

  const draftPath = `strategy_brand_drafts/${fbSafeKey(brandId)}`;
  try {
    // A stand-in config, enough for buildLibrary: the folder link points it straight at this
    // folder, and the id keys the file memory. Using the real brandId here means the reading
    // done for the draft is the same memory the brand's runs use once it's saved — the work
    // isn't thrown away.
    const library = await buildLibrary({
      id: brandId,
      name,
      driveFolderUrl: `https://drive.google.com/drive/folders/${folderId}`,
    });

    // Drafting is judgement about a client's brand, not assembly — standard tier, and the
    // usual failover if a provider is down.
    const runtime = createRuntime({ runtime: "openai" }, "strategy");
    const draft = await draftBrandFromLibrary(runtime, name, library);

    await fbSet(draftPath, {
      brandId, name, folderId,
      status: "ready",
      draft,
      readFrom: {
        fileCount: library.fileCount,
        textFileCount: library.textFileCount,
        unreadFiles: library.unreadFiles || [],
      },
      servedBy: runtime.servedBy || null,
      completedAt: new Date().toISOString(),
      error: null,
    });
    console.log(`Drafted ${name} from ${library.textFileCount}/${library.fileCount} readable files.`);
  } catch (error) {
    console.error(`Brand draft failed for ${brandId}:`, error);
    await fbSet(draftPath, {
      brandId, name, folderId,
      status: "failed",
      error: error.message || String(error),
      draft: null,
      completedAt: new Date().toISOString(),
    });
  }
  return { statusCode: 202, body: "" };
};
