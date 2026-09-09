// Ported from loona-strategy-agents/src/core/errors.ts (unchanged behaviour, JS not TS —
// Hub's Netlify Functions are plain JS everywhere except netlify/edge-functions/*.ts).

class StageValidationError extends Error {
  constructor(stage, issues) {
    super(`${stage} failed validation:\n- ${issues.join("\n- ")}`);
    this.name = "StageValidationError";
    this.stage = stage;
    this.issues = issues;
  }
}

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

module.exports = { StageValidationError, ConfigurationError };
