// What a quality review is allowed to say, and to store.
//
// The review's whole justification is that it never turns an uncheckable claim into a green
// tick. That promise lives or dies on what happens to the model's output AFTER it comes back:
// a structured-output schema is a request, not a guarantee, and this endpoint was spreading
// the parsed object straight into the response and into the brand's permanent memory.
//
// So the model could omit a check and it would simply vanish from the panel rather than read
// as unchecked; it could invent a status and that status would be rendered; it could return a
// thousand-word summary, or extra keys, and all of it would be written to Firebase for ever.
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const {
  sanitizeQc, CHECKS, MAX_SUMMARY_CHARS, MAX_ISSUE_CHARS, MAX_ISSUES,
} = require(path.join(HUB, "netlify/functions/_legacy/visual-qc.js"));

(async () => {
  // ---- Every check is present, whatever came back ----
  const partial = sanitizeQc({ summary: "Mostly good.", checks: { prompt_match: { status: "pass", issues: [] } } });
  check("all six checks exist after sanitising", Object.keys(partial.checks).length === CHECKS.length, Object.keys(partial.checks));
  // A check the model quietly dropped must read as unchecked, not disappear. A missing row on
  // the panel is invisible; "not_checked" is a statement.
  check("a check the model omitted becomes not_checked rather than vanishing",
    partial.checks.product_identity.status === "not_checked", partial.checks.product_identity);
  check("and the one it did answer is kept", partial.checks.prompt_match.status === "pass", partial.checks.prompt_match);

  // ---- Statuses are the four we understand ----
  const invented = sanitizeQc({ summary: "x", checks: { brand_style: { status: "excellent", issues: [] } } });
  check("an invented status is not rendered as a verdict", invented.checks.brand_style.status === "not_checked", invented.checks.brand_style);
  for (const status of ["pass", "warn", "fail", "not_checked"]) {
    const ok = sanitizeQc({ summary: "x", checks: { brand_style: { status, issues: [] } } });
    check(`"${status}" survives as itself`, ok.checks.brand_style.status === status, ok.checks.brand_style.status);
  }

  // ---- Caps ----
  const long = sanitizeQc({
    summary: "s".repeat(5000),
    checks: { visual_integrity: { status: "fail", issues: ["i".repeat(2000), "b", "c", "d", "e"] } },
  });
  check("an overlong summary is capped", long.summary.length === MAX_SUMMARY_CHARS, long.summary.length);
  check("each issue is capped", long.checks.visual_integrity.issues[0].length === MAX_ISSUE_CHARS, long.checks.visual_integrity.issues[0].length);
  check("and there are never more than three issues", long.checks.visual_integrity.issues.length === MAX_ISSUES,
    long.checks.visual_integrity.issues.length);

  // ---- Nothing unexpected reaches the record ----
  // Rebuilt key by key rather than spread, so a field nobody designed for cannot end up in a
  // client's permanent memory because a model decided to include it.
  const noisy = sanitizeQc({
    summary: "Fine.", checks: {}, approved: true, score: 97, __proto__: { polluted: true },
    recommendation: "Ship it", internalNotes: "…",
  });
  check("an invented top-level field is dropped",
    !("approved" in noisy) && !("score" in noisy) && !("recommendation" in noisy), Object.keys(noisy));
  check("the stored shape is exactly what the panel knows how to read",
    Object.keys(noisy).sort().join() === "checkedAt,checkedByModel,checks,imageIndex,summary", Object.keys(noisy).sort());

  const noisyCheck = sanitizeQc({ summary: "x", checks: { text_and_logo: { status: "pass", issues: [], confidence: 0.99, verdict: "great" } } });
  check("and so is an invented field inside a check",
    Object.keys(noisyCheck.checks.text_and_logo).sort().join() === "issues,status",
    Object.keys(noisyCheck.checks.text_and_logo));

  // ---- Rubbish in ----
  for (const rubbish of [null, undefined, "a string", 42, []]) {
    const out = sanitizeQc(rubbish);
    check(`${JSON.stringify(rubbish)} still yields a complete, honest record`,
      out.summary === "" && Object.keys(out.checks).length === CHECKS.length
      && CHECKS.every((name) => out.checks[name].status === "not_checked"), out.summary);
  }

  const issuesNotArray = sanitizeQc({ summary: "x", checks: { prompt_match: { status: "fail", issues: "one big string" } } });
  check("issues that aren't a list become an empty list rather than throwing",
    Array.isArray(issuesNotArray.checks.prompt_match.issues) && issuesNotArray.checks.prompt_match.issues.length === 0,
    issuesNotArray.checks.prompt_match);

  // ---- Provenance ----
  const stamped = sanitizeQc({ summary: "x", checks: {} }, { model: "gpt-4.1", imageIndex: 2 });
  check("which model judged it is recorded", stamped.checkedByModel === "gpt-4.1", stamped.checkedByModel);
  check("and which take", stamped.imageIndex === 2, stamped.imageIndex);
  check("and when", /^\d{4}-\d{2}-\d{2}T/.test(stamped.checkedAt), stamped.checkedAt);
  check("a non-integer image index falls back to the first take rather than storing nonsense",
    sanitizeQc({}, { imageIndex: "second" }).imageIndex === 0);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
