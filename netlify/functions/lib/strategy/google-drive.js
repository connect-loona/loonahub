"use strict";
const crypto = require("crypto");
const { fbGet, fbSet, fbSafeKey } = require("./firebase");

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

async function listChildren(folderId) {
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
    const data = await (await driveFetch(`/files?${params}`)).json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

function exportMime(mimeType) {
  if (mimeType === "application/vnd.google-apps.document") return "text/plain";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "text/csv";
  if (mimeType === "application/vnd.google-apps.presentation") return "text/plain";
  return null;
}

function downloadableText(mimeType) {
  return mimeType.startsWith("text/") || ["application/json", "application/csv", "application/xml"].includes(mimeType);
}

async function extractText(file) {
  try {
    const exported = exportMime(file.mimeType);
    let response;
    if (exported) response = await driveFetch(`/files/${file.id}/export?mimeType=${encodeURIComponent(exported)}`);
    else if (downloadableText(file.mimeType) && Number(file.size || 0) <= 2 * 1024 * 1024) response = await driveFetch(`/files/${file.id}?alt=media`);
    else return null;
    const text = (await response.text()).replace(/\u0000/g, "").trim();
    return text ? text.slice(0, MAX_FILE_CHARS) : null;
  } catch (error) {
    console.warn(`Could not extract Drive file ${file.id}:`, error.message);
    return null;
  }
}

function slug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

function folderIdFromUrl(url) {
  const match = String(url || "").match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

async function findBrandFolder(config) {
  const configured = folderIdFromUrl(config.driveFolderUrl);
  if (configured) return { id: configured, name: config.name };
  const rootId = process.env.GOOGLE_DRIVE_BRANDS_FOLDER_ID;
  if (!rootId) throw new Error("GOOGLE_DRIVE_BRANDS_FOLDER_ID is not configured.");
  const folders = (await listChildren(rootId)).filter((file) => file.mimeType === FOLDER_MIME);
  const candidates = new Set([slug(config.id), slug(config.name), slug(config.name).split("-")[0]]);
  const matched = folders.find((folder) => candidates.has(slug(folder.name)) || slug(config.name).startsWith(`${slug(folder.name)}-`));
  if (!matched) throw new Error(`No Drive folder under Brands matched ${config.name}. Add its Drive folder link in Manage brands.`);
  return matched;
}

async function buildLibrary(config) {
  const root = await findBrandFolder(config);
  const files = [];
  let textBudget = MAX_LIBRARY_CHARS;
  async function walk(folderId, path, depth) {
    if (depth > 8 || files.length >= 500) return;
    const children = await listChildren(folderId);
    for (const file of children) {
      if (files.length >= 500) break;
      const itemPath = `${path}/${file.name}`;
      if (file.mimeType === FOLDER_MIME) { await walk(file.id, itemPath, depth + 1); continue; }
      const item = {
        id: file.id, name: file.name, path: itemPath, mimeType: file.mimeType,
        modifiedTime: file.modifiedTime || null, size: file.size || null,
        description: file.description || null,
        url: file.webViewLink || `https://drive.google.com/open?id=${file.id}`,
      };
      if (textBudget > 0) {
        const extracted = await extractText(file);
        if (extracted) { item.text = extracted.slice(0, textBudget); textBudget -= item.text.length; }
      }
      files.push(item);
    }
  }
  await walk(root.id, root.name, 0);
  return {
    schemaVersion: "1.0", brandId: config.id, folderId: root.id, folderName: root.name,
    folderUrl: config.driveFolderUrl || `https://drive.google.com/drive/folders/${root.id}`,
    indexedAt: new Date().toISOString(), fileCount: files.length,
    textFileCount: files.filter((file) => file.text).length,
    truncated: files.length >= 500 || textBudget <= 0, files,
  };
}

async function refreshBrandLibrary(config) {
  const library = await buildLibrary(config);
  await fbSet(`strategy_brand_library/${fbSafeKey(config.id)}`, library);
  return library;
}

async function loadBrandLibrary(config, options = {}) {
  const cached = await fbGet(`strategy_brand_library/${fbSafeKey(config.id)}`);
  const fresh = !options.force && cached && cached.indexedAt && (Date.now() - Date.parse(cached.indexedAt) < CACHE_MS);
  if (fresh) return cached;
  try { return await refreshBrandLibrary(config); }
  catch (error) {
    console.error(`Brand library refresh failed for ${config.id}:`, error.message);
    if (cached) return Object.assign({}, cached, { stale: true, refreshError: error.message });
    return { brandId: config.id, indexedAt: null, stale: true, refreshError: error.message, files: [] };
  }
}

module.exports = { loadBrandLibrary, refreshBrandLibrary, buildLibrary };

