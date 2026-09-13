// Loona Brain's distillation layer: turning a brand folder's raw extracted text into a short,
// durable brief that persists across runs.
//
// Two properties matter most and are what this file is really guarding.
//
// First, cost. Distilling is a real model call per kind of material. If it ran on every run
// the bill would scale with runs instead of with changes, which is exactly the mistake
// brand-library-memory.js exists to avoid one level down. So it's fingerprinted against the
// source files, and an unchanged folder must re-distil NOTHING.
//
// Second, blast radius. The raw library is what the agents have always read and it still
// reaches them untouched. A missing key, a model error, a folder with no performance reports
// — none of those may break a run or throw away a brief we already had.
//
// No key and no network: the model client is injected.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const { fbGet } = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
const {
  refreshBrain, loadBrain, brainToPromptText, fingerprintFor, filesForSection, SECTIONS, MAX_SECTION_CHARS,
} = require(path.join(HUB, "netlify/functions/lib/strategy/brand-brain"));

// A client that records what it was asked and answers with something section-specific, so the
// test can tell the three distillations apart.
function fakeClient(log, reply) {
  return {
    messages: {
      create: async (params) => {
        log.push({ system: params.system, user: params.messages[0].content, model: params.model });
        const text = reply ? reply(params) : `BRIEF: ${params.messages[0].content.slice(0, 40)}`;
        return { content: [{ type: "text", text }] };
      },
    },
  };
}

function library(brandId, files) {
  return { brandId, files };
}

function file(id, category, text, modifiedTime) {
  return { id, category, text, modifiedTime: modifiedTime || "2026-09-01T00:00:00Z", name: `${id}.doc`, path: `Brand/${category}/${id}.doc` };
}

