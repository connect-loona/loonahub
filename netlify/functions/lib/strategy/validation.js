// Ported verbatim (logic unchanged) from loona-strategy-agents/src/core/validation.ts,
// except validateStrategy's per-format deliverable check below, which was generalized from
// a hardcoded reel/carousel/static loop to every format the pipeline actually knows how to
// generate (see SUPPORTED_ASSET_FORMATS) — BrandConfigSchema.deliverables can now carry
// additional named counts (e.g. "blog") that aren't a real AssetFormatSchema format yet, so
// this can no longer assume every one of its keys is an enforceable per-asset count.
"use strict";
const { AssetFormatSchema } = require("./contracts");

// Formats the strategy stage can actually assign to a generated asset today. A brand's
// `deliverables` may list other named counts too (see contracts.js's own comment on that
// field) — those are recorded and counted toward planning totals elsewhere, but never
// enforced here, since the pipeline has no way to produce an asset in an unsupported
// format.
const SUPPORTED_ASSET_FORMATS = AssetFormatSchema.options;

const DESCRIPTIVE_HOOK_PATTERNS = [
  /^education\b/i,
  /^awareness\b/i,
  /\bpost about\b/i,
  /\bcontent about\b/i,
  /\bcarousel (about|on)\b/i,
  /\breel (about|on)\b/i,
  /\bshowcase\b/i,
  /\brecipe reel\b/i,
];

const TOPIC_AS_TENSION_PATTERNS = [
  /\bteach(es|ing)?\b/i,
  /\beducat(e|es|ing|ion)\b/i,
  /\binform(s|ing|ation)?\b/i,
  /\buseful (tip|information|content)\b/i,
];

