// Loona Brain's second input: what the Loona team is actually doing for this brand right now,
// read live from Hub's task board.
//
// The thing this has to get right, and the reason it's tested on its own, is the JOIN. Hub's
// tasks name their brand as free text a human typed ("RRO Foods"), while Strategy OS keys
// everything by id ("rro"). Get that wrong in one direction and every brand sees an empty
// board; get it wrong in the other and one brand's agents are handed another brand's work.
process.env.FIREBASE_DB_URL = require("../harness/shared").RTDB_URL;
const path = require("path");
const { HUB, RTDB_URL, req, check, finish } = require("../harness/shared");
const {
  collectTeamActivity, teamActivityToPromptText, loadTeamActivityText, taskMatchesBrand, slug,
} = require(path.join(HUB, "netlify/functions/lib/strategy/team-activity"));

const TODAY = "2026-09-13";

(async () => {
  await req("PUT", `${RTDB_URL}/tasks.json`, null);

  // ---- The join: a free-text brand name has to reach an id-keyed brand ----
  const rro = new Set([slug("rro"), slug("RRO Foods")]);
  check("a task naming the brand exactly is matched", taskMatchesBrand({ brand: "RRO Foods" }, rro));
  check("casing and punctuation don't break the match", taskMatchesBrand({ brand: "rro  foods" }, rro));
  check("a task naming the brand by its id is matched", taskMatchesBrand({ brand: "rro" }, rro));
  check("the brands[] array is honoured too", taskMatchesBrand({ brands: ["RRO Foods"] }, rro));
  check("another brand's task is NOT matched", !taskMatchesBrand({ brand: "Casa Waters" }, rro));
  check("a task with no brand at all is not matched", !taskMatchesBrand({ task: "something" }, rro));

  // ---- Against a real board ----
  await req("PUT", `${RTDB_URL}/tasks.json`, {
    t1: { task: "Shoot the Diwali reel", member: "Anjali", brand: "RRO Foods", status: "In Progress", due_date: "2026-09-20", created_at: "2026-09-10T00:00:00Z" },
    t2: { task: "Write October captions", member: "Vishnu", brand: "RRO Foods", status: "Not Started", priority: "High", due_date: "2026-09-30", created_at: "2026-09-12T00:00:00Z" },
    t3: { task: "Send September report", member: "Anjali", brand: "RRO Foods", status: "Completed", created_at: "2026-09-01T00:00:00Z" },
    t4: { task: "Fix the pack shot", member: "Rahul", brand: "RRO Foods", status: "Not Started", due_date: "2026-09-05", created_at: "2026-09-02T00:00:00Z" },
    t5: { task: "Casa brand deck", member: "Priya", brand: "Casa Waters", status: "In Progress", created_at: "2026-09-11T00:00:00Z" },
    t6: { task: "Old deferred thing", member: "Anjali", brand: "RRO Foods", status: "Deferred", created_at: "2026-08-01T00:00:00Z" },
  });

  const activity = await collectTeamActivity("rro", "RRO Foods", { today: TODAY });
  const activeTasks = activity.active.map((t) => t.task);

  check("only this brand's tasks are collected", !activeTasks.some((t) => /Casa/.test(t)), activeTasks);
  check("open tasks are collected", activeTasks.includes("Shoot the Diwali reel") && activeTasks.includes("Write October captions"), activeTasks);
  check("completed work is not listed as open", !activeTasks.includes("Send September report"), activeTasks);
  check("deferred work is not listed as open either", !activeTasks.includes("Old deferred thing"), activeTasks);
  check("newest open task comes first", activity.active[0].task === "Write October captions", activeTasks);

  // Overdue is computed, not trusted: nothing writes an overdue flag onto a task, it's simply
  // a due date that has passed while the task is still open.
  check("an open task past its due date is flagged overdue",
    activity.overdue.length === 1 && activity.overdue[0].task === "Fix the pack shot", activity.overdue.map((t) => t.task));
  check("a task due in the future is not overdue", !activity.overdue.some((t) => /Diwali/.test(t.task)), activity.overdue.map((t) => t.task));

  check("the people actually working on this brand are listed",
    activity.people.join() === "Anjali,Rahul,Vishnu", activity.people);
  check("somebody who only has a closed task is not listed as working on it",
    !activity.people.includes("Priya"), activity.people);
  check("finished work is kept separately, not discarded",
    activity.recentlyDone.some((t) => t.task === "Send September report"), activity.recentlyDone.map((t) => t.task));

  // ---- What the prompts actually receive ----
  const text = teamActivityToPromptText(activity);
  check("the block says who is on this brand", /Anjali/.test(text) && /Vishnu/.test(text), text.slice(0, 200));
  check("open tasks carry who has them and what state they're in",
    /Write October captions — Vishnu \(Not Started/.test(text), text);
  check("a high-priority task says so", /high priority/.test(text), text);
  check("overdue work gets its own heading", /## Already overdue/.test(text) && /Fix the pack shot/.test(text), text);
  // Without this the agents would happily treat a task title as a content idea to write about.
  check("it is framed as context, not as a brief",
    /not a brief/.test(text) && /nothing here is content to write about/.test(text), text.slice(0, 400));

  // ---- A brand nobody has tasks for gets nothing, not an empty shell ----
  const empty = await collectTeamActivity("nobody", "Nobody Brand", { today: TODAY });
  check("a brand with no tasks collects nothing", empty.active.length === 0 && empty.recentlyDone.length === 0, empty);
  check("and yields no prompt block at all rather than an empty heading",
    teamActivityToPromptText(empty) === null, teamActivityToPromptText(empty));
  check("a null activity is also safe", teamActivityToPromptText(null) === null);

  // A brand whose id and name are both empty must not match every task on the board — this is
  // the failure that would quietly hand one brand's agents the entire company's work.
  const noIdentity = await collectTeamActivity("", "", { today: TODAY });
  check("a brand with no identity matches nothing rather than everything",
    noIdentity.active.length === 0, noIdentity.active.length);

  // ---- The end-to-end helper the store actually calls ----
  const live = await loadTeamActivityText("rro", "RRO Foods", { today: TODAY });
  check("the text helper reads the real board", /Shoot the Diwali reel/.test(live), live.slice(0, 150));

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
