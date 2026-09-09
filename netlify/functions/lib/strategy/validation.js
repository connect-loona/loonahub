// Ported verbatim (logic unchanged) from loona-strategy-agents/src/core/validation.ts,
// trimmed to validateResearch + validateStrategy for the RRO vertical slice. Port the
// remaining validators (validateCopy/validateDirection/validateDeck) the same way when
// those stages are built.
"use strict";

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

  const expectedTotal = Object.values(config.deliverables)
    .filter((value) => typeof value === "number")
    .reduce((sum, value) => sum + value, 0);
  if (output.assets.length !== expectedTotal) {
    issues.push(`Expected ${expectedTotal} assets, received ${output.assets.length}.`);
  }

  for (const format of ["reel", "carousel", "static"]) {
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
    ...research.calendar.map((entry) => entry.id),
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
          if (asset.skuIds.length === 0) issues.push(`${asset.assetId} must name at least one SKU.`);
          let anchoredSku = false;
          for (const skuId of asset.skuIds) {
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

module.exports = { validateResearch, validateStrategy };