function normalise(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Firebase RTDB doesn't round-trip empty arrays — writing `frames: []` (a real, valid
// value for a non-carousel copy asset) results in the key being dropped entirely, so a
// later fbGet() of that same checkpoint comes back with `frames` missing rather than `[]`.
// Confirmed live: a deck run crashed with "copyAsset.onCreative.frames is not iterable"
// after Copy had already been approved and reloaded from Firebase for the Deck stage.
// Every array field in these schemas that CAN legitimately be empty (no Zod `.min()`) is
// at risk the moment it's read from a checkpoint rather than fresh model output, so this
// wraps every such access rather than trusting the field is still an array.
function safeArray(value) {
  return value || [];
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validateResearch(output, config, month) {
  const issues = [];
  if (output.brandId !== config.id) issues.push(`brandId must be ${config.id}.`);
  if (output.month !== month) issues.push(`month must be ${month}.`);
  if (output.liveQuestions.length < 8) issues.push("At least 8 liveQuestions are required.");
  if (output.exhaustedTerritory.length < 6) issues.push("At least 6 exhaustedTerritory entries are required.");
  if (output.unspokenBehaviours.length < 3) issues.push("At least 3 unspokenBehaviours are required.");
  if (output.arguments.length < 2) issues.push("At least 2 real category arguments are required.");

  const sourceIds = new Set(output.sources.map((source) => source.id));
  const conversationalTypes = new Set(["forum", "comment", "review", "search"]);
  let conversationalQuestionCount = 0;

  for (const question of output.liveQuestions) {
    if (question.verbatim.split(/\s+/).length < 3) {
      issues.push(`Live question ${question.id} is too short to preserve meaningful real wording.`);
    }
    for (const sourceId of question.sourceIds) {
      if (!sourceIds.has(sourceId)) issues.push(`Live question ${question.id} cites missing source ${sourceId}.`);
      const source = output.sources.find((candidate) => candidate.id === sourceId);
      if (source && conversationalTypes.has(source.type)) conversationalQuestionCount += 1;
    }
  }
  if (conversationalQuestionCount < 6) {
    issues.push("At least 6 live questions must cite forum, comment, review or search-language sources.");
  }

  const evidenceGroups = [
    ...output.arguments.map((entry) => ({ id: entry.id, sourceIds: entry.sourceIds })),
    ...output.unspokenBehaviours.map((entry) => ({ id: entry.id, sourceIds: entry.sourceIds })),
    ...output.whitespace.map((entry) => ({ id: entry.id, sourceIds: entry.sourceIds })),
    ...output.calendar.map((entry) => ({ id: entry.id, sourceIds: entry.sourceIds })),
    ...output.verifiedFacts.map((entry) => ({ id: entry.fact, sourceIds: entry.sourceIds })),
  ];
  for (const group of evidenceGroups) {
    for (const sourceId of group.sourceIds) {
      if (!sourceIds.has(sourceId)) issues.push(`${group.id} cites missing source ${sourceId}.`);
    }
  }

  const duplicateSourceIds = duplicateValues(output.sources.map((source) => source.id));
  if (duplicateSourceIds.length) issues.push(`Duplicate source IDs: ${duplicateSourceIds.join(", ")}.`);

  for (const source of output.sources) {
    try {
      const url = new URL(source.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
    } catch {
      issues.push(`Source ${source.id} has an invalid public URL.`);
    }
  }

  return [...new Set(issues)];
}

function validateStrategy(output, config, research, learnings, month) {
  const issues = [];
  if (output.brandId !== config.id) issues.push(`brandId must be ${config.id}.`);
  if (output.month !== month) issues.push(`month must be ${month}.`);

  // Only sum/enforce counts for formats the strategy stage can actually produce — an
  // unsupported deliverable line item (e.g. "blog") is real config the brand cares about,
  // but isn't a target this stage could ever hit, so it's excluded from both the total and
  // the per-format check below rather than being an unsatisfiable requirement forever.
  const expectedTotal = SUPPORTED_ASSET_FORMATS
    .map((format) => config.deliverables[format])
    .filter((value) => typeof value === "number")
    .reduce((sum, value) => sum + value, 0);
  if (output.assets.length !== expectedTotal) {
    issues.push(`Expected ${expectedTotal} assets, received ${output.assets.length}.`);
  }

  for (const format of SUPPORTED_ASSET_FORMATS) {
    if (typeof config.deliverables[format] !== "number") continue;
    const actual = output.assets.filter((asset) => asset.format === format).length;
    if (actual !== config.deliverables[format]) {
      issues.push(`Expected ${config.deliverables[format]} ${format} assets, received ${actual}.`);
    }
  }

  const researchIds = new Set([
    ...research.liveQuestions.map((entry) => entry.id),
    ...research.arguments.map((entry) => entry.id),
    ...research.unspokenBehaviours.map((entry) => entry.id),
    ...research.exhaustedTerritory.map((entry) => entry.id),
    ...research.whitespace.map((entry) => entry.id),
    ...safeArray(research.calendar).map((entry) => entry.id),
  ]);
  const pillarIds = new Set(config.pillars.map((pillar) => pillar.id));
  const assetIds = output.assets.map((asset) => asset.assetId);
  const duplicateAssetIds = duplicateValues(assetIds);
  if (duplicateAssetIds.length) issues.push(`Duplicate asset IDs: ${duplicateAssetIds.join(", ")}.`);
  const duplicateHooks = duplicateValues(output.assets.map((asset) => normalise(asset.hook)));
  if (duplicateHooks.length) issues.push("Hooks must be unique across the month.");

  output.assets.forEach((asset, index) => {
    if (asset.sequence !== index + 1) issues.push(`${asset.assetId} has sequence ${asset.sequence}; expected ${index + 1}.`);
    if (!pillarIds.has(asset.pillarId)) issues.push(`${asset.assetId} uses unknown pillar ${asset.pillarId}.`);
    if (asset.hook.split(/\s+/).length < 4) issues.push(`${asset.assetId} hook is too thin to be a finished opening line.`);
    if (DESCRIPTIVE_HOOK_PATTERNS.some((pattern) => pattern.test(asset.hook))) {
      issues.push(`${asset.assetId} hook describes an approach instead of giving the actual words.`);
    }
    if (TOPIC_AS_TENSION_PATTERNS.some((pattern) => pattern.test(asset.tension))) {
      issues.push(`${asset.assetId} tension reads like usefulness or education, not human friction.`);
    }
    if (!asset.gate.logoSwapPass || !asset.gate.killListPass || !asset.gate.tensionPass || !asset.gate.overheardPass) {
      issues.push(`${asset.assetId} did not pass every concept gate.`);
    }
    for (const exhausted of research.exhaustedTerritory) {
      const territory = normalise(exhausted.territory);
      if (
        territory.length >= 10 &&
        [asset.conceptName, asset.hook, asset.concept].some((value) => normalise(value).includes(territory))
      ) {
        issues.push(`${asset.assetId} repeats exhausted territory "${exhausted.territory}".`);
      }
    }
    for (const researchId of asset.researchIds) {
      if (!researchIds.has(researchId)) issues.push(`${asset.assetId} cites unknown research insight ${researchId}.`);
    }

    const killedText = normalise(learnings);
    if (
      killedText.includes(normalise(asset.conceptName)) ||
      (normalise(asset.hook).length > 20 && killedText.includes(normalise(asset.hook)))
    ) {
      issues.push(`${asset.assetId} repeats a concept or hook found in the learnings kill history.`);
    }

    if (config.portfolios.length > 0) {
      if (!asset.portfolioId) {
        issues.push(`${asset.assetId} must name a portfolio.`);
      } else {
        const portfolio = config.portfolios.find((candidate) => candidate.id === asset.portfolioId);
        if (!portfolio) {
          issues.push(`${asset.assetId} uses unknown portfolio ${asset.portfolioId}.`);
        } else {
          const anchors = new Set(asset.brandAnchors.map(normalise));
          if (!anchors.has(normalise(portfolio.name))) {
            issues.push(`${asset.assetId} brandAnchors must include exact portfolio name ${portfolio.name}.`);
          }
          if (safeArray(asset.skuIds).length === 0) issues.push(`${asset.assetId} must name at least one SKU.`);
          let anchoredSku = false;
          for (const skuId of safeArray(asset.skuIds)) {
            const product = portfolio.products.find((candidate) => candidate.id === skuId);
            if (!product) {
              issues.push(`${asset.assetId} uses SKU ${skuId} outside portfolio ${portfolio.id}.`);
            } else if (anchors.has(normalise(product.name))) {
              anchoredSku = true;
            }
          }
          if (!anchoredSku) issues.push(`${asset.assetId} brandAnchors must include at least one exact selected SKU name.`);
        }
      }
    }
  });

  return [...new Set(issues)];
}

function sameStringSet(a, b) {
  a = safeArray(a); b = safeArray(b);
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}

function selectedProducts(config, portfolioId, skuIds) {
  const portfolio = config.portfolios.find((candidate) => candidate.id === portfolioId);
  if (!portfolio) return [];
  return portfolio.products.filter((product) => safeArray(skuIds).includes(product.id));
}

function allCopyText(asset) {
  return [
    asset.hook,
    asset.onCreative.cover,
    ...safeArray(asset.onCreative.frames).map((frame) => `${frame.label} ${frame.text}`),
    asset.onCreative.endFrame,
    ...safeArray(asset.script.scenes).flatMap((scene) => [scene.voiceover, scene.onScreenText]),
    ...asset.captions.map((caption) => `${caption.copy} ${safeArray(caption.hashtags).join(" ")}`),
  ].join("\n");
}

function validateCopy(output, config, strategy, month) {
  const issues = [];
  if (output.brandId !== config.id) issues.push(`brandId must be ${config.id}.`);
  if (output.month !== month) issues.push(`month must be ${month}.`);
  if (output.assets.length !== strategy.assets.length) issues.push("Copy must contain exactly one entry per strategy asset.");

  const strategyById = new Map(strategy.assets.map((asset) => [asset.assetId, asset]));
  const duplicateIds = duplicateValues(output.assets.map((asset) => asset.assetId));
  if (duplicateIds.length) issues.push(`Duplicate copy asset IDs: ${duplicateIds.join(", ")}.`);

  for (const asset of output.assets) {
    const strategyAsset = strategyById.get(asset.assetId);
    if (!strategyAsset) {
      issues.push(`Copy contains unknown asset ${asset.assetId}.`);
      continue;
    }
    if (asset.format !== strategyAsset.format) issues.push(`${asset.assetId} changed format.`);
    if (asset.portfolioId !== strategyAsset.portfolioId) issues.push(`${asset.assetId} changed portfolio.`);
    if (!sameStringSet(asset.skuIds, strategyAsset.skuIds)) issues.push(`${asset.assetId} changed its SKU set.`);

    const products = selectedProducts(config, asset.portfolioId, asset.skuIds);
    const expectedNames = products.map((product) => product.name);
    if (!sameStringSet(asset.skuNames, expectedNames)) issues.push(`${asset.assetId} must carry exact configured SKU names.`);
    const portfolio = config.portfolios.find((candidate) => candidate.id === asset.portfolioId);
    if ((portfolio?.name ?? null) !== asset.portfolioName) issues.push(`${asset.assetId} must carry the exact portfolio name.`);

    const captionVersions = asset.captions.map((caption) => caption.version).join("");
    if (captionVersions !== "ABC") issues.push(`${asset.assetId} captions must be ordered A, B, C.`);
    if (new Set(asset.captions.map((caption) => normalise(caption.copy))).size !== 3) {
      issues.push(`${asset.assetId} needs three genuinely distinct caption bodies.`);
    }
    if (asset.format === "reel" && (asset.script.durationSeconds <= 0 || safeArray(asset.script.scenes).length < 2)) {
      issues.push(`${asset.assetId} reel needs a timed multi-scene script.`);
    }
    if (asset.format !== "reel" && (asset.script.durationSeconds !== 0 || safeArray(asset.script.scenes).length !== 0)) {
      issues.push(`${asset.assetId} is not a reel; its script must be empty with durationSeconds 0.`);
    }

    const copyText = allCopyText(asset);
    for (const bannedWord of config.voice.bannedWords) {
      const pattern = new RegExp(`\\b${bannedWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (pattern.test(copyText)) issues.push(`${asset.assetId} uses banned word "${bannedWord}".`);
    }

    const applicableRules = config.claimRules.filter(
      (rule) => rule.portfolioIds.length === 0 || (asset.portfolioId && rule.portfolioIds.includes(asset.portfolioId)),
    );
    for (const rule of applicableRules) {
      if (!safeArray(asset.claimAudit.rulesChecked).includes(rule.id)) {
        issues.push(`${asset.assetId} did not record claim rule ${rule.id} as checked.`);
      }
      for (const trigger of rule.triggerPatterns) {
        const triggerPattern = new RegExp(trigger, "i");
        if (!triggerPattern.test(copyText)) continue;
        const approved = products.some((product) =>
          [product.name, ...safeArray(product.approvedClaims), ...safeArray(product.approvedFacts)].some((claim) => triggerPattern.test(claim)),
        );
        const flagged = safeArray(asset.claimAudit.verificationFlags).some((flag) => flag.ruleId === rule.id);
        if (!approved && !flagged) {
          issues.push(`${asset.assetId} uses language matching claim rule ${rule.id} without configured approval or a flag.`);
        }
        if (rule.action === "block" && asset.claimAudit.status !== "blocked") {
          issues.push(`${asset.assetId} triggered blocking claim rule ${rule.id} but is not marked blocked.`);
        }
      }
    }
    if (safeArray(asset.claimAudit.verificationFlags).length > 0 && asset.claimAudit.status === "ready") {
      issues.push(`${asset.assetId} has verification flags but is marked ready.`);
    }
    if (asset.claimAudit.status === "blocked" && safeArray(asset.claimAudit.verificationFlags).length === 0) {
      issues.push(`${asset.assetId} is blocked without a visible verification flag.`);
    }
  }

  for (const strategyAsset of strategy.assets) {
    if (!output.assets.some((asset) => asset.assetId === strategyAsset.assetId)) {
      issues.push(`Copy is missing ${strategyAsset.assetId}.`);
    }
  }
  return [...new Set(issues)];
}

function validateDirection(output, config, strategy, month) {
  const issues = [];
  if (output.brandId !== config.id) issues.push(`brandId must be ${config.id}.`);
  if (output.month !== month) issues.push(`month must be ${month}.`);
  if (output.assets.length !== strategy.assets.length) issues.push("Direction must contain exactly one entry per strategy asset.");

  const strategyById = new Map(strategy.assets.map((asset) => [asset.assetId, asset]));
  const duplicateIds = duplicateValues(output.assets.map((asset) => asset.assetId));
  if (duplicateIds.length) issues.push(`Duplicate direction asset IDs: ${duplicateIds.join(", ")}.`);

  for (const asset of output.assets) {
    const strategyAsset = strategyById.get(asset.assetId);
    if (!strategyAsset) {
      issues.push(`Direction contains unknown asset ${asset.assetId}.`);
      continue;
    }
    if (asset.format !== strategyAsset.format) issues.push(`${asset.assetId} changed format in direction.`);
    if (asset.portfolioId !== strategyAsset.portfolioId) issues.push(`${asset.assetId} changed portfolio in direction.`);
    if (!sameStringSet(asset.skuIds, strategyAsset.skuIds)) issues.push(`${asset.assetId} changed SKU set in direction.`);
    if (asset.format === "reel" && safeArray(asset.shotList).length < 3) issues.push(`${asset.assetId} reel needs at least 3 shots.`);
    for (const reference of safeArray(asset.references)) {
      const useFor = normalise(reference.useFor || "");
      if (!useFor || /^(none|na|n a|not applicable|unknown|tbd|placeholder)$/.test(useFor)) {
        issues.push(`${asset.assetId} reference "${reference.title}" must explain exactly what the team should use it for.`);
      } else if (useFor.split(/\s+/).length < 4) {
        issues.push(`${asset.assetId} reference "${reference.title}" has a useFor note that is too vague.`);
      }
      try {
        const url = new URL(reference.url);
        if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
        const host = url.hostname.replace(/^www\./, "");
        const isSearchResult =
          ((host === "google.com" || host.endsWith(".google.com")) && url.pathname === "/search") ||
          ((host === "bing.com" || host.endsWith(".bing.com")) && url.pathname.startsWith("/search")) ||
          ((host === "youtube.com" || host.endsWith(".youtube.com")) && url.pathname.startsWith("/results")) ||
          ((host === "pinterest.com" || host.endsWith(".pinterest.com")) && url.pathname.startsWith("/search"));
        if (isSearchResult) issues.push(`${asset.assetId} reference "${reference.title}" points to search results, not a stable source.`);
      } catch {
        issues.push(`${asset.assetId} contains an invalid reference URL.`);
      }

      // A reference can come from another category when the art-direction lesson is clear,
      // but its title/use note still needs a concrete connection to this asset. Requiring
      // one non-generic shared term catches unrelated links without banning legitimate
      // cross-category visual inspiration.
      const generic = new Set(["reference", "visual", "style", "image", "video", "reel", "post", "look", "feel", "shot", "frame", "use", "for", "the", "and", "with", "from", "this", "that"]);
      const words = (value) => new Set(normalise(value).split(/\s+/).filter((word) => word.length >= 4 && !generic.has(word)));
      const referenceWords = words(`${reference.title} ${reference.useFor || ""}`);
      const assetWords = words([
        strategyAsset.hook,
        strategyAsset.concept,
        asset.visualConcept,
        asset.artDirection,
        asset.composition,
        ...safeArray(asset.designNotes),
        ...safeArray(asset.referenceQueries),
        ...safeArray(asset.shotList).flatMap((shot) => [shot.action, shot.framing, shot.onScreenText || ""]),
      ].join(" "));
      if (![...referenceWords].some((word) => assetWords.has(word))) {
        issues.push(`${asset.assetId} reference "${reference.title}" is not visibly relevant to this asset's direction.`);
      }
    }
  }
  return [...new Set(issues)];
}

function includesNormalised(haystack, needle) {
  return normalise(haystack).includes(normalise(needle));
}

function validateDeck(output, config, strategy, copy, direction, month) {
  const issues = [];
  if (output.brandId !== config.id) issues.push(`brandId must be ${config.id}.`);
  if (output.month !== month) issues.push(`month must be ${month}.`);
  if (output.pages.length !== strategy.assets.length) issues.push("Deck must contain exactly one page per asset.");

  const copyById = new Map(copy.assets.map((asset) => [asset.assetId, asset]));
  const directionById = new Map(direction.assets.map((asset) => [asset.assetId, asset]));
  const duplicateIds = duplicateValues(output.pages.map((page) => page.assetId));
  if (duplicateIds.length) issues.push(`Duplicate deck pages: ${duplicateIds.join(", ")}.`);

  output.pages.forEach((page, index) => {
    const strategyAsset = strategy.assets[index];
    if (!strategyAsset) return;
    if (page.pageNumber !== index + 1) issues.push(`${page.assetId} has incorrect pageNumber.`);
    if (page.assetId !== strategyAsset.assetId) issues.push(`Page ${index + 1} must be ${strategyAsset.assetId}.`);
    if (page.format !== strategyAsset.format) issues.push(`${page.assetId} changed format in deck.`);
    if (page.idea !== strategyAsset.concept) issues.push(`${page.assetId} idea must be copied exactly from strategy.`);

    const copyAsset = copyById.get(page.assetId);
    const directionAsset = directionById.get(page.assetId);
    if (!copyAsset || !directionAsset) return;
    if (page.hook !== copyAsset.hook) issues.push(`${page.assetId} hook must be copied exactly from copy.`);
    if (page.captionOne !== copyAsset.captions[0]?.copy) issues.push(`${page.assetId} caption A changed in deck.`);
    if (page.captionTwo !== copyAsset.captions[1]?.copy) issues.push(`${page.assetId} caption B changed in deck.`);
    if (page.captionThree !== copyAsset.captions[2]?.copy) issues.push(`${page.assetId} caption C changed in deck.`);
    if (!includesNormalised(page.creativeCopy, copyAsset.onCreative.cover)) {
      issues.push(`${page.assetId} creativeCopy is missing the exact cover line.`);
    }
    for (const frame of safeArray(copyAsset.onCreative.frames)) {
      if (!includesNormalised(page.creativeCopy, frame.text)) {
        issues.push(`${page.assetId} creativeCopy omitted frame "${frame.label}".`);
      }
    }
    if (!includesNormalised(page.direction, directionAsset.visualConcept)) {
      issues.push(`${page.assetId} direction omitted the visual concept.`);
    }
    if (page.referenceImageUrl !== directionAsset.references[0]?.url) {
      issues.push(`${page.assetId} must use its first approved reference URL as the primary reference.`);
    }
  });

  return [...new Set(issues)];
}

// Turns "note-obedience" (listed as a quality check for Copy, Concept Refinement and Copy
// Refinement in agent-registry.js) from a line in the prompt into an actual, deterministic
// check — the same repair-loop mechanism every other validator here already feeds into
// (see proposeAssetCandidate in pipeline.js). Only applies to `refine` requests with real
// notes; `similar`/`discard`/`replace` have no notes to be obedient to.
//
// This is deliberately conservative, not a general "did the model do what I asked" judge
// (that would need its own model call and would risk false-positive rejections burning the
// repair budget on a request phrased in a way this can't parse). It only checks two things
// a plain-text scan can verify reliably:
//   1. A phrase the reviewer put in quotes — if they wrote out exact words they want used,
//      those words must actually appear somewhere in the response.
//   2. An explicit CTA ("CTA"/"call to action") request — checked against a small list of
//      common CTA-shaped verbs, since this was the literal reported failure (a note asking
//      for a CTA that never visibly landed in the output).
// Everything else the notes might ask for is still addressed via the composed prompt's own
// "start by satisfying the user's exact requested change" instruction — it just isn't
// mechanically enforced here.
const CTA_VERB_PATTERN = /\b(shop|buy|order|try|get yours|visit|learn more|sign up|book|grab|swap|dm us|link in bio|tap|swipe up|call us|message us|reach out|explore|discover|head to|check out)\b/i;

function checkNoteObedience(requestType, notes, candidateText) {
  if (requestType !== "refine" || !notes) return [];
  const issues = [];
  const text = candidateText || "";
  const quoted = [...notes.matchAll(/["“]([^"”]{4,})["”]/g)].map((m) => m[1].trim());
  for (const phrase of quoted) {
    if (!normalise(text).includes(normalise(phrase))) {
      issues.push(`The notes asked for the exact phrase "${phrase}" — it isn't found anywhere in the response.`);
    }
  }
  if (/\bctas?\b|\bcall[- ]to[- ]actions?\b/i.test(notes) && !CTA_VERB_PATTERN.test(text)) {
    issues.push("The notes asked for a call-to-action (CTA) — no CTA-shaped language was found anywhere in the response.");
  }
  return issues;
}

module.exports = { validateResearch, validateStrategy, validateCopy, validateDirection, validateDeck, allCopyText, checkNoteObedience };
