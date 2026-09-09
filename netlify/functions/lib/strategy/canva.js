// Canva Connect API Autofill adapter. This is the one piece of Strategy OS that has never
// been run against a real Canva account in this build — there's no CANVA_ACCESS_TOKEN or
// tagged template configured yet, so this is implemented against Canva's documented
// Autofill flow but genuinely unverified live. If it needs adjusting once real credentials
// exist, that's expected, not a sign something else is wrong — the rest of the pipeline
// (deck-builder's own JSON output) is fully validated and tested independently of this.
//
// Flow: POST a brand-template (or source-design) autofill job with one field per deck page
// per configured field tag, poll until it succeeds, return the resulting design's edit URL.
// Field tags are built as `${fieldPrefix}_${paddedPageIndex}_${fields.<name>}` — e.g. with
// fieldPrefix "ASSET", indexWidth 2, fields.hook "HOOK", page 1's hook tag is "ASSET_01_HOOK".
// The template itself must already have every page tagged this way — see docs/CANVA_SETUP.md
// in the originally supplied package for how that tagging is done in the Canva editor.
"use strict";
const { ConfigurationError } = require("./errors");

const API_BASE = "https://api.canva.com/rest/v1";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90000;

function pad(n, width) {
  return String(n).padStart(width, "0");
}

function fieldTag(canvaConfig, pageIndex, fieldName) {
  return `${canvaConfig.fieldPrefix}_${pad(pageIndex, canvaConfig.indexWidth)}_${canvaConfig.fields[fieldName]}`;
}

function buildAutofillData(canvaConfig, deck) {
  const data = {};
  deck.pages.forEach((page, i) => {
    const pageIndex = i + 1;
    const textFields = {
      format: page.format,
      portfolio: page.portfolioAndSku,
      idea: page.idea,
      hook: page.hook,
      creativeCopy: page.creativeCopy,
      direction: page.direction,
      shotList: page.shotList,
      captionOne: page.captionOne,
      captionTwo: page.captionTwo,
      captionThree: page.captionThree,
      referenceCredit: page.referenceCredit,
    };
    for (const [name, value] of Object.entries(textFields)) {
      data[fieldTag(canvaConfig, pageIndex, name)] = { type: "text", text: String(value) };
    }
    // Canva Autofill's image fields take an asset ID, not a raw URL — populating this
    // properly needs an asset-upload call per reference image first. Left as a clear
    // no-op (rather than a silently-wrong text value) until that upload step exists.
  });
  return data;
}

async function canvaFetch(path, options) {
  const token = process.env.CANVA_ACCESS_TOKEN;
  if (!token) throw new ConfigurationError("CANVA_ACCESS_TOKEN is not set.");
  const res = await fetch(`${API_BASE}${path}`, Object.assign({}, options, {
    headers: Object.assign({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, (options && options.headers) || {}),
  }));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Canva API ${path} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

class CanvaPublisher {
  async publish(config, deck) {
    const canvaConfig = config.canva;
    if (!canvaConfig || !canvaConfig.enabled) {
      throw new ConfigurationError("Canva is not enabled for this brand.");
    }
    const templateId = canvaConfig.mode === "design"
      ? process.env[canvaConfig.sourceDesignIdEnv]
      : process.env[canvaConfig.templateIdEnv];
    if (!templateId) {
      throw new ConfigurationError(`${canvaConfig.mode === "design" ? canvaConfig.sourceDesignIdEnv : canvaConfig.templateIdEnv} is not set.`);
    }

    const data = buildAutofillData(canvaConfig, deck);
    const job = await canvaFetch("/autofills", {
      method: "POST",
      body: JSON.stringify({
        brand_template_id: templateId,
        title: `${config.name} — ${deck.month}`,
        data,
      }),
    });

    const jobId = job.job && job.job.id;
    if (!jobId) throw new Error(`Canva did not return a job id: ${JSON.stringify(job).slice(0, 300)}`);

    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const status = await canvaFetch(`/autofills/${jobId}`, { method: "GET" });
      const state = status.job && status.job.status;
      if (state === "success") {
        const design = status.job.result && status.job.result.design;
        if (!design || !design.url) throw new Error("Canva reported success but returned no design URL.");
        return { designUrl: design.url, jobId };
      }
      if (state === "failed") {
        throw new Error(`Canva autofill job failed: ${JSON.stringify(status.job.error || status).slice(0, 300)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Canva autofill job ${jobId} did not finish within ${POLL_TIMEOUT_MS / 1000}s.`);
  }
}

module.exports = { CanvaPublisher, buildAutofillData, fieldTag };
