// POST { brandId, question } -> { answer } | { nothingRecorded: true, detail }
//
// Asking 🧠 Mani something about a brand. See lib/strategy/mani.js for why the honest
// "nothing recorded" answer is a first-class result rather than a failure.
//
// Kept small on purpose: Mani holds no state of his own. He reads the same composed brand
// memory the stage prompts already receive, so there is exactly one definition of what Loona
// remembers about a brand and no second copy to drift.
"use strict";
const { checkAuthorization } = require("./lib/strategy/auth");
const { hubBrandExists, findHubBrand } = require("./lib/strategy/hub-brands");
const { loadBrandBrain } = require("./lib/strategy/store");
const { askMani, MAX_QUESTION_CHARS } = require("./lib/strategy/mani");
const { loadHubMemoryText } = require("./lib/strategy/hub-memory");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function fail(statusCode, error) {
  return { statusCode, headers: cors(), body: JSON.stringify({ error }) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  // Costs a model call, and reads a client's accumulated memory. Never open.
  const auth = checkAuthorization(event);
  if (!auth.ok) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Unauthorized", reason: auth.reason }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return fail(400, "Invalid JSON"); }

  const question = String(body.question || "").trim();
  if (!question) return fail(400, "Ask Mani something.");
  if (question.length > MAX_QUESTION_CHARS) return fail(400, `Keep the question under ${MAX_QUESTION_CHARS} characters.`);

  // No brandId is a legitimate way to ask — and the more natural one from anywhere in Hub.
  // "What is Anjali working on?" and "what's overdue?" belong to no single brand, so
  // demanding one up front makes the questions people actually ask unanswerable.
  const brandId = String(body.brandId || "").trim();
  let brand = null;
  let memory = null;
  let scope = "hub";

  if (brandId) {
    if (!/^[a-z0-9-]+$/.test(brandId)) return fail(400, "brandId must be lowercase letters, numbers or hyphens.");
    if (!(await hubBrandExists(brandId))) return fail(404, "Brand not found in Hub.");
    brand = await findHubBrand(brandId);
    memory = await loadBrandBrain(brandId, brand && brand.name);
    scope = "brand";
  } else {
    memory = await loadHubMemoryText();
  }

  try {
    const result = await askMani({ brandId, brandName: brand && brand.name, question, memory, scope });
    return { statusCode: 200, headers: cors(), body: JSON.stringify(result) };
  } catch (error) {
    const missingKey = /ANTHROPIC_API_KEY/.test(error.message || "");
    return fail(missingKey ? 503 : 502, error.message || "Mani could not answer.");
  }
};
