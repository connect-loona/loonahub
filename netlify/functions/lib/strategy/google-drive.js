"use strict";
const crypto = require("crypto");
const { fbGet, fbSet, fbSafeKey } = require("./firebase");
const { loadMemory, isCurrent, saveEntry, saveMemory, prune } = require("./brand-library-memory");
const { extractFile } = require("./brand-library-extract");

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_FILE_CHARS = 12000;
const MAX_LIBRARY_CHARS = 80000;
const CACHE_MS = 6 * 60 * 60 * 1000;
let tokenCache = null;

// Loona Brain, part one: a brand folder is not a flat pile of files.
//
// It has kinds. The brand guidelines say what the brand may never say. The approved content
// shows what actually shipped and got signed off. The performance reports say what worked.
// Each answers a different question, and the agents need all three — a month planned without
// the performance reports is a month planned with no idea what worked last month.
//
// The old spend was one shared budget handed out newest-first across the whole folder. That's
// fine until a brand outgrows it, and then it fails in the worst possible way: a fresh batch
// of content calendars uploaded this week eats the entire budget, and the performance reports
// — which nobody has touched since the day they were written, so they sort last — drop out
// silently. Nothing says so; the agents simply stop knowing.
//
// So each kind gets a floor it cannot be pushed below, and whatever a kind doesn't use is
// pooled and spent newest-first on everything else. A brand with no performance reports wastes
// none of their share; a brand with plenty never loses them to newer files of another kind.
const LIBRARY_CATEGORIES = [
  { key: "guidelines", label: "Brand guidelines", share: 0.3, match: /guideline|brand\s*book|brand\s*bible|identity|tone\s*of\s*voice|style\s*guide/i },
  { key: "approved", label: "Approved content", share: 0.3, match: /approved|content\s*calendar|calendar|final|published|live\s*post/i },
  { key: "performance", label: "Performance reports", share: 0.25, match: /performance|report|analytic|insight|metric|result|recap/i },
  { key: "other", label: "Other", share: 0.15, match: null },
];
const OTHER_CATEGORY = "other";

// Which kind a file is, decided by the folders it sits in rather than by the file itself —
// the folder names are the part the team actually curates, and they're stable in a way file
// names aren't. Only when no folder in the path says anything does the file's own name get a
// vote, so a loose "October performance report.pdf" dropped in the brand root still counts as
// a performance report even though no folder says so.
function categoryFor(itemPath, fileName) {
  const folders = String(itemPath || "").split("/").slice(0, -1).join("/");
  for (const category of LIBRARY_CATEGORIES) {
    if (category.match && category.match.test(folders)) return category.key;
  }
  for (const category of LIBRARY_CATEGORIES) {
    if (category.match && category.match.test(String(fileName || ""))) return category.key;
  }
  return OTHER_CATEGORY;
}

// Hands out the text budget so every kind keeps its floor, then pools what nobody needed.
// `read` must already be in the order the library wants to spend in (newest first), because
// that order is what decides who gets paid first both inside a category and out of the pool.
// Returns fileId -> how many characters that file may contribute.
function allocateTextBudget(read, total) {
  const allowance = new Map();
  let pool = 0;

  for (const category of LIBRARY_CATEGORIES) {
    let budget = Math.floor(total * category.share);
    for (const item of read) {
      if (budget <= 0) break;
      if (item.category !== category.key || !item.entry.text) continue;
      const take = Math.min(budget, MAX_FILE_CHARS, item.entry.text.length);
      allowance.set(item.file.id, take);
      budget -= take;
    }
    pool += budget; // an unspent floor belongs to everyone, not to the category that didn't need it
  }

  // Whatever no category needed is spent newest-first across everything still short — both a
  // file that got nothing at all and a file that got a slice it could usefully grow past.
  for (const item of read) {
    if (pool <= 0) break;
    if (!item.entry.text) continue;
    const already = allowance.get(item.file.id) || 0;
    const want = Math.min(MAX_FILE_CHARS, item.entry.text.length) - already;
    if (want <= 0) continue;
    const take = Math.min(pool, want);
    allowance.set(item.file.id, already + take);
    pool -= take;
  }

  return allowance;
}

function credentials() {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not configured.");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  if (!parsed.client_email || !parsed.private_key) throw new Error("Google Drive service-account credentials are incomplete.");
  return parsed;
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
  const account = credentials();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), account.private_key).toString("base64url");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!response.ok) throw new Error(`Google token request failed (${response.status}).`);
  const data = await response.json();
  tokenCache = { value: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) * 1000) };
  return tokenCache.value;
}

async function driveFetch(path, options = {}) {
  const token = await accessToken();
  const response = await fetch(`${DRIVE_API}${path}`, Object.assign({}, options, {
    headers: Object.assign({}, options.headers, { authorization: `Bearer ${token}` }),
  }));
  if (!response.ok) throw new Error(`Google Drive request failed (${response.status}) for ${path.split("?")[0]}.`);
  return response;
}

