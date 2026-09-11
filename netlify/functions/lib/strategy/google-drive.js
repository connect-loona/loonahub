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
  const files = [];
  let textBudget = MAX_LIBRARY_CHARS;
  let reusedCount = 0;
  let readCount = 0;
  for (const { file, itemPath } of found) {
    const item = {
      id: file.id, name: file.name, path: itemPath, mimeType: file.mimeType,
      modifiedTime: file.modifiedTime || null, size: file.size || null,
      description: file.description || null,
      url: file.webViewLink || `https://drive.google.com/open?id=${file.id}`,
    };
    const { entry, reused } = await textForFile(config.id, file, memory, deps);
    if (reused) reusedCount += 1; else readCount += 1;
    if (entry.text && textBudget > 0) {
      item.text = entry.text.slice(0, Math.min(textBudget, MAX_FILE_CHARS));
      textBudget -= item.text.length;
    } else if (entry.skipped) {
      // Carried into the library so the app can say WHICH files the agents aren't seeing,
      // rather than only how many.
      item.unread = entry.skipped;
    }
    files.push(item);
  }

  // Forget files that have left the folder, so memory tracks the folder rather than growing
  // forever. Only what's actually gone is dropped — and it's written back, since reporting a
  // count without persisting the pruned map would leave the entries sitting there.
  const { kept, removed } = prune(await loadMemory(config.id), found.map(({ file }) => file.id));
  if (removed) await saveMemory(config.id, kept);

  return {
    schemaVersion: "1.1", brandId: config.id, folderId: root.id, folderName: root.name,
    folderUrl: config.driveFolderUrl || `https://drive.google.com/drive/folders/${root.id}`,
    indexedAt: new Date().toISOString(), fileCount: files.length,
    textFileCount: files.filter((file) => file.text).length,
    unreadFiles: files.filter((file) => file.unread).map((file) => ({ name: file.name, reason: file.unread })).slice(0, 25),
    filesReadThisIndex: readCount,
    filesFromMemory: reusedCount,
    forgottenFiles: removed,
    truncated: files.length >= 500 || textBudget <= 0,
    files,
  };
}

async function refreshBrandLibrary(config, options = {}) {
  const library = await buildLibrary(config, options);
  await fbSet(`strategy_brand_library/${fbSafeKey(config.id)}`, library);
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

module.exports = { loadBrandLibrary, refreshBrandLibrary, buildLibrary };

