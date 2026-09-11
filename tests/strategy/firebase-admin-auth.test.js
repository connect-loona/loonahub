const path = require("path");
const { spawnSync } = require("child_process");
const { HUB, check, finish } = require("../harness/shared");

const script = `
  delete process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  process.env.FIREBASE_DB_URL = "https://example.firebaseio.com";
  require(${JSON.stringify(path.join(HUB, "netlify/functions/lib/strategy/firebase.js"))})
    .fbGet("strategy_runs")
    .then(() => process.exit(2))
    .catch((error) => { console.log(error.message); process.exit(0); });
`;
const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, FIREBASE_ADMIN_SERVICE_ACCOUNT: "" } });
check("real Firebase access fails closed without a service account", result.status === 0 && /requires FIREBASE_ADMIN_SERVICE_ACCOUNT/.test(result.stdout), { status: result.status, stdout: result.stdout, stderr: result.stderr });
finish();
