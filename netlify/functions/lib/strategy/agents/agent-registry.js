"use strict";

const STAGE_ORDER = ["research", "strategy", "copy", "creative-direction", "deck-builder"];

const AGENT_REGISTRY = {
  research: {
    id: "research",
    name: "Columbus",
    displayName: "👨🏻‍✈️ Columbus — Research",
    role: "Research",
    stage: "research",
    promptFile: "01-research.md",
    soulKey: "RESEARCH_SOUL",
    objective: "Return evidence the strategist could not safely invent from the client brief: audience language, disagreements, private behaviours, exhausted category patterns, timing and whitespace.",
    inputs: [
      "Brand config, monthly brief and product or portfolio facts.",
      "Drive sources, brand documents and approved-work library.",
      "Previous winners, rejections, killed concepts and human feedback.",
    ],
    memory: [
      "Past research gaps and questions that remained open.",
      "Source reliability lessons and stale-source warnings.",
      "Audience questions, permanent kill signals, winners and rejections.",
    ],
    tools: ["webSearch", "imageSearch", "googleDriveSearch", "readBrandDocuments", "readBrandLearnings"],
    guardrails: [
      "Separate evidence from inference.",
      "Preserve real audience wording and source IDs.",
      "Reject promotional, circular, stale or undated sources.",
      "Reject irrelevant search results even when they rank highly; category fit beats search position.",
      "Surface unknowns instead of smoothing them into strategy.",
    ],
    qualityChecks: ["schema", "evidence", "minimum-counts", "dates", "source-discipline", "category-relevance"],
  },
  strategy: {
    id: "strategy",
    name: "Dora",
    displayName: "🧕🏻 Dora — Strategy",
    role: "Strategy",
    stage: "strategy",
    promptFile: "02-strategy.md",
    soulKey: "STRATEGY_SOUL",
    objective: "Turn approved evidence into one varied monthly system that only the brand could credibly publish.",
    inputs: [
      "Approved Columbus research handoff.",
      "Brand config, deliverable counts, portfolio rules and product rules.",
      "Killed concepts, prior winners and production constraints.",
    ],
    memory: [
      "Permanent concept kills and client rejection reasons.",
      "Approved territories and overused mechanisms.",
      "Portfolio balance lessons and production constraints.",
    ],
    tools: [],
    guardrails: [
      "Pass the logo-swap test.",
      "Respect the exhausted-territory kill list.",
      "Each concept needs a one-sentence tension.",
      "Hooks must be actual publishable words.",
      "Preserve exact portfolio, SKU and deliverable discipline.",
      "When the brand is food, hospitality, retail or lifestyle, ground the concept in that world instead of generic software, productivity or office metaphors.",
    ],
    qualityChecks: ["concept-gates", "counts", "portfolio-discipline", "kill-list", "hook-language", "category-fit"],
  },
  copy: {
    id: "copy",
    name: "Matilda",
    displayName: "👩‍🎨 Matilda — Copy",
    role: "Copy",
    stage: "copy",
    promptFile: "03-copy.md",
    soulKey: "COPY_SOUL",
    objective: "Create hooks, on-creative copy, reel scripts and three meaningfully different caption options per asset without violating facts or claims.",
    inputs: [
      "Approved Dora strategy and original research evidence.",
      "Brand voice, house rules and copyStructure.",
      "Portfolio naming, approved facts, claimRules and prohibited claims.",
    ],
    memory: [
      "Accepted copy patterns and client edits.",
      "Banned language, portfolio voice differences and claim failures.",
      "Caption angles that were accepted, revised or rejected.",
    ],
    tools: [],
    guardrails: [
      "Claim rules outrank the concept.",
      "Write the strongest safe version when proof is missing and flag the claim.",
      "Preserve approved product, portfolio and hook language.",
      "Three captions must differ in angle and rhythm.",
      "Write in the brand's category vocabulary; food, retail and lifestyle brands should sound sensory and human, not like SaaS or productivity copy.",
      "If the user asks for a refinement, answer that exact note first before improving anything else.",
      "Avoid empty advertising cliches and generic engagement prompts.",
    ],
    qualityChecks: ["claim-rules", "caption-count", "portfolio-voice", "hook-preservation", "duration", "note-obedience", "category-language"],
  },
  "creative-direction": {
    id: "creative-direction",
    name: "Barbie",
    displayName: "👩🏼‍🎤 Barbie — Creative Direction",
    role: "Creative Direction",
    stage: "creative-direction",
    promptFile: "04-creative-direction.md",
    soulKey: "CREATIVE_DIRECTION_SOUL",
    objective: "Convert approved concepts and copy into visual direction a designer, photographer or editor can execute.",
    inputs: [
      "Approved research, strategy and copy.",
      "Brand visual rules, approved assets and approved-work library.",
      "Format, aspect ratio, products and production constraints.",
    ],
    memory: [
      "Approved visual grammar and rejected references.",
      "Production feasibility lessons.",
      "Known pack, logo, colour and product accuracy issues.",
    ],
    tools: ["webSearch", "imageSearch", "googleDriveSearch", "readBrandAssets"],
    guardrails: [
      "References support a transferable principle; they are not instructions to copy.",
      "Every reference requires a working source.",
      "Every reference must match the asset's category, format and visible production need; reject off-category links even if the title has a useful word.",
      "For food, cafe, restaurant or FMCG work, references must show food, drink, packaging, retail, hospitality, people eating, menu culture or comparable sensory/lifestyle scenes; never use unrelated software tutorials, office videos, Excel screens, dashboards or productivity content.",
      "If a strong matching reference cannot be found, say reference_unavailable and describe the visual principle instead of adding a weak link.",
      "Describe why each reference is relevant in one sentence using visible details from the page or image.",
      "Describe visible decisions, not vague words such as premium or dynamic.",
      "Respect product, pack, logo, colour and production reality.",
    ],
    qualityChecks: ["references", "reference-category-fit", "source-working", "no-off-category-links", "shot-list", "brand-visuals", "production-feasibility", "format"],
  },
  "deck-builder": {
    id: "deck-builder",
    name: "Bob",
    displayName: "👷🏾 Bob — Deck Builder",
    role: "Deck Builder",
    stage: "deck-builder",
    promptFile: "05-deck-builder.md",
    soulKey: "DECK_BUILDER_SOUL",
    objective: "Assemble approved decisions into a deck the team can scan, assign and produce without interpretation gaps.",
    inputs: [
      "All approved specialist outputs.",
      "Brand config, asset order and approval state.",
      "Deck template rules and available reference assets.",
    ],
    memory: [
      "Deck feedback and field-order preferences.",
      "Export errors and slide-density lessons.",
      "Missing-handoff patterns from past production work.",
    ],
    tools: ["generateJson", "generatePptx", "downloadReferences", "canvaPublisherWhenEnabled"],
    guardrails: [
      "Never invent missing content.",
      "Every approved asset appears exactly once.",
      "Preserve approved words, references and order.",
      "Keep claims-to-verify and dependencies visible.",
      "Drop or mark weak references instead of passing bad links into the deck.",
      "Canva failure must never block JSON or PPTX.",
    ],
    qualityChecks: ["page-count", "field-preservation", "json-export", "pptx-export", "canva-gate", "reference-sanity"],
  },
  "concept-refinement": {
    id: "concept-refinement",
    name: "Dora",
    displayName: "🧕🏻 Dora — Concept Refinement",
    role: "Concept Refinement",
    stage: "strategy",
    promptFile: "06-concept-refine.md",
    soulKey: "CONCEPT_REFINEMENT_SOUL",
    objective: "Refine, replace or suggest one concept while preserving the asset identity and all approved constraints around it.",
    inputs: ["Original approved strategy asset.", "Human notes or requested replacement mode.", "Brand config, research brief, kill list and learnings."],
    memory: ["Concept-level rejection reasons.", "Human refinement notes.", "Permanent kill signals and successful replacement patterns."],
    tools: [],
    guardrails: [
      "Do not change unrelated assets.",
      "Preserve assetId and required format.",
      "Start by satisfying the user's exact requested change; only then improve clarity, tension or feasibility.",
      "If the note is ambiguous, make the smallest reasonable interpretation and state the assumption in the returned rationale.",
      "Do not bypass gates that failed in the original strategy stage."
    ],
    qualityChecks: ["single-asset-scope", "identity-preservation", "concept-gates", "note-obedience"],
  },
  "copy-refinement": {
    id: "copy-refinement",
    name: "Matilda",
    displayName: "👩‍🎨 Matilda — Copy Refinement",
    role: "Copy Refinement",
    stage: "copy",
    promptFile: "07-copy-refine.md",
    soulKey: "COPY_REFINEMENT_SOUL",
    objective: "Refine or replace one copy asset while protecting the approved concept, hook, facts and claims discipline.",
    inputs: ["Original approved copy asset.", "Human notes or replacement mode.", "Brand voice, claim rules and strategy context."],
    memory: ["Copy-level rejection reasons.", "Claim failures and accepted rewrites.", "Caption angle patterns that worked for this brand."],
    tools: [],
    guardrails: [
      "Do not silently rewrite Dora's approved hook.",
      "Do not add unverified claims.",
      "Do not change unrelated assets.",
      "Start by satisfying the user's exact requested change; keep everything else stable unless it directly improves that request.",
      "Return a short note explaining which part of the user's feedback was addressed."
    ],
    qualityChecks: ["single-asset-scope", "claim-rules", "hook-preservation", "note-obedience"],
  },
};

