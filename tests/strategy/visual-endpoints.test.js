// The three endpoints that move client image bytes, tested as routes rather than as functions.
//
// These had no coverage at all, and not by oversight: two of them are `.mjs` v2 functions and
// the local harness only knew how to load `.js`, so there was no way to reach them. That is the
// worst shape a gap can take — the code looked tested because the suite was green, while the
// endpoints serving clients' images had never once been exercised.
//
// What is checked here is the part that matters when something is wrong on the outside: who is
// allowed in, what a bad file is told, whether a key can climb out of its own directory, and
// whether the bytes that come back are the bytes that went in.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const { RTDB_URL, DEV_LITE_URL, req, rawReq, pngOfSize, check, finish } = require("../harness/shared");

const FN = `${DEV_LITE_URL}/.netlify/functions`;
const upload = (query, buffer, options) => rawReq("POST", `${FN}/visual-reference-upload?${query}`, buffer, options);
const asset = (key, options) => rawReq("GET", `${FN}/visual-asset?key=${encodeURIComponent(key)}`, null, options);

(async () => {
  await req("PUT", `${RTDB_URL}/visual_chats.json`, null);
  await req("PUT", `${RTDB_URL}/brands.json`, { b1: { brand: "RRO Foods" } });
  await req("PUT", `${RTDB_URL}/visual_chats/chat-endpoints.json`, {
    brandId: "rro-foods", title: "Endpoint coverage", createdAt: "2026-09-10T00:00:00.000Z", createdBy: "Anjali",
  });

  // ---- Who is allowed in ----
  // These serve a client's creative work. An open one is a leak, and both of them sit on a
  // domain whose address is public.
  const anonUpload = await upload("chatId=chat-endpoints", pngOfSize(1200, 1200), { contentType: "image/png" });
  check("uploading a reference requires auth", anonUpload.status === 401, anonUpload.status);
  const anonAsset = await asset("brands/rro-foods/chats/chat-endpoints/x.png");
  check("fetching a stored image requires auth", anonAsset.status === 401, anonAsset.status);

  // ---- A key cannot climb out of its own directory ----
  const traversal = await asset("brands/../../etc/passwd", { auth: true });
  check("a traversal key is refused", traversal.status === 400, { status: traversal.status, body: traversal.json });
  const notScoped = await asset("etc/passwd", { auth: true });
  check("and so is a key that doesn't start inside brands/", notScoped.status === 400, notScoped.status);

  // ---- Method ----
  const posted = await rawReq("POST", `${FN}/visual-asset?key=brands/x`, Buffer.from("x"), { auth: true, contentType: "text/plain" });
  check("the asset route is GET only", posted.status === 405, posted.status);

  // ---- What a bad file is told, and with which status ----
  // Every one of these is the caller's file being wrong, so every one is a 400. A 502 here
  // would send whoever is debugging it to look at Netlify and Blobs instead of at the image.
  const wrongMime = await upload("chatId=chat-endpoints", pngOfSize(1200, 1200), { auth: true, contentType: "text/plain" });
  check("a non-image content type is refused as a bad request", wrongMime.status === 400, { status: wrongMime.status, body: wrongMime.json });

  const lying = await upload("chatId=chat-endpoints", pngOfSize(1200, 1200), { auth: true, contentType: "image/jpeg" });
  check("a PNG labelled as a JPEG is caught by its signature, not its header",
    lying.status === 400 && /labelled image\/jpeg/.test(lying.json.error || ""), { status: lying.status, body: lying.json });

  const tiny = await upload("chatId=chat-endpoints", pngOfSize(64, 64), { auth: true, contentType: "image/png" });
  check("a reference too small to preserve identity is refused as a bad request, not a 502",
    tiny.status === 400 && /at least 128px/.test(tiny.json.error || ""), { status: tiny.status, body: tiny.json });

  const empty = await upload("chatId=chat-endpoints", Buffer.alloc(0), { auth: true, contentType: "image/png" });
  check("an empty upload is refused", empty.status === 400, { status: empty.status, body: empty.json });

  const noChat = await upload("chatId=does-not-exist", pngOfSize(1200, 1200), { auth: true, contentType: "image/png" });
  check("an upload against a chat that doesn't exist is a 404", noChat.status === 404, { status: noChat.status, body: noChat.json });

  // ---- The round trip ----
  const bytes = pngOfSize(1400, 1400);
  const saved = await upload("chatId=chat-endpoints&filename=ref.png&role=Product%20identity", bytes, { auth: true, contentType: "image/png" });
  check("a good reference is stored", saved.status === 200 && Boolean(saved.json.asset), { status: saved.status, body: saved.json });
  const stored = saved.json.asset;
  check("and comes back with a key scoped to this brand and chat",
    stored.assetKey.startsWith("brands/rro-foods/chats/chat-endpoints/"), stored.assetKey);
  check("and a URL pointing at the authenticated asset route",
    stored.url.startsWith("/.netlify/functions/visual-asset?"), stored.url);
  check("and its real dimensions, read from the file rather than trusted from the caller",
    stored.width === 1400 && stored.height === 1400, { width: stored.width, height: stored.height });

  const fetched = await asset(stored.assetKey, { auth: true });
  check("the stored image is served back", fetched.status === 200, fetched.status);
  // The whole point of holding the bytes: what comes back has to be the same file. A string
  // round trip in the request path silently corrupted this, and a corrupt PNG failing its own
  // signature check looks exactly like the validation working.
  check("byte for byte identical to what was uploaded", fetched.buffer.equals(bytes), {
    sent: bytes.length, got: fetched.buffer.length,
  });
  check("with the content type it was stored as", fetched.headers["content-type"] === "image/png", fetched.headers["content-type"]);
  // Without nosniff a browser may decide an image is something executable.
  check("and nosniff, so a browser can't reinterpret it", fetched.headers["x-content-type-options"] === "nosniff",
    fetched.headers["x-content-type-options"]);
  check("and is not cached in a shared cache — these are client assets",
    /private/.test(fetched.headers["cache-control"] || ""), fetched.headers["cache-control"]);

  const missing = await asset("brands/rro-foods/chats/chat-endpoints/nothing-here.png", { auth: true });
  check("a key that was never stored is a 404, not an empty 200", missing.status === 404, missing.status);

  // ---- Visual QC ----
  const qcNoAuth = await req("POST", `${FN}/visual-qc`, { chatId: "chat-endpoints", generationId: "g1" });
  check("running a quality review requires auth — it spends money", qcNoAuth.status === 401, qcNoAuth.status);

  const qcNoGeneration = await req("POST", `${FN}/visual-qc`, { chatId: "chat-endpoints", generationId: "not-a-round" }, { auth: true });
  check("reviewing a round that isn't in this chat is refused",
    qcNoGeneration.status === 404 || qcNoGeneration.status === 502, { status: qcNoGeneration.status, body: qcNoGeneration.body });

  // A round whose images were never stored cannot be reviewed: there is nothing to look at, and
  // inventing a verdict from the prompt alone is the exact failure this feature must not have.
  await req("PUT", `${RTDB_URL}/strategy_visual/rro-foods/legacy-round.json`, {
    chatId: "chat-endpoints", prompt: "An older round", provider: "openai", actor: "Anjali",
    createdAt: new Date().toISOString(), images: [{ url: "https://example.invalid/gone.png" }], pickedIndex: null,
  });
  const qcLegacy = await req("POST", `${FN}/visual-qc`, { chatId: "chat-endpoints", generationId: "legacy-round" }, { auth: true });
  check("a round with no stored image cannot be reviewed", qcLegacy.status === 400, { status: qcLegacy.status, body: qcLegacy.body });

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
