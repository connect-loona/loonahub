// Regression checks for the agency-grade Visual Studio layer: durable binary assets,
// reference validation and signed background jobs.
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { inspectImage, saveBuffer, loadAsset } = require(path.join(HUB, "netlify/functions/lib/strategy/visual-assets"));
const { signVisualJob, verifyVisualJobSignature } = require(path.join(HUB, "netlify/functions/lib/strategy/visual-jobs"));

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

(async () => {
  const good = inspectImage(pngHeader(1200, 1200), "image/png");
  check("a real image signature and dimensions are read", good.width === 1200 && good.height === 1200, good);
  check("a production-size reference has no low-resolution warning", good.warnings.length === 0, good.warnings);

  let tiny = null;
  try { inspectImage(pngHeader(64, 64), "image/png"); } catch (error) { tiny = error.message; }
  check("a reference too small to preserve identity is rejected", /at least 128px/.test(tiny || ""), tiny);

  let disguised = null;
  try { inspectImage(pngHeader(1200, 1200), "image/jpeg"); } catch (error) { disguised = error.message; }
  check("declared MIME cannot disguise a different file type", /labelled image\/jpeg/.test(disguised || ""), disguised);

  const rows = new Map();
  const metadata = new Map();
  const store = {
    set: async (key, value, options) => { rows.set(key, Buffer.from(value)); metadata.set(key, options); },
    get: async (key) => rows.get(key) || null,
    getMetadata: async (key) => metadata.get(key) || null,
  };
  const saved = await saveBuffer({
    buffer: pngHeader(1000, 1000), contentType: "image/png", brandId: "rro",
    chatId: "chat-1", generationId: "round-1", kind: "references", index: 0,
  }, { store });
  check("stored images return a durable proxy URL, never embedded base64", saved.durable && saved.url.startsWith("/.netlify/functions/visual-asset?"), saved);
  const loaded = await loadAsset(saved.assetKey, { store });
  check("the durable image can be loaded back by its asset key", loaded && loaded.data.length === 24, loaded && loaded.data.length);

  process.env.BASIC_AUTH_CREDENTIALS = "loona:test-secret";
  const signature = signVisualJob("job-123");
  check("a server-signed job is accepted", verifyVisualJobSignature("job-123", signature));
  check("a signature cannot start a different job", !verifyVisualJobSignature("job-456", signature));
  check("a made-up worker signature is rejected", !verifyVisualJobSignature("job-123", "wrong"));

  finish();
})().catch((error) => { console.error("FATAL:", error); process.exit(1); });
