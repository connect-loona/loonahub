// Visual Studio's UI at /visual/ — brand projects, chats inside them, and a round of
// generation that ends in a human picking one.
//
// The image provider is never called: visual-generate is stubbed at the dev-lite layer is not
// possible, so instead this drives the parts that don't need a provider (brands, chats,
// history, picking) against seeded records, plus the empty and expired states. That's
// deliberate — the provider call itself is covered in tests/strategy/visual-studio.test.js
// with fetch injected, and paying a real image API from an e2e test would be absurd.
//
// Requires `npm run build:test` in apps/visual (see tests/run-all.js), which swaps in
// firebase.fake.ts so this never touches Loona's production Firebase project.
const { chromium } = require("playwright");
const {
  RTDB_URL, DEV_LITE_URL, chromiumLaunchOptions, authCookie, req, waitFor,
} = require("../harness/shared");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

const HOUR = 60 * 60 * 1000;

(async () => {
  await req("PUT", `${RTDB_URL}/visual_chats.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_visual.json`, null);

  // Brands come from Hub's own node — the prototypes hardcoded four, this reads the real one.
  // Hub stores a logo per brand (index.html's brand cards render b.logo, falling back to a
  // coloured dot). Seed one brand with a logo and one without, so both paths are exercised.
  const TINY_PNG = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  await req("PUT", `${RTDB_URL}/brands.json`, {
    b1: { brand: "RRO Foods", logo: TINY_PNG },
    b2: { brand: "Casa Waters" },
    b3: { brand: "Retired Brand", inactive: true },
  });

  await req("PUT", `${RTDB_URL}/visual_chats/chat-rro-1.json`, {
    brandId: "rro-foods", title: "Royal Indian Table", createdAt: "2026-09-10T00:00:00.000Z",
    createdBy: "Anjali", lastActivityAt: "2026-09-12T00:00:00.000Z", generationCount: 2,
  });
  await req("PUT", `${RTDB_URL}/visual_chats/chat-casa-1.json`, {
    brandId: "casa-waters", title: "Casa de Luxo blue hour", createdAt: "2026-09-11T00:00:00.000Z",
    createdBy: "Gokul", lastActivityAt: "2026-09-11T00:00:00.000Z", generationCount: 1,
  });

  const fresh = new Date(Date.now() - 60 * 1000).toISOString();
  const old = new Date(Date.now() - 3 * HOUR).toISOString();
  await req("PUT", `${RTDB_URL}/strategy_visual/rro-foods.json`, {
    "gen-1": {
      chatId: "chat-rro-1", prompt: "Primio bottle on a marble counter, warm morning light",
      provider: "openai", model: "gpt-image-1", actor: "Anjali", createdAt: fresh,
      images: [{ url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }, { url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }],
      appliedRules: [
        { key: "no_label_regeneration", label: "No label regeneration", source: "standard" },
        { key: "brand_0", label: "Never show the cap removed from the bottle.", source: "brand" },
      ],
      referenceCount: 2,
      referenceNote: "Product identity · Lighting",
      expandedPrompt: "An editorial product photograph of the Primio bottle on a warm marble counter, soft morning light from the left, shallow depth of field.",
      pickedIndex: null,
    },
    // An hours-old round: its provider URLs are dead, and the UI has to say so rather than
    // rendering a broken image.
    "gen-0": {
      chatId: "chat-rro-1", prompt: "An earlier idea that has since expired",
      provider: "openai", actor: "Anjali", createdAt: old,
      images: [{ url: "https://example.invalid/gone.png" }],
      pickedIndex: 0, pickedBy: "Gokul",
    },
  });

  const browser = await chromium.launch(chromiumLaunchOptions);
  const context = await browser.newContext();
  await context.addCookies([authCookie(DEV_LITE_URL)]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${DEV_LITE_URL}/visual/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("__fakeAuthUser", JSON.stringify({ uid: "u1", email: "gokul@loona.in", displayName: "Gokul" }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  // ---- Brands come from Hub ----
  await waitFor(async () => (await page.locator(".vs-project").count()) > 0 || null, { label: "brand projects render" });
  const projectNames = await page.locator(".vs-project-name").allTextContents();
  check("every active Hub brand is a project", projectNames.includes("RRO Foods") && projectNames.includes("Casa Waters"), projectNames);
  check("an inactive Hub brand is not offered as a place to start work", !projectNames.includes("Retired Brand"), projectNames);

  // The app opens on the first brand alphabetically (Casa Waters here), so selecting RRO is a
  // real click rather than an assumption about which one happens to be first.
  await page.locator(".vs-project", { hasText: "RRO Foods" }).click();

  // ---- Loona's real logo, and each brand's own ----
  check("the real Loona logo is shown, not a drawn placeholder",
    (await page.locator(".vs-logo img").count()) === 1, await page.locator(".vs-logo img").count());
  check("a brand with a logo in Hub shows it",
    (await page.locator(".vs-project-logo").count()) === 1, await page.locator(".vs-project-logo").count());
  check("a brand with no logo yet falls back to an initial rather than a broken image",
    (await page.locator(".vs-project-icon").count()) >= 1, await page.locator(".vs-project-icon").count());

  // ---- The app is light, regardless of the device's dark mode ----
  // Hub and Strategy OS are both light; a dark studio beside them reads as a different product.
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("the background is white", bodyBg === "rgb(255, 255, 255)", bodyBg);

  // ---- Chats live inside the brand, and only that brand's chats ----
  await waitFor(async () => {
    const titles = await page.locator(".vs-chatlink").allTextContents();
    return titles.some((t) => /Royal Indian Table/.test(t)) ? true : null;
  }, { label: "chat list renders" });
  const chatTitles = await page.locator(".vs-chatlink").allTextContents();
  check("the selected brand's chats are listed", chatTitles.some((t) => /Royal Indian Table/.test(t)), chatTitles);
  check("another brand's chats are not", !chatTitles.some((t) => /Casa de Luxo/.test(t)), chatTitles);

  // ---- Opening a chat shows its rounds ----
  await page.locator(".vs-chatlink", { hasText: "Royal Indian Table" }).click();
  await waitFor(async () => (await page.locator(".vs-round").count()) > 0 || null, { label: "rounds render" });
  const threadText = await page.locator(".vs-thread").textContent();
  check("the prompt someone actually typed is shown", /marble counter/.test(threadText), threadText.slice(0, 200));

  // Oldest first — a conversation reads downward.
  const prompts = await page.locator(".vs-ask p").allTextContents();
  check("rounds read oldest-first, newest nearest the composer", /expired/.test(prompts[0]), prompts);

  // ---- The rules shown are the ones really applied ----
  const ruleText = await page.locator(".vs-rules").first().textContent();
  check("a standard rule that shaped the image is shown", /No label regeneration/.test(ruleText), ruleText);
  check("the brand's own rule is shown too", /Never show the cap removed/.test(ruleText), ruleText);
  const brandRules = await page.locator(".vs-rule-brand").count();
  check("a brand rule is distinguished from an always-on one", brandRules === 1, brandRules);

  // ---- An expired preview says so instead of showing a broken image ----
  check("an expired round explains itself", (await page.locator(".vs-expired").count()) === 1, await page.locator(".vs-expired").count());
  const expiredText = await page.locator(".vs-expired").textContent();
  check("and says the prompt and the choice survive", /kept permanently/.test(expiredText), expiredText);

  // ---- Picking: the thing this app exists to record ----
  const useButtons = page.locator(".vs-image figcaption button", { hasText: "Use this" });
  check("an un-picked round offers a choice on each take", (await useButtons.count()) === 2, await useButtons.count());
  await useButtons.first().click();
  // One flag, on the take just chosen. The other round on screen is expired, so it renders no
  // images at all and therefore carries no flag of its own.
  await waitFor(async () => (await page.locator(".vs-picked-flag").count()) === 1 || null, { label: "pick registers" });
  // req() resolves to { status, body } — the record is on .body.
  const picked = (await req("GET", `${RTDB_URL}/strategy_visual/rro-foods/gen-1.json`)).body;
  check("the pick is recorded against the generation", picked.pickedIndex === 0, picked.pickedIndex);
  check("and who made it", picked.pickedBy === "Gokul", picked.pickedBy);

  // Every take is downloadable, not only the chosen one — a download is how a take leaves
  // is the only way anything survives.
  check("every take can be downloaded", (await page.locator('.vs-image figcaption a:text("Download")').count()) >= 2,
    await page.locator('.vs-image figcaption a:text("Download")').count());

  const threadText2 = await page.locator(".vs-thread").textContent();

  // ---- Nothing claims a check that never ran ----
  const memoryText = await page.locator(".vs-memory").textContent();
  check("the memory panel counts real rounds", /2/.test(memoryText), memoryText.slice(0, 200));
  check("it says plainly that a person does the judging", /A person decides which image is usable/.test(memoryText), memoryText.slice(-300));
  // The prototypes both rendered "5 of 6 checks passed" with nothing computing it. That must
  // never appear here.
  check("no fabricated QC verdict anywhere on the page",
    !/checks passed/i.test(await page.locator("body").textContent()), memoryText.slice(0, 300));

  // ---- What the model was actually asked for ----
  // The rewrite is the thing that closes the quality gap with ChatGPT, and it's invisible by
  // design — but when an image comes back wrong, it's the first thing worth reading, because
  // it says whether the model misunderstood or did exactly as asked.
  check("the expanded prompt is available to read", (await page.locator(".vs-expanded").count()) >= 1, await page.locator(".vs-expanded").count());
  check("but collapsed, since it isn't wanted most of the time",
    (await page.locator(".vs-expanded[open]").count()) === 0);
  await page.locator(".vs-expanded summary").first().click();
  const expandedText = await page.locator(".vs-expanded p").first().textContent();
  check("opening it shows what the image model really received",
    /soft morning light from the left/.test(expandedText), expandedText);

  // ---- References: what a round was built from, and building on a result ----
  // Beyond the stored bytes, what has to survive in the thread is the count and what
  // each reference was FOR — that is what explains a prompt six months later.
  check("the thread says what the round was worked from",
    /Worked from 2 references/.test(threadText2), threadText2.slice(0, 400));
  check("and what each reference was for",
    /Product identity · Lighting/.test(threadText2), threadText2.slice(0, 400));

  // Carrying a take back up as the next reference is the iteration loop — "now make the table
  // warmer" without re-uploading anything.
  check("every take offers to be built on", (await page.locator(".vs-useref").count()) >= 2, await page.locator(".vs-useref").count());
  await page.locator(".vs-useref").first().click();
  await waitFor(async () => (await page.locator(".vs-ref").count()) === 1 || null, { label: "result becomes a reference" });
  check("the composer now carries that image as a reference", (await page.locator(".vs-ref img").count()) === 1);
  check("and asks what to take from it", (await page.locator(".vs-ref-role").count()) === 1);
  // The composer should say it is now editing rather than generating from nothing.
  check("the send button says it is an edit now",
    /Edit/.test(await page.locator(".vs-send").textContent()), await page.locator(".vs-send").textContent());

  await page.locator(".vs-ref-remove").click();
  await waitFor(async () => (await page.locator(".vs-ref").count()) === 0 || null, { label: "reference removed" });
  check("a reference can be taken back off", (await page.locator(".vs-ref").count()) === 0);
  check("and the button goes back to generating",
    /Generate/.test(await page.locator(".vs-send").textContent()), await page.locator(".vs-send").textContent());

  // ---- Renaming a chat ----
  // The screenshot that prompted this had three "Untitled visual chat · Empty" rows, so both
  // halves matter: a chat can be named, and an unused one is never created in the first place.
  await page.locator(".vs-chatrow", { hasText: "Royal Indian Table" }).locator(".vs-chatrename-btn").click();
  await waitFor(async () => (await page.locator(".vs-chatrename").count()) === 1 || null, { label: "rename field opens" });
  await page.locator(".vs-chatrename").fill("Royal table, take 2");
  await page.locator(".vs-chatrename").press("Enter");
  await waitFor(async () => {
    const titles = await page.locator(".vs-chatlink").allTextContents();
    return titles.some((t) => /Royal table, take 2/.test(t)) ? true : null;
  }, { label: "rename lands in the sidebar" });
  const renamedChat = (await req("GET", `${RTDB_URL}/visual_chats/chat-rro-1.json`)).body;
  check("the new name is persisted", renamedChat.title === "Royal table, take 2", renamedChat.title);
  check("renaming does not move the chat to another brand", renamedChat.brandId === "rro-foods", renamedChat.brandId);

  // Escape abandons the edit rather than saving a half-typed name.
  await page.locator(".vs-chatrow", { hasText: "Royal table, take 2" }).locator(".vs-chatrename-btn").click();
  await page.locator(".vs-chatrename").fill("half-typed");
  await page.locator(".vs-chatrename").press("Escape");
  const afterEscape = (await req("GET", `${RTDB_URL}/visual_chats/chat-rro-1.json`)).body;
  check("escaping a rename leaves the old name alone", afterEscape.title === "Royal table, take 2", afterEscape.title);

  // "+ New visual chat" must not write an empty chat — that is what left three unused
  // "Untitled visual chat" rows in the sidebar.
  const before = Object.keys((await req("GET", `${RTDB_URL}/visual_chats.json`)).body || {}).length;
  await page.locator(".vs-newchat").click();
  await page.locator(".vs-newchat").click();
  const after = Object.keys((await req("GET", `${RTDB_URL}/visual_chats.json`)).body || {}).length;
  check("starting a new chat creates nothing until something is actually sent",
    after === before, { before, after });

  // ---- Switching brand switches the project ----
  await page.locator(".vs-project", { hasText: "Casa Waters" }).click();
  await waitFor(async () => {
    const titles = await page.locator(".vs-chatlink").allTextContents();
    return titles.some((t) => /Casa de Luxo/.test(t)) ? true : null;
  }, { label: "brand switch loads that brand's chats" });
  const casaChats = await page.locator(".vs-chatlink").allTextContents();
  check("switching brand shows that brand's chats", casaChats.some((t) => /Casa de Luxo/.test(t)), casaChats);
  check("and not the previous brand's", !casaChats.some((t) => /Royal Indian Table/.test(t)), casaChats);
  check("the thread resets rather than showing the last brand's work", (await page.locator(".vs-round").count()) === 0);

  // ---- 🧠 Mani, asked from inside the studio ----
  // He is in Hub and in Strategy OS already; this is the third place, and the one where the
  // question actually occurs to somebody — mid-chat, before typing the next prompt.
  //
  // Casa Waters is deliberately the brand under test here: nothing has been scanned, no tasks,
  // no rounds. So the honest answer is "nothing recorded", it needs no model call, and the
  // check is exact rather than dependent on an API key.
  check("Mani can be asked from Visual Studio", (await page.locator(".vs-mani-input").count()) === 1,
    await page.locator(".vs-mani-input").count());
  check("and it says the studio's own rounds are part of what he reads",
    /including every round made here/.test(await page.locator(".vs-mani").textContent()),
    (await page.locator(".vs-mani").textContent()).slice(0, 200));

  await page.locator(".vs-mani-input").fill("Have we shot their villas at blue hour before?");
  await page.locator(".vs-mani-ask").click();
  await waitFor(async () => (await page.locator(".vs-mani-gap, .vs-mani-answer").count()) > 0 || null,
    { label: "Mani answers" });
  // The whole point of the feature: an empty memory is reported as empty, visibly distinct
  // from an answer, rather than filled in with something plausible about a real client.
  check("a brand with nothing recorded gets an honest gap, not an invention",
    (await page.locator(".vs-mani-gap").count()) === 1 && (await page.locator(".vs-mani-answer").count()) === 0,
    { gap: await page.locator(".vs-mani-gap").count(), answer: await page.locator(".vs-mani-answer").count() });
  const gapText = await page.locator(".vs-mani-gap").textContent();
  check("and says what would make the answer exist", /Scan its Drive folder/.test(gapText), gapText);

  check("no page errors", errors.length === 0, errors);

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