(async () => {
  await req("PUT", `${RTDB_URL}/strategy_brain.json`, null);

  // ---- fingerprintFor: what "unchanged" actually means ----
  const a = [file("f1", "guidelines", "one"), file("f2", "guidelines", "two")];
  check("the same files fingerprint the same", fingerprintFor(a) === fingerprintFor(a.slice().reverse()),
    "order must not matter — Drive's listing order is not a change");
  const edited = [file("f1", "guidelines", "one", "2026-09-05T00:00:00Z"), file("f2", "guidelines", "two")];
  check("an edited file changes the fingerprint", fingerprintFor(a) !== fingerprintFor(edited));
  check("an added file changes the fingerprint", fingerprintFor(a) !== fingerprintFor([...a, file("f3", "guidelines", "three")]));
  check("a removed file changes the fingerprint", fingerprintFor(a) !== fingerprintFor(a.slice(0, 1)));

  // ---- filesForSection: a file the agents never read has nothing to distil ----
  const mixed = [file("g", "guidelines", "text"), file("p", "performance", "text"), Object.assign(file("x", "guidelines", ""), { text: null })];
  check("only files of that kind are used", filesForSection(library("b", mixed), "performance").map((f) => f.id).join() === "p");
  check("a file with no readable text is not distilled", filesForSection(library("b", mixed), "guidelines").map((f) => f.id).join() === "g");

  // ---- A first refresh distils each kind that has material, once ----
  const log1 = [];
  const lib = library("braintest", [
    file("g1", "guidelines", "Never say 'pure'. Always write Primio in title case."),
    file("a1", "approved", "September reels: 12s hooks, question opener, CTA 'tap to try'."),
    file("p1", "performance", "Reels under 15s: 4.2x saves vs static. Carousels flat."),
  ]);
  const brain1 = await refreshBrain(lib, { deps: { brainClient: fakeClient(log1) } });
  check("each kind of material is distilled exactly once", log1.length === 3, log1.length);
  check("and that is counted", brain1.sectionsDistilled === 3 && brain1.sectionsFromMemory === 0, brain1);
  check("every section has a brief", SECTIONS.every((s) => Boolean(brain1.sections[s.key].text)), Object.keys(brain1.sections));

  // Each kind gets its OWN instructions — running one generic "summarise this" over all three
  // is what produces three briefs that all say the same vague things about brand values.
  const systems = log1.map((call) => call.system);
  check("each kind is distilled with its own instructions", new Set(systems).size === 3, systems.length);
  check("the performance brief is asked for what did badly too, not just what worked",
    systems.some((s) => /performed badly/.test(s)), true);
  check("the approved-content brief is asked which angles are already exhausted",
    systems.some((s) => /EXHAUSTED/.test(s)), true);
  check("the guidelines brief is asked for exact forbidden wording",
    systems.some((s) => /forbidden/.test(s) && /Quote them exactly/.test(s)), true);

  // Each call must only see its own kind of material — leaking the performance reports into
  // the guidelines distillation would produce a "rule" that is really just last month's numbers.
  const guidelinesCall = log1.find((call) => /forbidden/.test(call.system));
  check("a distillation only sees files of its own kind",
    /Never say 'pure'/.test(guidelinesCall.user) && !/4.2x saves/.test(guidelinesCall.user), guidelinesCall.user);

  // Cheap tier on purpose — this is compression of already-extracted text, not judgement.
  check("distilling uses the economy model", log1.every((call) => /haiku/.test(call.model)), log1[0].model);

  // ---- It is stored where the pipeline will look for it ----
  const stored = await fbGet("strategy_brain/braintest");
  check("the brain is persisted per brand", Boolean(stored && stored.sections && stored.sections.guidelines.text), stored && Object.keys(stored));
  const loaded = await loadBrain("braintest");
  check("and loads back", Boolean(loaded.sections.performance.text), loaded && loaded.schemaVersion);

  // ---- THE COST PROPERTY: an unchanged folder re-distils nothing ----
  const log2 = [];
  const brain2 = await refreshBrain(lib, { deps: { brainClient: fakeClient(log2) } });
  check("an unchanged folder costs no model calls at all", log2.length === 0, log2.length);
  check("and every section is served from memory", brain2.sectionsFromMemory === 3 && brain2.sectionsDistilled === 0, brain2);
  check("the briefs themselves are unchanged", brain2.sections.guidelines.text === brain1.sections.guidelines.text);

  // ---- Only the kind that actually changed is re-distilled ----
  const changed = library("braintest", [
    lib.files[0],
    lib.files[1],
    file("p1", "performance", "REVISED: reels under 15s: 5.1x saves.", "2026-10-01T00:00:00Z"),
  ]);
  const log3 = [];
  const brain3 = await refreshBrain(changed, { deps: { brainClient: fakeClient(log3) } });
  check("only the changed kind is re-distilled", log3.length === 1, log3.length);
  check("and it was the performance reports", /REVISED/.test(log3[0].user), log3[0].user.slice(0, 60));
  check("the untouched briefs are kept as they were",
    brain3.sections.guidelines.text === brain1.sections.guidelines.text, brain3.sections.guidelines.text);

  // ---- A kind the brand simply doesn't have ----
  // Saying so explicitly beats leaving the section missing: "this brand has no performance
  // reports" is itself worth knowing, and a brief left over from before the files were deleted
  // would be actively misleading.
  const noPerf = library("braintest2", [file("g1", "guidelines", "Never say 'pure'.")]);
  const brain4 = await refreshBrain(noPerf, { deps: { brainClient: fakeClient([]) } });
  check("a kind with no files gets an explicit empty section, not a missing one",
    brain4.sections.performance && brain4.sections.performance.fileCount === 0 && brain4.sections.performance.text === null,
    brain4.sections.performance);

  // ---- BLAST RADIUS: one section failing must not cost the others ----
  const flaky = {
    messages: {
      create: async (params) => {
        if (/performed badly/.test(params.system)) throw new Error("model exploded");
        return { content: [{ type: "text", text: "FRESH BRIEF" }] };
      },
    },
  };
  const brain5 = await refreshBrain(library("braintest3", [
    file("g1", "guidelines", "rules here"),
    file("p1", "performance", "numbers here"),
  ]), { deps: { brainClient: flaky } });
  check("a section that fails does not stop the others", brain5.sections.guidelines.text === "FRESH BRIEF", brain5.sections.guidelines);
  check("and the failure is recorded rather than swallowed", /model exploded/.test(brain5.sections.performance.error || ""), brain5.sections.performance);

  // A later failure must not destroy a brief that was already good.
  const brain6 = await refreshBrain(library("braintest", [
    lib.files[0], lib.files[1],
    file("p1", "performance", "changed again", "2026-11-01T00:00:00Z"),
  ]), { deps: { brainClient: { messages: { create: async () => { throw new Error("down"); } } } } });
  check("a failed re-distillation keeps the last good brief rather than blanking it",
    brain6.sections.performance.text === brain3.sections.performance.text, brain6.sections.performance);

  // ---- brainToPromptText: what the stage prompts actually receive ----
  const promptText = brainToPromptText(brain1);
  check("the brief is framed as established fact, not as content to copy",
    /established fact/.test(promptText) && /not as content to copy/.test(promptText), promptText.slice(0, 200));
  check("every distilled section reaches the prompt", SECTIONS.every((s) => promptText.includes(s.heading)), promptText.slice(0, 300));

  // Null is a real answer: a brand with nothing distilled must simply not get the field, so it
  // runs exactly as it did before any of this existed.
  check("a brand with no brain yields nothing rather than an empty shell", brainToPromptText(null) === null);
  check("a brain whose sections are all empty also yields nothing",
    brainToPromptText({ sections: { guidelines: { text: null }, approved: { text: null }, performance: { text: null } } }) === null);

  // ---- A runaway brief is capped ----
  const huge = await refreshBrain(library("braintest4", [file("g1", "guidelines", "x")]),
    { deps: { brainClient: fakeClient([], () => "y".repeat(50000)) } });
  check("a section brief is capped so the brain stays promptable",
    huge.sections.guidelines.text.length === MAX_SECTION_CHARS, huge.sections.guidelines.text.length);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
