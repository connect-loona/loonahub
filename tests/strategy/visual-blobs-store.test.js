// How Visual Studio reaches its image store — and why it cannot be a `require`.
//
// This file exists because of a production failure that every other test in this suite was
// blind to. Uploading a reference, and storing any generated image, died with:
//
//   Cannot find module '@netlify/blobs'
//   Require stack: - /var/task/visual-reference-upload.mjs
//
// Netlify does not bundle @netlify/blobs into a Functions v2 deploy; the runtime provides it as
// an ES module. A CJS `require` resolves against the function's own node_modules, which has no
// such package, and throws.
//
// The reason no test caught it: every test reaches the store through VISUAL_ASSET_LOCAL_DIR or
// an injected `deps.store`, both of which return before the import is ever attempted. Those
// escape hatches are what make the endpoints testable at all, and they are also exactly why the
// one line that only runs in production went unexercised. So these checks are about the SHAPE
// of that line rather than its behaviour — the one thing about it that can be verified from
// here.
const fs = require("fs");
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");

// Comments are stripped before scanning, because the fix's own explanation quotes the broken
// line verbatim — and an explanation of a mistake must not read as the mistake. (The first run
// of this file failed on exactly that, which is a fair demonstration that it greps what it
// says it greps.)
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const ASSETS = path.join(HUB, "netlify/functions/lib/strategy/visual-assets.js");
const source = fs.readFileSync(ASSETS, "utf8");
const assets = require(ASSETS);

(async () => {
  // ---- Never a bare require for a module the runtime provides ----
  check("@netlify/blobs is never reached with require()",
    !/require\(\s*["']@netlify\/blobs["']\s*\)/.test(code(source)));
  check("it is reached with a dynamic import instead",
    /import\(\s*["']@netlify\/blobs["']\s*\)/.test(code(source)));

  // Same rule across every function file: this failed once, in one line, in code that looked
  // entirely reasonable. A grep is a cheap way to keep it from coming back somewhere else.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      if (/require\(\s*["']@netlify\/blobs["']\s*\)/.test(code(fs.readFileSync(full, "utf8")))) {
        offenders.push(path.relative(HUB, full));
      }
    }
  };
  walk(path.join(HUB, "netlify/functions"));
  check("no function anywhere requires @netlify/blobs", offenders.length === 0, offenders);

  // ---- storeFor is async, and its callers must treat it that way ----
  // A caller that forgets the await gets a Promise and then "store.set is not a function",
  // which reads like a broken store rather than a missing keyword.
  check("storeFor is async", assets.storeFor.constructor.name === "AsyncFunction");

  const awaited = [...code(source).matchAll(/(\w*\s*=?\s*)storeFor\(/g)].map((m) => m[0]);
  check("every internal call site awaits it",
    [...code(source).matchAll(/^(?!async function).*storeFor\(/gm)]
      .filter((m) => !/await storeFor\(/.test(m[0]))
      .length === 0,
    awaited);

  const visualAsset = fs.readFileSync(path.join(HUB, "netlify/functions/visual-asset.mjs"), "utf8");
  check("and so does the asset endpoint, which calls it from outside this module",
    /await assets\.storeFor\(/.test(visualAsset));

  // ---- The escape hatches still short-circuit before any import ----
  // If they didn't, every test in this suite would need a Netlify runtime.
  const injected = { set: async () => {}, get: async () => null, getMetadata: async () => null };
  check("an injected store is returned as-is", (await assets.storeFor({ store: injected })) === injected);

  const dir = path.join(HUB, "tests", ".tmp-blobs-store");
  process.env.VISUAL_ASSET_LOCAL_DIR = dir;
  const local = await assets.storeFor();
  check("the filesystem stand-in is used when VISUAL_ASSET_LOCAL_DIR is set",
    typeof local.set === "function" && local !== injected);
  // It has to actually work, not merely exist — this is the store every other test writes to.
  await local.set("brands/x/y.png", Buffer.from("bytes"), { metadata: { contentType: "image/png" } });
  const back = await local.get("brands/x/y.png");
  check("and it round-trips bytes", Buffer.from(back).toString() === "bytes");
  delete process.env.VISUAL_ASSET_LOCAL_DIR;
  fs.rmSync(dir, { recursive: true, force: true });

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
