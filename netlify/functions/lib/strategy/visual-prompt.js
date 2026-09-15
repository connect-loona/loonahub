// Turning what somebody typed into the prompt an image model actually needs.
//
// THIS IS THE DIFFERENCE BETWEEN THIS AND CHATGPT, and it is worth being precise about why.
//
// The image model is the same one ChatGPT uses. What ChatGPT does that a bare API call does
// not is everything AROUND that model: it can see the whole conversation, and it silently
// rewrites your five words into a long, specific image prompt before generating anything. Type
// "make the table warmer" into ChatGPT and the image model never sees "make the table warmer"
// — it sees a paragraph reconstructing the scene, the product, the light and the framing, with
// your change applied. That rewriting is doing enormous work, and it is invisible.
//
// Without it, "make the table warmer" reaches gpt-image-1 as four words with no idea what
// table, and the result is correspondingly worse. Same engine, a fraction of the context.
//
// So this does the same job explicitly: take the short thing a person typed, the conversation
// it belongs to, and what Loona Brain already knows about the brand, and write the prompt
// ChatGPT would have written. One cheap text call, on the economy tier, because this is
// rewriting rather than judgement.
//
// It is deliberately fail-open. If the rewrite errors or no key is configured, the person's
// own words are used exactly as typed — a worse image is far better than no image, and nobody
// should be blocked from generating because a helper step had a bad minute.
"use strict";

const MAX_HISTORY_TURNS = 6;
const MAX_EXPANDED_CHARS = 3000;
const MAX_BRAIN_CHARS = 2000;

// Reference-led work is an edit, not a blank canvas. The text rewriter cannot see the
// attached pixels, so asking it to "describe the whole scene" invites it to invent a scene —
// exactly how "keep the colours same" became a dark gym with warm light. Build this prompt
// deterministically instead. The image model can see the references; the helper model cannot.
function promptForReferenceEdit(typed, referenceRoles = []) {
  const roles = referenceRoles
    .map((role, i) => String(role || "").trim() ? `Reference ${i + 1}: ${String(role).trim()}` : null)
    .filter(Boolean);
  const referenceWord = referenceRoles.length === 1 ? "image" : "images";
  const lines = [
    `Edit the attached reference ${referenceWord}. Follow this requested change exactly: ${typed}`,
    "Change only what the designer explicitly requested. Preserve every other visible detail from the reference, including the setting and background, colour palette and grade, lighting, camera angle, crop and composition, pose and action, wardrobe, objects, text, logos and surface details.",
    "Do not invent a new setting, background, prop, crop, mood, lighting treatment, colour treatment or styling direction. Do not reinterpret descriptive words as permission to redesign unrelated parts of the image.",
    "If the request says an element must remain the same, treat that as a hard constraint. Brand memory may constrain the requested change, but it must never alter unrelated reference details.",
    // The reference's own skin and material texture is one of the details that must survive
    // the edit — a model asked only to "keep everything else the same" will still often
    // re-render skin and surfaces smoother and glossier than the source, because that is its
    // own default finish, not something anyone asked for. Naming it as a constraint like any
    // other stops that default from overriding the reference.
    "Match the reference's own level of skin and surface texture exactly — same pores, fine lines, fabric weave and material grain, same amount of natural asymmetry. Do not smooth, airbrush or add a glossy, waxy or plastic finish that is not present in the reference.",
  ];
  if (roles.length) lines.push(`Use the references only for these stated roles:\n${roles.join("\n")}`);
  else if (referenceRoles.length > 1) lines.push("Use each reference only as evidence for the designer's explicit request; do not blend unrelated visual details between them.");
  return lines.join("\n\n").slice(0, MAX_EXPANDED_CHARS);
}

const SYSTEM = [
  "You write prompts for an image generation model. You are given what a designer typed, the conversation it belongs to, and what is known about the brand.",
  "Rewrite their request into ONE self-contained image prompt that the model can act on without seeing any of the context you were given.",
  "",
  "Rules:",
  "- Resolve every reference to earlier turns. \"Make the table warmer\" must become a full description of the whole scene with a warmer table, not the phrase itself.",
  "- Carry forward everything from the previous round the designer did not ask to change. What they didn't mention, they want kept.",
  "- Be concrete and visual: subject, setting, composition, lighting, camera framing, mood, finish. Describe what is in the frame, not the intent behind it.",
  "- Ask explicitly for photographic skin and surface texture — visible pores, fine lines, natural asymmetry, real fabric weave and material grain. This is a photograph, not a retouched beauty-ad render: never let the description imply airbrushed, waxy, glossy or plastic-smooth skin unless that look was actually requested.",
  "- When reference images are attached, describe what to do WITH them and what must stay untouched. Never describe the reference's contents as if generating them from scratch.",
  "- Respect the brand's own rules absolutely. Never contradict them to satisfy the request.",
  "- No preamble, no explanation, no quotes, no markdown. Output the prompt only.",
  "- Keep it under 200 words. A long prompt is not a better one past that point.",
].join("\n");

