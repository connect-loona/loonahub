// The brand Drive library's per-file memory: read a file once, keep what was learned, and
// re-read only when that file actually changes. Loona's brand folders are almost entirely
// PDFs, and reading a PDF costs a real model call, so re-reading unchanged files on every run
// would be the difference between one call per new deck and dozens per month per deck.
//
// Also covers the extraction ladder's routing (Google export vs download vs PDF vs
// unsupported) and the newest-first spend of the library's text budget.
//
// No Drive, no API key, no network: driveFetch and the PDF client are both injected.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { fbGet, fbSet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const { isCurrent, prune } = require(path.join(HUB, "netlify/functions/lib/strategy/brand-library-memory"));
const { extractFile, MAX_PDF_BYTES } = require(path.join(HUB, "netlify/functions/lib/strategy/brand-library-extract"));
const { buildLibrary } = require(path.join(HUB, "netlify/functions/lib/strategy/google-drive"));

function textResponse(body) {
  return { text: async () => body, arrayBuffer: async () => Buffer.from(body) };
}

// A fake Drive: a flat map of folderId -> children, served through the same /files? listing
// shape google-drive.js parses.
function fakeDrive(tree, log) {
  return async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/files?")) {
      // URLSearchParams encodes spaces as "+", so normalise before matching the folder id.
      const query = decodeURIComponent(pathAndQuery).replace(/\+/g, " ");
      const match = query.match(/'([^']+)' in parents/);
      return { json: async () => ({ files: tree[match[1]] || [] }) };
    }
    const id = pathAndQuery.match(/\/files\/([^/?]+)/)[1];
    if (log) log.push(id);
    return textResponse(`CONTENT OF ${id}`);
  };
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_brand_library_files.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brand_library.json`, null);

  // ---- isCurrent: the modifiedTime comparison is what makes "unless there is something new" work ----
  const file = { id: "f1", modifiedTime: "2026-09-09T06:00:00Z" };
  check("memory of the same version is current", isCurrent({ modifiedTime: "2026-09-09T06:00:00Z" }, file));
  check("memory of an older version is not current", !isCurrent({ modifiedTime: "2026-09-01T06:00:00Z" }, file));
  check("memory with no modifiedTime is never trusted", !isCurrent({ text: "x" }, file));
  check("a missing memory entry is not current", !isCurrent(undefined, file));
  // A remembered FAILURE is still a memory of that version — retrying it every run would buy
  // the same failure over and over.
  check("a remembered failure still counts as current for that version", isCurrent({ modifiedTime: "2026-09-09T06:00:00Z", text: null, skipped: "Too large" }, file));

  // ---- prune: memory follows the folder ----
  const pruned = prune({ a: { text: "1" }, b: { text: "2" }, c: { text: "3" } }, ["a", "c"]);
  check("files still in the folder keep their memory", Boolean(pruned.kept.a && pruned.kept.c), Object.keys(pruned.kept));
  check("files that left the folder are forgotten", !pruned.kept.b && pruned.removed === 1, pruned.removed);

  // ---- The extraction ladder routes each type to the right reader ----
  const drive = fakeDrive({});
  const doc = await extractFile({ id: "d1", name: "Guidelines", mimeType: "application/vnd.google-apps.document" }, { driveFetch: drive });
  check("a Google Doc is exported as text", doc.method === "google-export" && doc.text === "CONTENT OF d1", doc);

  const sheet = await extractFile({ id: "s1", name: "SKUs", mimeType: "application/vnd.google-apps.spreadsheet" }, { driveFetch: drive });
  check("a Google Sheet is exported too", sheet.method === "google-export", sheet);

  const txt = await extractFile({ id: "t1", name: "notes.txt", mimeType: "text/plain", size: 500 }, { driveFetch: drive });
  check("a plain text file is downloaded", txt.method === "download" && txt.text === "CONTENT OF t1", txt);

  const image = await extractFile({ id: "i1", name: "logo.png", mimeType: "image/png", size: 1000 }, { driveFetch: drive });
  check("an image is recorded as unreadable with a reason, not silently dropped", !image.text && /image\/png/.test(image.skipped), image);

  // A PDF over the request ceiling can't be sent whole. It must say so, with its real size,
  // because the fix is on the file's side — this is most of Loona's biggest decks.
  const huge = await extractFile({ id: "p1", name: "Big deck.pdf", mimeType: "application/pdf", size: 115 * 1024 * 1024 }, { driveFetch: drive });
  check("an oversized PDF is reported as too large", !huge.text && /Too large to read \(115MB\)/.test(huge.skipped), huge.skipped);
  check("the too-large message says what to do about it", /under 20MB/.test(huge.skipped), huge.skipped);

  // A PDF within range is read by the model, and what comes back is the stored memory.
  const pdfClient = {
    messages: {
      create: async (params) => {
        const hasDoc = params.messages[0].content.some((b) => b.type === "document" && b.source.media_type === "application/pdf");
        return { content: [{ type: "text", text: hasDoc ? "RULE: never say 'pure'. SKU: Primio Groundnut Oil 1L." : "NO DOCUMENT SENT" }] };
      },
    },
  };
  const pdf = await extractFile({ id: "p2", name: "Brand guidelines.pdf", mimeType: "application/pdf", size: 2 * 1024 * 1024 }, { driveFetch: drive, pdfClient });
  check("an in-range PDF is read by the model", pdf.method === "pdf-model" && /never say 'pure'/.test(pdf.text), pdf);

  // "NOTHING USEFUL" is a real answer, not content to feed the agents.
  const emptyClient = { messages: { create: async () => ({ content: [{ type: "text", text: "NOTHING USEFUL" }] }) } };
  const useless = await extractFile({ id: "p3", name: "Blank.pdf", mimeType: "application/pdf", size: 1000 }, { driveFetch: drive, pdfClient: emptyClient });
  check("a PDF with nothing useful stores no text", !useless.text && /Nothing useful/.test(useless.skipped), useless);

  // ---- buildLibrary: memory is used on the second pass ----
  const tree = {
    ROOT: [
      { id: "sub", name: "Brand guidelines", mimeType: "application/vnd.google-apps.folder" },
      { id: "old", name: "Old deck", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00Z" },
    ],
    sub: [
      { id: "new", name: "New rules", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-10T00:00:00Z" },
    ],
  };
  const config = { id: "memtest", name: "Mem Test", driveFolderUrl: "https://drive.google.com/drive/folders/ROOT" };

  const firstLog = [];
  const first = await buildLibrary(config, { deps: { driveFetch: fakeDrive(tree, firstLog) } });
  check("first index reads every file", first.filesReadThisIndex === 2 && first.filesFromMemory === 0, { read: first.filesReadThisIndex, memory: first.filesFromMemory });
  check("first index actually fetched both files", firstLog.length === 2, firstLog);
  check("both files carry text", first.textFileCount === 2, first.textFileCount);

  // Newest first: "New rules" (September) must be ahead of "Old deck" (January), even though
  // Drive listed the folder containing it first and alphabetically.
  check("the newest file is first in the library", first.files[0].id === "new", first.files.map((f) => f.id));

  const secondLog = [];
  const second = await buildLibrary(config, { deps: { driveFetch: fakeDrive(tree, secondLog) } });
  check("second index reads nothing — every file came from memory", second.filesReadThisIndex === 0 && second.filesFromMemory === 2, { read: second.filesReadThisIndex, memory: second.filesFromMemory });
  check("no file was fetched on the second index", secondLog.length === 0, secondLog);
  check("the text is still there, from memory", second.textFileCount === 2, second.textFileCount);

  // ---- A changed file, and only that file, is re-read ----
  const changedTree = JSON.parse(JSON.stringify(tree));
  changedTree.sub[0].modifiedTime = "2026-09-11T12:00:00Z";
  const thirdLog = [];
  const third = await buildLibrary(config, { deps: { driveFetch: fakeDrive(changedTree, thirdLog) } });
  check("only the changed file is re-read", third.filesReadThisIndex === 1 && third.filesFromMemory === 1, { read: third.filesReadThisIndex, memory: third.filesFromMemory });
  check("the re-read was the file that changed", thirdLog.length === 1 && thirdLog[0] === "new", thirdLog);

  // ---- A new file is picked up without disturbing the rest ----
  changedTree.ROOT.push({ id: "extra", name: "Added today", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-11T18:00:00Z" });
  const fourthLog = [];
  const fourth = await buildLibrary(config, { deps: { driveFetch: fakeDrive(changedTree, fourthLog) } });
  check("a newly added file is read, the rest stay in memory", fourth.filesReadThisIndex === 1 && fourth.filesFromMemory === 2, { read: fourth.filesReadThisIndex, memory: fourth.filesFromMemory });
  check("the newly added file sorts to the front", fourth.files[0].id === "extra", fourth.files.map((f) => f.id));

  // ---- A deleted file is forgotten ----
  const trimmed = { ROOT: [changedTree.ROOT[1]], sub: [] };
  const fifth = await buildLibrary(config, { deps: { driveFetch: fakeDrive(trimmed) } });
  check("files removed from Drive are forgotten from memory", fifth.forgottenFiles === 2, fifth.forgottenFiles);
  const remaining = await fbGet("strategy_brand_library_files/memtest");
  check("the surviving file keeps its memory entry", Boolean(remaining.old), Object.keys(remaining || {}));
  // The count must reflect what was actually written — reporting "2 forgotten" while the
  // entries sat untouched in Firebase is exactly the bug this catches.
  check("forgotten files are really gone from stored memory, not just counted", !remaining.new && !remaining.extra, Object.keys(remaining || {}));

  // ---- Unread files are named in the library so the app can say WHICH ones ----
  const withImage = { ROOT: [{ id: "img", name: "cover.png", mimeType: "image/png", size: 400, modifiedTime: "2026-09-11T00:00:00Z" }] };
  const sixth = await buildLibrary({ id: "memtest2", name: "Mem Test 2", driveFolderUrl: "https://drive.google.com/drive/folders/ROOT" }, { deps: { driveFetch: fakeDrive(withImage) } });
  check("an unreadable file is listed by name with its reason", sixth.unreadFiles.length === 1 && sixth.unreadFiles[0].name === "cover.png", sixth.unreadFiles);
  check("and it counts as indexed but not readable", sixth.fileCount === 1 && sixth.textFileCount === 0, { files: sixth.fileCount, text: sixth.textFileCount });

  check("the PDF ceiling is the documented 20MB", MAX_PDF_BYTES === 20 * 1024 * 1024, MAX_PDF_BYTES);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
