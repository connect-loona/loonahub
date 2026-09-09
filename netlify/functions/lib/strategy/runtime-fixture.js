// Ported from loona-strategy-agents/src/runtimes/fixture.ts — returns canned output
// instead of calling a model. Used for local smoke-testing this integration (and for
// Playwright tests) without spending real OpenAI credits or needing network access.
"use strict";
const fs = require("fs");
const path = require("path");

class FixtureRuntime {
  constructor(fixtureDir) {
    this.fixtureDir = fixtureDir;
  }

  async runStage(request) {
    const raw = JSON.parse(fs.readFileSync(path.join(this.fixtureDir, `${request.stage}.json`), "utf8"));
    return request.outputSchema.parse(raw);
  }
}

module.exports = { FixtureRuntime };
