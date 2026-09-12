// Tests runtime-failover.js directly: which errors count as "this provider couldn't
// answer" (and so are worth trying elsewhere) versus "the provider answered and the answer
// was wrong" (which belongs to executeStage's repair loop, not to a second provider), plus
// the FailoverRuntime ordering, lazy construction, and the all-providers-down message.
//
// Pure unit test — no servers, no network, no API keys. Fake providers stand in for the
// real runtimes, exactly the way runtime-claude.test.js injects a fake client.
const { FailoverRuntime, AllProvidersFailedError, isProviderError } = require("../../netlify/functions/lib/strategy/runtime-failover");
const { ConfigurationError, StageValidationError } = require("../../netlify/functions/lib/strategy/errors");

let allPass = true;
function check(name, cond, extra) {
  console.log((cond ? "✅" : "❌") + " " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : ""));
  allPass = allPass && cond;
}

function httpError(status, message) {
  const error = new Error(message || `HTTP ${status}`);
  error.status = status;
  return error;
}

function provider(name, behaviour) {
  return { name, create: () => ({ runStage: behaviour }) };
}

(async () => {
  // ---- 1. Error classification ----
  // The exact error the live October run died on.
  check("429 out-of-credits is a provider error", isProviderError(httpError(429, "You have no credits remaining. Add credits to continue using the API.")));
  check("401 bad key is a provider error", isProviderError(httpError(401, "Incorrect API key provided")));
  check("500 is a provider error", isProviderError(httpError(500, "Internal server error")));
  check("503 is a provider error", isProviderError(httpError(503, "Service Unavailable")));
  check("a missing API key (ConfigurationError) is a provider error", isProviderError(new ConfigurationError("ANTHROPIC_API_KEY is required for the Claude runtime.")));

  // The exact error a real production run just died on: Anthropic's out-of-credits
  // response is a plain 400, not 429, and says "credit balance" rather than "no credits" —
  // neither the old status check nor the old phrase list caught it, so FailoverRuntime
  // never tried OpenAI and the run died on Anthropic's raw JSON error instead.
  check(
    "Anthropic's 400 low-credit-balance error is a provider error, not a plain bad request",
    isProviderError(httpError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}')),
  );

  const networkError = new Error("fetch failed");
  networkError.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  check("a network failure is a provider error", isProviderError(networkError));

  // The other half: these mean the model answered and the ANSWER was wrong. Failing over
  // would just ask a second provider to make the same mistake, on our money.
  check("a stage validation failure is NOT a provider error", !isProviderError(new StageValidationError("strategy", ["Expected 13 assets, received 12."])));
  const zodError = new Error("Invalid input");
  zodError.name = "ZodError";
  check("a schema (Zod) failure is NOT a provider error", !isProviderError(zodError));
  check("a plain 400 is NOT a provider error", !isProviderError(httpError(400, "Bad request")));
  check("an ordinary Error is NOT a provider error", !isProviderError(new Error("something odd happened")));

  // ---- 2. The first healthy provider serves, and is recorded ----
  {
    const runtime = new FailoverRuntime([
      provider("openai", async () => ({ ok: "from-openai" })),
      provider("claude", async () => ({ ok: "from-claude" })),
    ]);
    const out = await runtime.runStage({ stage: "strategy" });
    check("the primary provider serves when healthy", out.ok === "from-openai", out);
    check("servedBy records who actually answered", runtime.servedBy === "openai", runtime.servedBy);
  }

  // ---- 3. A provider outage falls through to the next one ----
  {
    const runtime = new FailoverRuntime([
      provider("openai", async () => { throw httpError(429, "You have no credits remaining."); }),
      provider("claude", async () => ({ ok: "from-claude" })),
    ]);
    const out = await runtime.runStage({ stage: "copy" });
    check("an out-of-credits primary falls over to the secondary", out.ok === "from-claude", out);
    check("servedBy names the provider that actually answered, not the one asked for", runtime.servedBy === "claude", runtime.servedBy);
  }

  // ---- 4. A bad ANSWER is not failed over — it's handed straight back for the repair
  // loop to deal with, and the second provider is never charged ----
  {
    let claudeCalls = 0;
    const runtime = new FailoverRuntime([
      provider("openai", async () => { throw new StageValidationError("copy", ["A-01 captions must be ordered A, B, C."]); }),
      provider("claude", async () => { claudeCalls += 1; return { ok: "from-claude" }; }),
    ]);
    let thrown = null;
    try { await runtime.runStage({ stage: "copy" }); } catch (e) { thrown = e; }
    check("a validation failure is rethrown, not failed over", thrown && thrown.name === "StageValidationError", thrown && thrown.name);
    check("the second provider is never called for a validation failure", claudeCalls === 0, claudeCalls);
  }

  // ---- 5. Lazy construction: an unconfigured SECOND provider must not stop the first from
  // running. This is the live situation today — OpenAI configured, Claude key never added.
  {
    const runtime = new FailoverRuntime([
      { name: "openai", create: () => ({ runStage: async () => ({ ok: "from-openai" }) }) },
      { name: "claude", create: () => { throw new ConfigurationError("ANTHROPIC_API_KEY is required for the Claude runtime."); } },
    ]);
    const out = await runtime.runStage({ stage: "research" });
    check("an unconfigured secondary doesn't stop a healthy primary", out.ok === "from-openai", out);
  }

  // ---- 6. And the reverse: an unconfigured PRIMARY is skipped, not fatal ----
  {
    const runtime = new FailoverRuntime([
      { name: "claude", create: () => { throw new ConfigurationError("ANTHROPIC_API_KEY is required for the Claude runtime."); } },
      { name: "openai", create: () => ({ runStage: async () => ({ ok: "from-openai" }) }) },
    ]);
    const out = await runtime.runStage({ stage: "research" });
    check("an unconfigured primary is skipped for a working secondary", out.ok === "from-openai", out);
    check("servedBy reflects the fallback", runtime.servedBy === "openai", runtime.servedBy);
  }

  // ---- 7. Everything down: one error naming every provider and why. This is the message
  // that would have told last night's run "openai is out of credits AND claude was never
  // connected" in a single line, instead of just "Something went wrong".
  {
    const runtime = new FailoverRuntime([
      provider("openai", async () => { throw httpError(429, "You have no credits remaining."); }),
      { name: "claude", create: () => { throw new ConfigurationError("ANTHROPIC_API_KEY is required for the Claude runtime."); } },
    ]);
    let thrown = null;
    try { await runtime.runStage({ stage: "copy" }); } catch (e) { thrown = e; }
    check("all providers failing throws AllProvidersFailedError", thrown instanceof AllProvidersFailedError, thrown && thrown.name);
    check("the message names the openai failure", thrown && thrown.message.includes("openai: You have no credits remaining."), thrown && thrown.message);
    check("the message names the claude failure too", thrown && thrown.message.includes("claude: ANTHROPIC_API_KEY is required"), thrown && thrown.message);
    check("both failures are attached for programmatic use", thrown && thrown.failures.length === 2, thrown && thrown.failures);
  }

  console.log(allPass ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
