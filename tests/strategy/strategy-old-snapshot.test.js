// Verifies the /strategy-old/ rollback snapshot (see strategy-old/README.md) is actually
// servable, and that the live legacy app links to the new one — the two halves of the
// working-instructions doc's closing provision: "Hub's own nav gets a link into it, and
// the old implementation stays reachable at /strategy-old/ for a month as an escape
// hatch."
const fs = require("fs");
const path = require("path");
const { HUB, DEV_LITE_URL, req } = require("../harness/shared");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

(async () => {
  // ---- The snapshot exists and is a genuinely frozen copy, not a symlink/live mirror ----
  for (const f of ["index.html", "app.js", "strategy-app.js", "strategy-ui.js", "design-tokens.css"]) {
    const snapshotPath = path.join(HUB, "strategy-old", f);
    check(`strategy-old/${f} exists`, fs.existsSync(snapshotPath) && fs.lstatSync(snapshotPath).isFile());
  }

  // ---- It's actually served (via the dev harness, which — like real Netlify — serves
  // any real file under the repo root/dist directly, no redirect rule needed) ----
  const res = await req("GET", `${DEV_LITE_URL}/strategy-old/index.html`);
  check("/strategy-old/index.html is servable", res.status === 200, res.status);
  check("it's a real copy of the legacy Hub page", typeof res.body === "string" && res.body.includes("Strategy OS"), typeof res.body);

  // ---- The live legacy app links forward to the new one ----
  const liveContent = fs.readFileSync(path.join(HUB, "strategy-app.js"), "utf8");
  check("the live strategy-app.js links to the new /strategy/ app", liveContent.includes('href="/strategy/"'));

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
