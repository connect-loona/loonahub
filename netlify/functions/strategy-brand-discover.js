// GET/POST -> { folders: [{ name, id, folderUrl, brandId, configured }] }
//
// Lists the brand folders sitting under the Drive Brands root and says which ones already
// have a brand configured in Hub. The Drive folder is where a new client actually starts —
// someone makes a folder and drops the guidelines in — so this turns "which brands exist?"
// into a question the app can answer from the same place the team already works, instead of
// someone remembering to create a matching brand record by hand.
//
// Deliberately read-only: it reports what's there and never creates a brand. A brand needs
// real strategic content (see BrandConfigSchema — truth, voice, pillars, audiences) before a
// run can succeed, so auto-creating one from a folder name would only produce something that
// fails at the first stage. Drafting that content is strategy-brand-draft-background.js's
// job, and a human still saves it.
"use strict";
const { fbGet } = require("./lib/strategy/firebase");
const { checkAuthorization } = require("./lib/strategy/auth");
const { listBrandFolders, slugForFolder } = require("./lib/strategy/google-drive");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  try {
    const [folders, brands] = await Promise.all([
      listBrandFolders(),
      fbGet("strategy_brands").then((b) => b || {}),
    ]);

    // A folder counts as configured if any existing brand matches it by id or by name —
    // the same slug comparison findBrandFolder() uses to pair them up, so this screen can't
    // claim a brand is missing that the pipeline would happily find.
    const existing = new Map();
    for (const brand of Object.values(brands)) {
      if (!brand || !brand.id) continue;
      existing.set(slugForFolder(brand.id), brand);
      if (brand.name) existing.set(slugForFolder(brand.name), brand);
    }

    const result = folders.map((folder) => {
      const slug = slugForFolder(folder.name);
      const match = existing.get(slug);
      return {
        name: folder.name,
        id: folder.id,
        folderUrl: `https://drive.google.com/drive/folders/${folder.id}`,
        brandId: match ? match.id : slug,
        configured: Boolean(match),
      };
    });

    return { statusCode: 200, headers: cors(), body: JSON.stringify({ folders: result }) };
  } catch (error) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: error.message || String(error) }) };
  }
};
