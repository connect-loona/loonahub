const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const rules = require(path.join(HUB, "firebase/strategy-rules.fragment.json"));

const expected = [
  "strategy_activity", "strategy_brand_library", "strategy_brands", "strategy_feedback",
  "strategy_learning_events", "strategy_learnings", "strategy_months", "strategy_runs",
  "strategy_stage_versions",
];

check("the rules fragment covers every Strategy OS data root", expected.every((root) => rules[root]), Object.keys(rules));
check("all Strategy roots require a Firebase user for reads", expected.every((root) => rules[root][".read"] === "auth != null"));
check("all Strategy roots deny browser writes", expected.every((root) => rules[root][".write"] === false));
finish();
