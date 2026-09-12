// Runs one stage against an ordered list of model providers, moving to the next one only
// when a provider genuinely couldn't answer. Wraps the real runtimes (runtime-openai.js,
// runtime-claude.js) behind the same runStage() interface they already expose, so the
// repair loop in pipeline.js's executeStage() doesn't need to know failover exists.
//
// Why this is its own layer: before it, a provider outage burned every repair attempt
// against the dead provider and then failed the run. A real October run died exactly that
// way — OpenAI returned "429 You have no credits remaining" three times in a row, the
// stage gave up, and the only recovery was topping up billing. With a second provider
// configured, the same outage is now a logged hiccup instead of a dead run.
"use strict";
const { ConfigurationError } = require("./errors");

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT",
]);

// A *provider* error means "this provider could not answer": an empty billing balance
// (429), a missing or rejected key (401/403, or a ConfigurationError thrown before the
// call is even attempted), the provider being down (5xx), or the request never getting
// there at all (network). Those are worth retrying somewhere else.
//
// A schema or validation failure is deliberately NOT one: there the provider answered
// perfectly well and the ANSWER was wrong, which is what executeStage()'s repair loop
// already handles by feeding the issues back to the same model. Failing over on those
// would just ask a second provider to make the same mistake and charge us for it.
function isProviderError(error) {
  if (!error) return false;
  // A key that isn't configured is a provider problem, not an output problem — this is the
  // one that matters most day to day, since it's how "Claude was never connected" shows up.
  if (error instanceof ConfigurationError || error.name === "ConfigurationError") return true;
  if (error.name === "StageValidationError") return false;
  if (typeof error.name === "string" && error.name.includes("ZodError")) return false;

  const status = Number(error.status || error.statusCode || (error.response && error.response.status) || 0);
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) return true;

  const code = (error.code || (error.cause && error.cause.code) || "").toString();
  if (NETWORK_ERROR_CODES.has(code)) return true;

  const message = `${error.message || ""} ${(error.cause && error.cause.message) || ""}`.toLowerCase();
  // Anthropic's own out-of-credits error is a genuine production case that slipped past
  // this list entirely: it comes back as a plain 400 invalid_request_error — not 429 —
  // with the message "Your credit balance is too low to access the Anthropic API. Please
  // go to Plans & Billing to upgrade or purchase credits." None of the phrases below
  // matched it ("no credits" isn't "credit balance"), so isProviderError() said no,
  // FailoverRuntime never tried the other provider, and a real run died immediately on
  // Anthropic's raw JSON error instead of quietly moving to OpenAI. Matching on the
  // billing-specific wording here (not the 400 status itself — an ordinary bad request is
  // still not a provider error, see the test for that) closes exactly that gap.
  return /fetch failed|socket hang up|network error|timed out|timeout|econnreset|service unavailable|rate limit|quota|insufficient[_ ]quota|no credits|credit balance|purchase credits|plans\s*&\s*billing/.test(message);
}

class AllProvidersFailedError extends Error {
  constructor(failures) {
    const detail = failures.map((f) => `${f.provider}: ${f.message}`).join(" | ");
    super(`Every model provider failed. ${detail}`);
    this.name = "AllProvidersFailedError";
    this.failures = failures;
  }
}

class FailoverRuntime {
  // providers: [{ name, create }] — `create` is called lazily, on the attempt itself,
  // because constructing a runtime throws when its API key is missing. Building both up
  // front would let an unconfigured SECOND provider stop the first one from ever running,
  // which is backwards.
  constructor(providers) {
    this.providers = providers;
    // Which provider actually produced the last successful output. Recorded on the stage's
    // metrics, and read by the cross-model review pass, which has to know whether the
    // grader really is a different model from the writer.
    this.servedBy = null;
  }

  async runStage(request) {
    const failures = [];
    for (const provider of this.providers) {
      let runtime;
      try {
        runtime = provider.create();
      } catch (error) {
        if (!isProviderError(error)) throw error;
        failures.push({ provider: provider.name, message: error.message || String(error) });
        continue;
      }
      try {
        const output = await runtime.runStage(request);
        if (failures.length) {
          console.warn(`[${request.stage}] ${provider.name} served this stage after ${failures.map((f) => f.provider).join(", ")} failed.`);
        }
        this.servedBy = provider.name;
        return output;
      } catch (error) {
        if (!isProviderError(error)) throw error; // the model answered; its answer is the repair loop's problem
        console.warn(`[${request.stage}] ${provider.name} could not answer: ${error.message || error}`);
        failures.push({ provider: provider.name, message: error.message || String(error) });
      }
    }
    throw new AllProvidersFailedError(failures);
  }
}

module.exports = { FailoverRuntime, AllProvidersFailedError, isProviderError };
