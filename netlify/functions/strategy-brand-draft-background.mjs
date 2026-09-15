import firebase from "./lib/strategy/firebase.js";
import drive from "./lib/strategy/google-drive.js";
import pipeline from "./lib/strategy/pipeline.js";
import brandDraft from "./lib/strategy/brand-draft.js";
import { backgroundConfig, readSignedBackgroundBody } from "./lib/strategy/modern-background.mjs";

const FUNCTION_NAME = "strategy-brand-draft-background";
const { fbSet, fbSafeKey } = firebase;
const { buildLibrary } = drive;
const { createRuntime } = pipeline;
const { draftBrandFromLibrary } = brandDraft;

export default async function (request) {
  const body = await readSignedBackgroundBody(request, FUNCTION_NAME);
  if (!body) return;
  const brandId = String(body.brandId || "").trim();
  const name = String(body.name || "").trim();
  const folderId = String(body.folderId || "").trim();
  if (!brandId || !name || !folderId) return;

  const draftPath = `strategy_brand_drafts/${fbSafeKey(brandId)}`;
  try {
    const library = await buildLibrary({
      id: brandId,
      name,
      driveFolderUrl: `https://drive.google.com/drive/folders/${folderId}`,
    });
    const runtime = createRuntime({ runtime: "openai" }, "strategy");
    const draft = await draftBrandFromLibrary(runtime, name, library);
    await fbSet(draftPath, {
      brandId,
      name,
      folderId,
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
      brandId,
      name,
      folderId,
      status: "failed",
      error: error.message || String(error),
      draft: null,
      completedAt: new Date().toISOString(),
    });
  }
}

export const config = backgroundConfig;
