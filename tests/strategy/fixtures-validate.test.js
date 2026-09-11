// Confirms the checked-in rro-2026-10 fixtures still parse against their Zod contracts and
// pass their own validators with zero issues — catches drift when the schemas/validators
// change but the fixtures used by every other fixture-runtime test aren't updated to match.
const path = require("path");
const { HUB } = require("../harness/shared");
const { CopySchema, CreativeDirectionSchema, DeckSpecSchema, BrandConfigSchema } = require(path.join(HUB, "netlify/functions/lib/strategy/contracts"));
const { validateCopy, validateDirection, validateDeck } = require(path.join(HUB, "netlify/functions/lib/strategy/validation"));

const FIX_DIR = path.join(HUB, "netlify/functions/lib/strategy/fixtures/rro-2026-10");
const config = BrandConfigSchema.parse(require(path.join(HUB, "netlify/functions/lib/strategy/seed/rro.config.json")));
const strategy = require(path.join(FIX_DIR, "strategy.json"));

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""));
  allPass = allPass && cond;
}

const copyRaw = require(path.join(FIX_DIR, "copy.json"));
const copyParsed = CopySchema.parse(copyRaw);
check("copy.json parses against CopySchema", true);
const copyIssues = validateCopy(copyParsed, config, strategy, "2026-10");
check("copy.json passes validateCopy with zero issues", copyIssues.length === 0, copyIssues);

const directionRaw = require(path.join(FIX_DIR, "creative-direction.json"));
const directionParsed = CreativeDirectionSchema.parse(directionRaw);
check("creative-direction.json parses against CreativeDirectionSchema", true);
const directionIssues = validateDirection(directionParsed, config, strategy, "2026-10");
check("creative-direction.json passes validateDirection with zero issues", directionIssues.length === 0, directionIssues);

const placeholderReference = structuredClone(directionParsed);
placeholderReference.assets[0].references[0] = {
  url: "https://support.microsoft.com/en-us/office/paste-data-into-filtered-columns-abc123",
  title: "Paste Data into Filtered Columns",
  source: "Microsoft Support",
  useFor: "none",
  rightsNote: "Reference only",
};
const placeholderIssues = validateDirection(placeholderReference, config, strategy, "2026-10");
check("reference validation rejects an unrelated source with placeholder useFor", placeholderIssues.some((issue) => /must explain exactly|not visibly relevant/.test(issue)), placeholderIssues);

const searchReference = structuredClone(directionParsed);
searchReference.assets[0].references[0] = {
  url: "https://www.google.com/search?q=Sharad+Purnima+food+photography",
  title: "Sharad Purnima food photography",
  source: "Google",
  useFor: "Food photography composition and lighting reference",
  rightsNote: "Reference only",
};
const searchIssues = validateDirection(searchReference, config, strategy, "2026-10");
check("reference validation rejects search-result pages", searchIssues.some((issue) => /search results/.test(issue)), searchIssues);

const deckRaw = require(path.join(FIX_DIR, "deck-builder.json"));
const deckParsed = DeckSpecSchema.parse(deckRaw);
check("deck-builder.json parses against DeckSpecSchema", true);
const deckIssues = validateDeck(deckParsed, config, strategy, copyParsed, directionParsed, "2026-10");
check("deck-builder.json passes validateDeck with zero issues", deckIssues.length === 0, deckIssues);

console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
process.exit(allPass ? 0 : 1);
