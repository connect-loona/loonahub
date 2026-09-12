// Both models write the stage. The critic scores both. The better concept wins each slot.
//
// Until now the second provider was a spare tyre: it only ran when the first one couldn't
// answer at all. On a healthy run it was never asked anything, and the one model that did
// write also graded its own gates. This is the other arrangement — both write, an
// independent third pass scores them, and the stronger work survives per asset.
//
// Only worth doing where the judgement matters: strategy decides what the month says, copy
// decides how it says it. Research is gathering, deck-building is assembly, creative
// direction is bounded by what already exists.
"use strict";
const { reviewStage, averageScore } = require("./critic");

// Merging two portfolios is not as simple as taking the better concept in each slot. A
// strategy checkpoint has to satisfy portfolio-level rules — an exact count per format,
// pillar spread — and two models won't have put the same formats in the same slots. Swapping
// a carousel into a slot the other model filled with a reel silently breaks the format
// counts, and validateStrategy would then reject the merged result for a reason that has
// nothing to do with concept quality.
//
// So a slot is only contested when both models agree on what belongs there structurally.
// Everything else keeps the base portfolio's version.
function sameShape(a, b) {
  if (!a || !b) return false;
  if (a.assetId !== b.assetId) return false;
  // format is the constraint validation counts; when a stage's assets have no format at all
  // (copy carries it through from strategy), assetId alone is enough.
  if (a.format && b.format && a.format !== b.format) return false;
  return true;
}

function scoresById(verdict) {
  const map = new Map();
  for (const asset of (verdict && verdict.assets) || []) {
    if (asset && asset.assetId) map.set(asset.assetId, asset);
  }
  return map;
}

// Builds one output from two, taking each contested slot from whichever entry its own critic
// scored higher. `base` is the side that won overall — ties and unjudgeable slots stay with
// it, so the result is never worse than simply shipping the better of the two.
function mergeByScore(base, challenger, baseVerdict, challengerVerdict) {
  const baseScores = scoresById(baseVerdict);
  const challengerScores = scoresById(challengerVerdict);
  const challengerById = new Map((challenger.assets || []).map((a) => [a.assetId, a]));

  const swaps = [];
  const assets = (base.assets || []).map((asset) => {
    const rival = challengerById.get(asset.assetId);
    if (!sameShape(asset, rival)) return asset;
    const mine = baseScores.get(asset.assetId);
    const theirs = challengerScores.get(asset.assetId);
    if (!mine || !theirs) return asset;
    // Strictly better, not merely equal — a tie is not a reason to churn the portfolio.
    if (theirs.score > mine.score) {
      swaps.push({ assetId: asset.assetId, from: mine.score, to: theirs.score });
      return rival;
    }
    return asset;
  });

  return { merged: Object.assign({}, base, { assets }), swaps };
}

// Runs one stage on both providers at once. Promise.allSettled rather than all: one provider
// being out of credits must degrade this to an ordinary single-model stage, not fail it —
// the whole point of having two is that either can carry the run alone.
async function generateBoth(runtimes, request) {
  const results = await Promise.allSettled(runtimes.map((entry) => entry.runtime.runStage(request)));
  return results.map((result, index) => ({
    provider: runtimes[index].name,
    output: result.status === "fulfilled" ? result.value : null,
    error: result.status === "rejected" ? result.reason : null,
  }));
}

// validate: (output) => string[] of issues. Only entries that pass validation on their own
// are allowed to compete — comparing a valid portfolio against a malformed one would let a
// broken entry win a slot on a flattering score.
function usableEntries(entries, validate) {
  const usable = [];
  for (const entry of entries) {
    if (!entry.output) continue;
    let issues;
    try { issues = validate(entry.output); } catch (error) { issues = [`Validation threw: ${error.message}`]; }
    if (issues && issues.length) {
      entry.validationIssues = issues;
      continue;
    }
    usable.push(entry);
  }
  return usable;
}

module.exports = { mergeByScore, generateBoth, usableEntries, sameShape, scoresById, averageScore, reviewStage };
