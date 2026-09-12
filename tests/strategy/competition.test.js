// Both models writing the same stage, and the critic deciding what survives.
//
// The dangerous bug here isn't a bad pick — it's a merged portfolio that no longer satisfies
// the rules the stage is validated against. Two models won't put the same formats in the
// same slots, so naive per-slot swapping silently breaks the exact format counts every
// downstream validator checks. These tests pin that a slot is only contested when both sides
// agree on its shape, and that the result is never worse than shipping the better entry.
//
// Pure unit tests: fake runtimes, no providers, no keys, no network.
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const { mergeByScore, generateBoth, usableEntries, sameShape } = require(path.join(HUB, "netlify/functions/lib/strategy/competition"));
const { verdictToIssues, averageScore, buildCriticInput, CriticVerdictSchema } = require(path.join(HUB, "netlify/functions/lib/strategy/critic"));

const asset = (id, format, name) => ({ assetId: id, format, conceptName: name, gate: { logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true } });
const verdict = (scores) => ({
  assets: Object.entries(scores).map(([assetId, score]) => ({
    assetId, score, logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true,
    reasoning: "fine", fixes: [],
  })),
  portfolioNotes: [],
});

(async () => {
  // ---- The higher-scoring concept takes the slot ----
  {
    const a = { monthThesis: "A", assets: [asset("R-01", "reel", "A one"), asset("R-02", "carousel", "A two")] };
    const b = { monthThesis: "B", assets: [asset("R-01", "reel", "B one"), asset("R-02", "carousel", "B two")] };
    const { merged, swaps } = mergeByScore(a, b, verdict({ "R-01": 5, "R-02": 9 }), verdict({ "R-01": 8, "R-02": 4 }));
    check("the better concept wins its slot", merged.assets[0].conceptName === "B one", merged.assets.map((x) => x.conceptName));
    check("and the weaker challenger doesn't displace a better incumbent", merged.assets[1].conceptName === "A two", merged.assets.map((x) => x.conceptName));
    check("the swap is recorded with both scores", swaps.length === 1 && swaps[0].assetId === "R-01" && swaps[0].to === 8, swaps);
    check("the winning entry's own fields survive the merge", merged.monthThesis === "A", merged.monthThesis);
  }

  // ---- A tie leaves the portfolio alone ----
  {
    const a = { assets: [asset("R-01", "reel", "A one")] };
    const b = { assets: [asset("R-01", "reel", "B one")] };
    const { merged, swaps } = mergeByScore(a, b, verdict({ "R-01": 7 }), verdict({ "R-01": 7 }));
    check("an equal score is not a reason to churn the portfolio", merged.assets[0].conceptName === "A one" && swaps.length === 0, swaps);
  }

  // ---- THE IMPORTANT ONE: a slot is only contested when the shape matches ----
  // If one model put a reel at R-02 and the other a carousel, swapping would change the
  // format mix and break the exact per-format counts validateStrategy enforces.
  {
    const a = { assets: [asset("R-01", "reel", "A one"), asset("R-02", "reel", "A two")] };
    const b = { assets: [asset("R-01", "reel", "B one"), asset("R-02", "carousel", "B two")] };
    const { merged, swaps } = mergeByScore(a, b, verdict({ "R-01": 3, "R-02": 3 }), verdict({ "R-01": 9, "R-02": 10 }));
    check("a same-format slot is still contested", merged.assets[0].conceptName === "B one", merged.assets.map((x) => x.conceptName));
    check("a differently-formatted slot is NOT swapped, however high it scored", merged.assets[1].conceptName === "A two", merged.assets.map((x) => x.conceptName));
    check("the format mix is therefore unchanged", merged.assets.map((x) => x.format).join(",") === "reel,reel", merged.assets.map((x) => x.format));
    check("only the legitimate swap is recorded", swaps.length === 1, swaps);
  }

  check("sameShape rejects a format mismatch", !sameShape({ assetId: "X", format: "reel" }, { assetId: "X", format: "static" }));
  check("sameShape rejects a different asset entirely", !sameShape({ assetId: "X", format: "reel" }, { assetId: "Y", format: "reel" }));
  check("sameShape accepts matching id and format", sameShape({ assetId: "X", format: "reel" }, { assetId: "X", format: "reel" }));
  // Copy assets carry no format of their own — id alone has to be enough there.
  check("sameShape accepts matching ids when neither side has a format", sameShape({ assetId: "X" }, { assetId: "X" }));

  // ---- An asset the critic didn't judge is left alone rather than guessed at ----
  {
    const a = { assets: [asset("R-01", "reel", "A one")] };
    const b = { assets: [asset("R-01", "reel", "B one")] };
    const { merged } = mergeByScore(a, b, verdict({}), verdict({ "R-01": 10 }));
    check("an unscored slot keeps the base version", merged.assets[0].conceptName === "A one", merged.assets[0].conceptName);
  }

  // ---- A slot the challenger never wrote is left alone ----
  {
    const a = { assets: [asset("R-01", "reel", "A one"), asset("R-02", "reel", "A two")] };
    const b = { assets: [asset("R-01", "reel", "B one")] };
    const { merged } = mergeByScore(a, b, verdict({ "R-01": 1, "R-02": 1 }), verdict({ "R-01": 9 }));
    check("a slot the challenger didn't fill keeps the base version", merged.assets.length === 2 && merged.assets[1].conceptName === "A two", merged.assets.map((x) => x.conceptName));
  }

  // ---- One provider failing degrades to a single-model stage, it does not fail the run ----
  {
    const entries = await generateBoth(
      [
        { name: "openai", runtime: { runStage: async () => { throw Object.assign(new Error("no credits"), { status: 429 }); } } },
        { name: "claude", runtime: { runStage: async () => ({ assets: [asset("R-01", "reel", "survivor")] }) } },
      ],
      { stage: "strategy" }
    );
    check("both providers are attempted", entries.length === 2, entries.map((e) => e.provider));
    check("a dead provider is recorded, not thrown", entries[0].output === null && entries[0].error, entries[0].provider);
    check("the healthy provider still produced work", entries[1].output.assets[0].conceptName === "survivor", entries[1].provider);
  }

  // ---- Only entries that validate on their own may compete ----
  {
    const entries = [
      { provider: "openai", output: { assets: [asset("R-01", "reel", "valid")] } },
      { provider: "claude", output: { assets: [] } },
      { provider: "broken", output: null },
    ];
    const usable = usableEntries(entries, (out) => (out.assets.length ? [] : ["Expected 1 asset, received 0."]));
    check("a valid entry competes", usable.length === 1 && usable[0].provider === "openai", usable.map((e) => e.provider));
    check("an invalid entry is excluded rather than allowed to win a slot", entries[1].validationIssues.length === 1, entries[1].validationIssues);
    check("a provider that produced nothing is skipped", !usable.some((e) => e.provider === "broken"));
  }

  // ---- Critic verdicts become repair-loop issues ----
  {
    const failing = {
      assets: [
        { assetId: "R-01", logoSwapPass: false, killListPass: true, tensionPass: false, overheardPass: true, score: 2, reasoning: "Any oil brand could run this.", fixes: ["Name the Primio pack and the reuse rule."] },
        { assetId: "R-02", logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true, score: 8, reasoning: "Strong.", fixes: [] },
      ],
      portfolioNotes: [],
    };
    const issues = verdictToIssues(failing);
    check("only failing assets become issues", issues.length === 1, issues);
    check("the issue names every failed gate", /logo swap and tension/.test(issues[0]), issues[0]);
    check("and carries the specific fix through to the repair loop", /Name the Primio pack/.test(issues[0]), issues[0]);
    check("a clean verdict produces no issues", verdictToIssues(verdict({ "R-01": 9 })).length === 0);
    check("average score reflects the whole set", averageScore(failing) === 5, averageScore(failing));
  }

  // ---- The critic must not be shown what the writer claimed ----
  {
    const input = buildCriticInput("strategy", {
      monthThesis: "T",
      assets: [{ assetId: "R-01", conceptName: "X", gate: { logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true, rationale: "I think it's great" } }],
    }, {
      research: { exhaustedTerritory: [{ territory: "recipe reels" }] },
      // loadLearnings() (store.js) returns free-form markdown, not a structured object —
      // this pins that buildCriticInput passes that string straight through rather than
      // reaching for object fields (killedConcepts/clientRejections) that don't exist on it.
      learnings: "# Brand learnings\n\n- 2026-08 · strategy · changes_requested: Don't reuse the oil-swap concept again.",
    });
    check("the writer's own gate verdict is stripped before review", !input.assets[0].gate, input.assets[0]);
    check("the concept itself is still shown", input.assets[0].conceptName === "X", input.assets[0]);
    check("the structured exhausted-territory list reaches the critic", input.exhaustedTerritory.length === 1, input.exhaustedTerritory);
    check("the free-text learnings reach the critic as-is, not as an object lookup", input.learnings.includes("oil-swap concept"), input.learnings);
  }

  // ---- Missing context degrades gracefully rather than throwing ----
  {
    const input = buildCriticInput("copy", { assets: [] }, {});
    check("no research context still produces an empty (not crashing) exhausted-territory list", Array.isArray(input.exhaustedTerritory) && input.exhaustedTerritory.length === 0);
    check("no learnings context is passed through as null, not undefined or a crash", input.learnings === null, input.learnings);
  }

  // ---- Schema demands a usable verdict ----
  {
    check("a verdict without reasoning is rejected", !CriticVerdictSchema.safeParse({ assets: [{ assetId: "R-01", logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true, score: 5, reasoning: "" }] }).success);
    check("a score outside 0-10 is rejected", !CriticVerdictSchema.safeParse({ assets: [{ assetId: "R-01", logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true, score: 99, reasoning: "x" }] }).success);
    check("a complete verdict parses", CriticVerdictSchema.safeParse({ assets: [{ assetId: "R-01", logoSwapPass: true, killListPass: true, tensionPass: true, overheardPass: true, score: 5, reasoning: "x" }] }).success);
  }

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