// Never hard-coded at the call site — change it here or via VISUAL_PROMPT_MODEL.
const DEFAULT_PROMPT_MODEL = "gpt-4.1-mini";

function openaiApiKey() { return process.env.OPENAI_API_KEY || ""; }

// The conversation so far, oldest first, as the rewriter needs to read it. Only the prompt and
// what was chosen: the rewriter is a text model and cannot see the images anyway, and a pick
// that says which direction the thread actually went.
function historyForPrompt(generations) {
  return (generations || [])
    .slice()
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-MAX_HISTORY_TURNS)
    .map((round, i) => {
      const picked = round.pickedIndex !== null && round.pickedIndex !== undefined;
      const chose = picked
        ? ` → they kept take ${Number(round.pickedIndex) + 1}${round.pickNote ? ` because: ${round.pickNote}` : ""}`
        : " → they didn't keep any of these";
      return `${i + 1}. "${round.prompt}"${chose}`;
    })
    .join("\n");
}

// The rewrite itself, as one provider-neutral call: instructions in, text out.
//
// This is the seam tests inject (deps.generateText). It used to be an Anthropic-shaped client
// with a fabricated model id — "claude-haiku-test-adapter" — that existed purely so an older
// test kept passing. That is a test shaping production code: the branch it created never ran
// in production, so the path that DID run had no coverage, and the fake model name sat in a
// file anybody reading it would take at face value.
async function callOpenAI(instructions, input, deps = {}) {
  const apiKey = openaiApiKey();
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await (deps.fetch || fetch)(`${base}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.VISUAL_PROMPT_MODEL || DEFAULT_PROMPT_MODEL,
      instructions,
      input,
      max_output_tokens: 700,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error && data.error.message || "OpenAI prompt rewrite failed.");
  return String(
    data.output_text
    || (data.output || []).flatMap((item) => item.content || []).filter((part) => part.type === "output_text").map((part) => part.text).join("\n"),
  ).trim();
}

// deps.generateText is injected by tests so this runs without a key or a network.
async function expandPrompt({ prompt, history, brandBrain, referenceRoles, brandRules }, deps = {}) {
  const typed = String(prompt || "").trim();
  if (!typed) return { prompt: typed, expanded: false };

  // Never let a blind text model creatively rewrite a reference edit. This path is also
  // independent of API-key availability, so the same preservation contract reaches the image
  // model in production, local development and fail-open conditions.
  if (referenceRoles && referenceRoles.length) {
    return { prompt: promptForReferenceEdit(typed, referenceRoles), expanded: true, mode: "edit" };
  }

  const generateText = deps.generateText || null;
  const apiKey = openaiApiKey();
  // No key is not an error. The person's own words still generate an image.
  if (!generateText && !apiKey) return { prompt: typed, expanded: false, reason: "No OpenAI key configured." };

  const parts = [];
  if (brandBrain) parts.push(`What we know about this brand:\n${String(brandBrain).slice(0, MAX_BRAIN_CHARS)}`);
  if (brandRules && brandRules.length) parts.push(`Rules that always apply:\n${brandRules.map((r) => `- ${r.label}`).join("\n")}`);
  if (history) parts.push(`This conversation so far:\n${history}`);
  if (referenceRoles && referenceRoles.length) {
    parts.push(`Reference images attached to THIS request, and what the designer wants taken from each:\n${referenceRoles.map((role, i) => `- Reference ${i + 1}: ${role || "(not specified — infer it)"}`).join("\n")}`);
  }
  parts.push(`What the designer just typed:\n"${typed}"`);

  try {
    // One call, one shape, whether it is a test double or the real thing — so what the tests
    // exercise is the same control flow production takes.
    const text = String(await (generateText || callOpenAI)(SYSTEM, parts.join("\n\n"), deps) || "").trim();
    if (!text) return { prompt: typed, expanded: false, reason: "The rewrite came back empty." };
    return { prompt: text.slice(0, MAX_EXPANDED_CHARS), expanded: true };
  } catch (error) {
    // Fail open, loudly in the logs and silently on screen: a worse image beats no image.
    console.error("Could not expand the image prompt:", error.message);
    return { prompt: typed, expanded: false, reason: error.message };
  }
}

module.exports = {
  expandPrompt, historyForPrompt, promptForReferenceEdit,
  SYSTEM, MAX_HISTORY_TURNS, DEFAULT_PROMPT_MODEL,
};