function agentForStage(stage) {
  return AGENT_REGISTRY[stage] || null;
}

function agentForPrompt(promptFile) {
  return Object.values(AGENT_REGISTRY).find((agent) => agent.promptFile === promptFile) || null;
}

function renderAgentAnatomy(agent) {
  if (!agent) throw new Error("Cannot render missing Strategy OS agent anatomy.");
  const list = (label, values) => {
    if (!values || values.length === 0) return `## ${label}\n- None allowed unless BB Loona explicitly provides them.`;
    return `## ${label}\n${values.map((value) => `- ${value}`).join("\n")}`;
  };
  return [
    `# Formal agent anatomy — ${agent.displayName}`,
    `## Objective\n${agent.objective}`,
    list("Inputs", agent.inputs),
    list("Memory to retrieve", agent.memory),
    list("Allowed tools", agent.tools),
    list("Guardrails", agent.guardrails),
    list("Quality checks", agent.qualityChecks),
    "## Operating contract\n- Use this anatomy as your stage boundary.\n- Do not claim another specialist's authority.\n- Do not approve your own work or unlock a later stage.\n- Return only the schema requested by this stage.",
  ].join("\n\n");
}

function assertCompleteRegistry() {
  const missing = [];
  for (const stage of STAGE_ORDER) {
    const agent = AGENT_REGISTRY[stage];
    if (!agent) missing.push(`${stage}: missing agent`);
    if (agent && agent.stage !== stage) missing.push(`${stage}: stage mismatch`);
    for (const key of ["id", "name", "displayName", "role", "stage", "promptFile", "soulKey", "objective"]) {
      if (!agent || !agent[key]) missing.push(`${stage}: missing ${key}`);
    }
    for (const key of ["inputs", "memory", "tools", "guardrails", "qualityChecks"]) {
      if (!agent || !Array.isArray(agent[key])) missing.push(`${stage}: ${key} must be an array`);
    }
  }
  if (missing.length) throw new Error(`Incomplete Strategy OS agent registry:\n${missing.join("\n")}`);
  return true;
}

assertCompleteRegistry();

module.exports = { STAGE_ORDER, AGENT_REGISTRY, agentForStage, agentForPrompt, renderAgentAnatomy, assertCompleteRegistry };
