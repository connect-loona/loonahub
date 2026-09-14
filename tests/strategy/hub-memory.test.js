// What Mani can see when nobody has named a brand.
//
// He could already answer deep questions about one brand, but every question had to name one
// first — which makes the questions people actually ask unanswerable. "What is Anjali working
// on?", "who has made anything for Casa this week?", "what's overdue across everything?" belong
// to no single brand, and all of them have exact recorded answers sitting in Hub.
//
// Two things this has to get right. The roll-up must actually carry WHO — across both the task
// board and Visual Studio, which are different groups of people. And it must stay a roll-up:
// concatenating every brand's full memory would be enormous, mostly irrelevant to any one
// question, and would push the useful part out of the model's attention.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const {
  collectHubMemory, hubMemoryToPromptText, activeBrands,
} = require(path.join(HUB, "netlify/functions/lib/strategy/hub-memory"));

const TODAY = "2026-09-14";

(async () => {
  await req("PUT", `${RTDB_URL}/tasks.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_visual.json`, null);
  await req("PUT", `${RTDB_URL}/strategy_brain.json`, null);

  await req("PUT", `${RTDB_URL}/brands.json`, {
    "-Nx1": { brand: "RRO Foods" },
    "-Nx2": { brand: "Casa Waters" },
    "-Nx3": { brand: "Retired Brand", inactive: true },
  });

  await req("PUT", `${RTDB_URL}/tasks.json`, {
    t1: { task: "Shoot the Diwali reel", member: "Anjali", brand: "RRO Foods", status: "In Progress", due_date: "2026-09-20", created_at: "2026-09-10T00:00:00Z" },
    t2: { task: "Fix the pack shot", member: "Rahul", brand: "RRO Foods", status: "Not Started", due_date: "2026-09-05", created_at: "2026-09-02T00:00:00Z" },
    t3: { task: "Casa villa deck", member: "Priya", brand: "Casa Waters", status: "In Progress", created_at: "2026-09-11T00:00:00Z" },
    t4: { task: "Old thing", member: "Anjali", brand: "Retired Brand", status: "Not Started", created_at: "2026-09-01T00:00:00Z" },
  });

  await req("PUT", `${RTDB_URL}/strategy_visual/casa-waters.json`, {
    g1: {
      prompt: "Villa at blue hour", provider: "openai", actor: "Vishnu",
      createdAt: "2026-09-13T10:00:00Z", images: [{ url: "x" }, { url: "y" }],
      pickedIndex: 1, pickedBy: "Gokul",
    },
    g2: {
      prompt: "An abandoned idea", provider: "openai", actor: "Vishnu",
      createdAt: "2026-09-13T09:00:00Z", images: [{ url: "x" }], pickedIndex: null,
    },
  });

  // ---- Only live brands ----
  const brands = await activeBrands();
  check("every active brand is in the wide view", brands.map((b) => b.name).sort().join() === "Casa Waters,RRO Foods", brands.map((b) => b.name));
  // A question about what the studio is doing NOW shouldn't be answered with work that stopped.
  check("a retired brand is left out", !brands.some((b) => b.name === "Retired Brand"), brands.map((b) => b.name));

  const hub = await collectHubMemory({ today: TODAY });
  const byName = Object.fromEntries(hub.brands.map((b) => [b.name, b]));

  // ---- WHO, which is the whole point ----
  check("people with tasks on a brand are listed against it",
    byName["RRO Foods"].people.join() === "Anjali,Rahul", byName["RRO Foods"].people);
  // The task board and Visual Studio are different groups: somebody generating images may have
  // no task assigned, and somebody carrying three tasks may never open Visual Studio.
  check("somebody who only made images in Visual Studio still counts as working on that brand",
    byName["Casa Waters"].people.includes("Vishnu"), byName["Casa Waters"].people);
  check("and so does somebody who only has a task", byName["Casa Waters"].people.includes("Priya"), byName["Casa Waters"].people);
  check("one brand's people don't bleed into another's",
    !byName["RRO Foods"].people.includes("Priya") && !byName["Casa Waters"].people.includes("Rahul"),
    { rro: byName["RRO Foods"].people, casa: byName["Casa Waters"].people });

  check("open work is counted per brand", byName["RRO Foods"].openTasks === 2, byName["RRO Foods"].openTasks);
  check("and overdue work separately", byName["RRO Foods"].overdue === 1, byName["RRO Foods"].overdue);

  // ---- Recent making, and who did it ----
  const casaVisual = byName["Casa Waters"].recentVisual;
  check("recent Visual Studio work is attached to its brand", casaVisual.length === 2, casaVisual.length);
  check("with who wrote the prompt", casaVisual.some((v) => v.by === "Vishnu"), casaVisual.map((v) => v.by));
  check("and whether anything was kept", casaVisual.some((v) => v.picked) && casaVisual.some((v) => !v.picked),
    casaVisual.map((v) => v.picked));
  check("and who kept it, when that's somebody else",
    casaVisual.find((v) => v.picked).pickedBy === "Gokul", casaVisual.find((v) => v.picked).pickedBy);

  // ---- The text Mani actually reads ----
  const text = hubMemoryToPromptText(hub);
  check("both brands are in the roll-up", /RRO Foods/.test(text) && /Casa Waters/.test(text), text.slice(0, 120));
  check("who is on each is stated", /Working on it: Anjali, Rahul/.test(text), text);
  check("overdue work is called out", /overdue/.test(text), text);
  check("recent making names the person", /Villa at blue hour" — Vishnu/.test(text), text);
  check("a round nobody kept says so, rather than looking approved", /nothing kept/.test(text), text);
  // It has to admit its own shallowness, or it will answer a deep question from a summary.
  check("it says plainly that it is a roll-up, not full memory",
    /roll-up, not the full memory/.test(text), text.slice(0, 400));
  check("and tells Mani to ask for a brand when depth is needed",
    /say which brand to ask about/.test(text), text.slice(0, 400));
  check("a brand with nothing distilled is flagged as such",
    /Nothing distilled from this brand's Drive folder yet/.test(text), text);

  // ---- Nothing at all ----
  await req("PUT", `${RTDB_URL}/brands.json`, null);
  const nothing = await collectHubMemory({ today: TODAY });
  check("no active brands yields no roll-up rather than an empty heading",
    hubMemoryToPromptText(nothing) === null, nothing.brands.length);

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
