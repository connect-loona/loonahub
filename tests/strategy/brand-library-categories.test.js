// Loona Brain, part one: the brand library's text budget is spent per KIND of file, not
// newest-first across the whole folder.
//
// The bug this exists to prevent is silent and expensive. A brand folder holds three kinds of
// thing the agents each need for a different reason — the guidelines (what the brand may never
// say), the approved content (what actually shipped), and the performance reports (what
// worked). Spending one shared budget newest-first means a fresh batch of content calendars
// uploaded this week can push the performance reports — untouched since the day they were
// written, so always last in a newest-first sort — clean out of the index. Nothing errors.
// The agents simply plan next month with no idea what happened last month.
//
// So: every kind gets a floor, unspent floors are pooled rather than wasted, and a file that
// loses its place to the budget says so instead of vanishing.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { buildLibrary, categoryFor, allocateTextBudget, LIBRARY_CATEGORIES } = require(path.join(HUB, "netlify/functions/lib/strategy/google-drive"));

function fakeDrive(tree, bodyFor) {
  return async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/files?")) {
      const query = decodeURIComponent(pathAndQuery).replace(/\+/g, " ");
      const match = query.match(/'([^']+)' in parents/);
      return { json: async () => ({ files: tree[match[1]] || [] }) };
    }
    const id = pathAndQuery.match(/\/files\/([^/?]+)/)[1];
    const body = bodyFor ? bodyFor(id) : `CONTENT OF ${id}`;
    return { text: async () => body, arrayBuffer: async () => Buffer.from(body) };
  };
}

const DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_brand_library_files.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brand_library.json`, null);

  // ---- categoryFor: the folder names are what decide, not the file ----
  check("a file under Brand Guidelines is guidelines", categoryFor("RRO/Brand Guidelines/deck.pdf", "deck.pdf") === "guidelines");
  check("a file under Approved Content is approved", categoryFor("RRO/Approved Content/Sept.pdf", "Sept.pdf") === "approved");
  check("a file under Performance Reports is performance", categoryFor("RRO/Performance Reports/Aug.pdf", "Aug.pdf") === "performance");
  check("a content calendar counts as approved content", categoryFor("RRO/Content Calendar/Oct.xlsx", "Oct.xlsx") === "approved");
  check("anything else is other", categoryFor("RRO/Random/notes.txt", "notes.txt") === "other");

  // The folder wins over the file's own name: a file called "report" filed under guidelines is
  // guidelines, because the folder is the part the team actually curates.
  check("the folder decides, not the file name", categoryFor("RRO/Brand Guidelines/performance report.pdf", "performance report.pdf") === "guidelines");
  // ...but a loose file with no folder signal still gets to speak for itself.
  check("a loose file falls back to its own name", categoryFor("RRO/October performance report.pdf", "October performance report.pdf") === "performance");

  check("the category shares add up to the whole budget",
    Math.abs(LIBRARY_CATEGORIES.reduce((sum, c) => sum + c.share, 0) - 1) < 1e-9,
    LIBRARY_CATEGORIES.map((c) => c.share));

  // ---- allocateTextBudget: the floor holds even when newer files want everything ----
  // One performance report, last in newest-first order, behind enough newer approved content
  // to have eaten the entire old shared budget.
  const flood = [];
  for (let i = 0; i < 20; i += 1) {
    flood.push({ file: { id: `new${i}` }, category: "approved", entry: { text: "x".repeat(12000) } });
  }
  const oldReport = { file: { id: "report" }, category: "performance", entry: { text: "y".repeat(12000) } };
  const allowance = allocateTextBudget([...flood, oldReport], 80000);
  check("the old performance report still gets read, despite 20 newer files ahead of it",
    (allowance.get("report") || 0) > 0, allowance.get("report"));
  check("and it gets its full share, not a token slice",
    allowance.get("report") === 12000, allowance.get("report"));

  // The flood is free to take everything the other kinds didn't want — that pooling is the
  // point, not a leak — but never a character more than the budget itself.
  const totalSpend = [...flood, oldReport].reduce((sum, item) => sum + (allowance.get(item.file.id) || 0), 0);
  check("the whole allocation still fits inside the budget", totalSpend <= 80000, totalSpend);
  check("and the budget is actually used up, not left on the table", totalSpend === 80000, totalSpend);

  // ---- An unused floor is pooled, not wasted ----
  // A brand with nothing but guidelines should still spend the whole budget on them.
  const onlyGuidelines = [];
  for (let i = 0; i < 20; i += 1) {
    onlyGuidelines.push({ file: { id: `g${i}` }, category: "guidelines", entry: { text: "z".repeat(12000) } });
  }
  const pooled = allocateTextBudget(onlyGuidelines, 80000);
  const guidelineSpend = onlyGuidelines.reduce((sum, item) => sum + (pooled.get(item.file.id) || 0), 0);
  check("a brand with only one kind of file still spends the whole budget on it",
    guidelineSpend === 80000, guidelineSpend);

  // ---- Nothing is ever handed more than the per-file ceiling ----
  const oneHuge = allocateTextBudget([{ file: { id: "huge" }, category: "other", entry: { text: "q".repeat(500000) } }], 80000);
  check("no single file can exceed the per-file ceiling", oneHuge.get("huge") === 12000, oneHuge.get("huge"));

  // ---- End to end, through a real buildLibrary against a fake Drive ----
  // The shape of the actual problem: a performance report from March, and newer content
  // calendars piled on top of it.
  const tree = {
    ROOT: [
      { id: "guide", name: "Brand Guidelines", mimeType: FOLDER },
      { id: "approvedf", name: "Approved Content", mimeType: FOLDER },
      { id: "perf", name: "Performance Reports", mimeType: FOLDER },
    ],
    guide: [{ id: "g1", name: "Tone of voice.doc", mimeType: DOC, modifiedTime: "2026-02-01T00:00:00Z" }],
    approvedf: [
      { id: "a1", name: "September calendar.doc", mimeType: DOC, modifiedTime: "2026-09-01T00:00:00Z" },
      { id: "a2", name: "August calendar.doc", mimeType: DOC, modifiedTime: "2026-08-01T00:00:00Z" },
    ],
    perf: [{ id: "p1", name: "March report.doc", mimeType: DOC, modifiedTime: "2026-03-01T00:00:00Z" }],
  };
  const config = { id: "cattest", name: "Cat Test", driveFolderUrl: "https://drive.google.com/drive/folders/ROOT" };
  const library = await buildLibrary(config, { deps: { driveFetch: fakeDrive(tree) } });

  const byId = Object.fromEntries(library.files.map((file) => [file.id, file]));
  check("every file is tagged with the kind of thing it is", byId.g1.category === "guidelines"
    && byId.a1.category === "approved" && byId.p1.category === "performance",
    library.files.map((f) => `${f.id}:${f.category}`));
  check("the oldest file — the performance report — is still read", Boolean(byId.p1.text), byId.p1);
  check("newest-first ordering of the library itself is unchanged", library.files[0].id === "a1", library.files.map((f) => f.id));

  const categories = Object.fromEntries((library.categories || []).map((c) => [c.key, c]));
  check("the library reports a per-kind breakdown for the app to show",
    categories.guidelines.fileCount === 1 && categories.approved.fileCount === 2 && categories.performance.fileCount === 1,
    library.categories);
  check("every kind present actually got text", categories.guidelines.textFileCount === 1
    && categories.approved.textFileCount === 2 && categories.performance.textFileCount === 1,
    library.categories);
  check("a kind with no files reports zero rather than going missing",
    categories.other && categories.other.fileCount === 0, categories.other);
  check("a folder that fits comfortably is not flagged as truncated", library.truncated === false, library.truncated);

  // ---- A file that loses its place to the budget says so ----
  // Enough files to genuinely overrun the budget, so something must lose — and whatever loses
  // has to be named, which is exactly what the old shared-budget spend never did. Each file
  // contributes MAX_EXTRACT_CHARS (6000, capped in brand-library-extract.js), so 20 files ask
  // for 120k against an 80k budget.
  const bigTree = { ROOT: [] };
  for (let i = 0; i < 20; i += 1) {
    bigTree.ROOT.push({ id: `big${i}`, name: `Deck ${i}.doc`, mimeType: DOC, modifiedTime: `2026-${String((i % 12) + 1).padStart(2, "0")}-01T00:00:00Z` });
  }
  const big = await buildLibrary(
    { id: "cattest2", name: "Cat Test 2", driveFolderUrl: "https://drive.google.com/drive/folders/ROOT" },
    { deps: { driveFetch: fakeDrive(bigTree, () => "w".repeat(12000)) } });
  check("a brand that outgrew its budget is flagged as truncated", big.truncated === true, big.truncated);
  const dropped = (big.unreadFiles || []).filter((file) => /budget/.test(file.reason));
  check("the files left out for budget are named, not silently dropped", dropped.length > 0, big.unreadFiles);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
