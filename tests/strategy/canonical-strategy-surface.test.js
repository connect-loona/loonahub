const fs = require("fs");
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");

const index = fs.readFileSync(path.join(HUB, "index.html"), "utf8");
const app = fs.readFileSync(path.join(HUB, "app.js"), "utf8");
const build = fs.readFileSync(path.join(HUB, "scripts/build-dist.js"), "utf8");
const netlify = fs.readFileSync(path.join(HUB, "netlify.toml"), "utf8");

check("Hub navigation sends Strategy OS directly to /strategy/", index.includes("window.location.assign('/strategy/')"));
check("the embedded Strategy page no longer exists", !index.includes('id="page-strategy"') && !index.includes('id="so-root"'));
check("the legacy Strategy scripts are no longer loaded", !index.includes('src="strategy-app.js"') && !app.includes("strategy-ui.js"));
check("legacy Strategy files and rollback directory are excluded from deploy", !build.includes('"strategy-app.js"') && !build.includes('"strategy-ui.js"') && !build.includes('"strategy-old"'));
check("old Strategy URLs redirect to the canonical app", netlify.includes('from = "/strategy-old/*"') && netlify.includes('to = "/strategy/"'));
finish();