// `fetcher` defaults to the real, credentialed driveFetch; buildLibrary threads its own in
// so the whole indexer — listing included, not just file reads — can be exercised against a
// fake Drive with no service account and no network.
async function listChildren(folderId, fetcher = driveFetch) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,description,webViewLink)",
      pageSize: "1000",
      orderBy: "folder,name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await fetcher(`/files?${params}`)).json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

// One file's text, from memory when we've already read that exact version of it, and from
// a real extraction (see brand-library-extract.js) only when it's new or has changed. The
// memory entry is written either way, so a file that couldn't be read isn't retried on every
// run just to fail again — it's retried when it changes, like anything else.
async function textForFile(brandId, file, memory, deps) {
  const existing = memory[fbSafeKey(file.id)];
  if (isCurrent(existing, file)) return { entry: existing, reused: true };

  let entry;
  try {
    const result = await extractFile(file, deps);
    entry = {
      modifiedTime: file.modifiedTime || null,
      text: result.text || null,
      method: result.method || null,
      skipped: result.skipped || null,
      readAt: new Date().toISOString(),
    };
  } catch (error) {
    // A failure is remembered too, with its reason, so it surfaces in the UI instead of
    // vanishing into the function logs the way the old per-file catch did.
    console.warn(`Could not read Drive file ${file.id} (${file.name}):`, error.message);
    entry = {
      modifiedTime: file.modifiedTime || null,
      text: null, method: null,
      skipped: `Could not be read: ${error.message}`,
      readAt: new Date().toISOString(),
    };
  }
  await saveEntry(brandId, file.id, entry);
  return { entry, reused: false };
}

function slug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

