// Per-file memory for the brand Drive library.
//
// Why this exists: the brand folders are the spine of everything the agents know, and they
// are almost entirely PDFs — decks, guidelines, performance reports. A PDF has no text the
// Drive API will just hand over (see extractors.js), so getting content out of one costs a
// real model call. Doing that on every run, for every file, for every brand would be
// absurd: the same unchanged deck would be re-read dozens of times a month.
//
// So each file is read ONCE and what was learned is stored here, keyed by the file's id and
// stamped with the modifiedTime it was read at. A later index reuses that memory whenever
// Drive reports the same modifiedTime, and re-reads only when the file has actually changed
// (or is new). Listing metadata stays cheap and always happens; the expensive part is what
// gets skipped.
//
// Stored at strategy_brand_library_files/<brandId>/<fileId>, separate from the library doc
// itself (strategy_brand_library/<brandId>) so that rebuilding a library never throws away
// the accumulated reading.
"use strict";
const { fbGet, fbSet, fbSafeKey } = require("./firebase");

function memoryPath(brandId) {
  return `strategy_brand_library_files/${fbSafeKey(brandId)}`;
}

async function loadMemory(brandId) {
  return (await fbGet(memoryPath(brandId))) || {};
}

// A memory entry is usable when it was taken from the same VERSION of the file. Drive's
// modifiedTime changes whenever the file's content does, so comparing it is what makes
// "unless there is something new" work — a re-upload or an edit invalidates the memory, an
// untouched file keeps it forever.
//
// An entry that recorded a failure (skipped: too large, unsupported type, a model error) is
// still a valid memory of that version: retrying it on every single run would burn the same
// call to get the same failure. It's retried when the file changes, like anything else.
function isCurrent(entry, file) {
  if (!entry || !file) return false;
  if (!entry.modifiedTime || !file.modifiedTime) return false;
  return entry.modifiedTime === file.modifiedTime;
}

async function saveEntry(brandId, fileId, entry) {
  await fbSet(`${memoryPath(brandId)}/${fbSafeKey(fileId)}`, entry);
}

async function saveMemory(brandId, memory) {
  await fbSet(memoryPath(brandId), memory);
}

// Drop memory for files that are no longer in the folder at all, so a brand's memory doesn't
// grow forever with deleted work. Anything still present is left exactly as it is.
function prune(memory, liveFileIds) {
  const live = new Set(liveFileIds.map((id) => fbSafeKey(id)));
  const kept = {};
  let removed = 0;
  for (const [key, entry] of Object.entries(memory || {})) {
    if (live.has(key)) kept[key] = entry;
    else removed += 1;
  }
  return { kept, removed };
}

module.exports = { loadMemory, isCurrent, saveEntry, saveMemory, prune, memoryPath };