function folderIdFromUrl(url) {
  const match = String(url || "").match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

async function findBrandFolder(config, fetcher = driveFetch) {
  const configured = folderIdFromUrl(config.driveFolderUrl);
  if (configured) return { id: configured, name: config.name };
  const rootId = process.env.GOOGLE_DRIVE_BRANDS_FOLDER_ID;
  if (!rootId) throw new Error("GOOGLE_DRIVE_BRANDS_FOLDER_ID is not configured.");
  const folders = (await listChildren(rootId, fetcher)).filter((file) => file.mimeType === FOLDER_MIME);
  const candidates = new Set([slug(config.id), slug(config.name), slug(config.name).split("-")[0]]);
  const matched = folders.find((folder) => candidates.has(slug(folder.name)) || slug(config.name).startsWith(`${slug(folder.name)}-`));
  if (!matched) throw new Error(`No Drive folder under Brands matched ${config.name}. Add its Drive folder link in Manage brands.`);
  return matched;
}

async function buildLibrary(config, options = {}) {
  const deps = Object.assign({ driveFetch }, options.deps || {});
  const root = await findBrandFolder(config, deps.driveFetch);

  // Phase 1 — walk the tree for metadata only. Listing is cheap and always current, so this
  // happens on every index: it's how a newly-added or newly-edited file gets noticed.
  const found = [];
  async function walk(folderId, path, depth) {
    if (depth > 8 || found.length >= 500) return;
    const children = await listChildren(folderId, deps.driveFetch);
    for (const file of children) {
      if (found.length >= 500) break;
      const itemPath = `${path}/${file.name}`;
      if (file.mimeType === FOLDER_MIME) { await walk(file.id, itemPath, depth + 1); continue; }
      found.push({ file, itemPath });
    }
  }
  await walk(root.id, root.name, 0);

  // Phase 2 — newest first. The text budget is finite, so something has to lose when a brand
  // outgrows it; spending it in Drive's alphabetical folder order meant whichever folder
  // happened to sort first silently ate everything. Most-recently-modified first means the
  // work just added is always the work that gets read.
  found.sort((a, b) => String(b.file.modifiedTime || "").localeCompare(String(a.file.modifiedTime || "")));

  // Phase 3 — text, from memory wherever the file hasn't changed since it was last read.
  const memory = await loadMemory(config.id);
  const read = [];
  let reusedCount = 0;
  let readCount = 0;
  for (const { file, itemPath } of found) {
    const { entry, reused } = await textForFile(config.id, file, memory, deps);
    if (reused) reusedCount += 1; else readCount += 1;
    read.push({ file, itemPath, entry, category: categoryFor(itemPath, file.name) });
  }

  // Phase 4 — spend the budget per kind (see LIBRARY_CATEGORIES), so no kind of file can be
  // crowded out of the agents' view by a newer batch of another kind.
  const allowance = allocateTextBudget(read, MAX_LIBRARY_CHARS);
  const files = read.map(({ file, itemPath, entry, category }) => {
    const item = {
      id: file.id, name: file.name, path: itemPath, mimeType: file.mimeType,
      category,
      modifiedTime: file.modifiedTime || null, size: file.size || null,
      description: file.description || null,
      url: file.webViewLink || `https://drive.google.com/open?id=${file.id}`,
    };
    const take = allowance.get(file.id) || 0;
    if (entry.text && take > 0) item.text = entry.text.slice(0, take);
    // Carried into the library so the app can say WHICH files the agents aren't seeing,
    // rather than only how many — including a file that was read perfectly well and then lost
    // its place to the budget, which used to disappear without leaving a trace anywhere.
    else if (entry.skipped) item.unread = entry.skipped;
    else if (entry.text) item.unread = "Read, but left out of this index — the brand's text budget was already full.";
    return item;
  });

  // A file that got less text than it had to give, for any reason other than the per-file
  // ceiling, is the signal that this brand has outgrown its budget.
  const starved = read.filter(({ file, entry }) =>
    entry.text && (allowance.get(file.id) || 0) < Math.min(entry.text.length, MAX_FILE_CHARS)).length;
  const categories = LIBRARY_CATEGORIES.map((category) => {
    const mine = read.filter((item) => item.category === category.key);
    return {
      key: category.key,
      label: category.label,
      fileCount: mine.length,
      textFileCount: mine.filter(({ file }) => (allowance.get(file.id) || 0) > 0).length,
      chars: mine.reduce((sum, { file }) => sum + (allowance.get(file.id) || 0), 0),
    };
  });

  // Forget files that have left the folder, so memory tracks the folder rather than growing
  // forever. Only what's actually gone is dropped — and it's written back, since reporting a
  // count without persisting the pruned map would leave the entries sitting there.
  const { kept, removed } = prune(await loadMemory(config.id), found.map(({ file }) => file.id));
  if (removed) await saveMemory(config.id, kept);

  return {
    schemaVersion: "1.2", brandId: config.id, folderId: root.id, folderName: root.name,
    folderUrl: config.driveFolderUrl || `https://drive.google.com/drive/folders/${root.id}`,
    indexedAt: new Date().toISOString(), fileCount: files.length,
    textFileCount: files.filter((file) => file.text).length,
    unreadFiles: files.filter((file) => file.unread).map((file) => ({ name: file.name, reason: file.unread })).slice(0, 25),
    filesReadThisIndex: readCount,
    filesFromMemory: reusedCount,
    forgottenFiles: removed,
    categories,
    truncated: files.length >= 500 || starved > 0,
    files,
  };
}

async function refreshBrandLibrary(config, options = {}) {
  const library = await buildLibrary(config, options);
  await fbSet(`strategy_brand_library/${fbSafeKey(config.id)}`, library);
  // Loona Brain re-distils whatever kind of material actually changed (see brand-brain.js).
  // Deliberately after the library is already saved, and deliberately unable to fail the
  // index: the raw library is what the agents have always read, and losing an index because a
  // summariser had a bad minute would be a strictly worse trade than a slightly stale brief.
  try {
    const { refreshBrain } = require("./brand-brain");
    await refreshBrain(library, options);
  } catch (error) {
    console.error(`Loona Brain refresh failed for ${config.id}:`, error.message);
  }
  return library;
}

async function loadBrandLibrary(config, options = {}) {
  const cached = await fbGet(`strategy_brand_library/${fbSafeKey(config.id)}`);
  const fresh = !options.force && cached && cached.indexedAt && (Date.now() - Date.parse(cached.indexedAt) < CACHE_MS);
  if (fresh) return cached;
  try { return await refreshBrandLibrary(config, options); }
  catch (error) {
    console.error(`Brand library refresh failed for ${config.id}:`, error.message);
    if (cached) return Object.assign({}, cached, { stale: true, refreshError: error.message });
    return { brandId: config.id, indexedAt: null, stale: true, refreshError: error.message, files: [] };
  }
}

// The brand folders sitting under the Brands root — the list the "which brands exist?"
// screen is built from. Metadata only: no file contents, no model calls.
async function listBrandFolders(fetcher = driveFetch) {
  const rootId = process.env.GOOGLE_DRIVE_BRANDS_FOLDER_ID;
  if (!rootId) throw new Error("GOOGLE_DRIVE_BRANDS_FOLDER_ID is not configured.");
  return (await listChildren(rootId, fetcher))
    .filter((file) => file.mimeType === FOLDER_MIME)
    .map((file) => ({ id: file.id, name: file.name }));
}

module.exports = {
  loadBrandLibrary, refreshBrandLibrary, buildLibrary,
  listBrandFolders,
  // Loona Brain's category layer, exported so the app can label a brand's folders the same
  // way the indexer budgets them, and so the budgeting can be tested without a Drive.
  LIBRARY_CATEGORIES, categoryFor, allocateTextBudget,
  // Exported so the discovery endpoint pairs folders to brands using exactly the same slug
  // rule findBrandFolder() matches on — otherwise a brand could show as "not set up" here
  // while the pipeline finds its folder perfectly well.
  slugForFolder: slug,
};

