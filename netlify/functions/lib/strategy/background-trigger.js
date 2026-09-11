"use strict";

const { signedHeaders } = require("./internal-auth");

function siteBaseUrl(event) {
  const headers = (event && event.headers) || {};
  const host = headers.host || headers.Host || headers["x-forwarded-host"] || "";
  if (!host) return process.env.URL || process.env.DEPLOY_URL || "";
  return `${headers["x-forwarded-proto"] || "https"}://${host}`;
}

async function triggerBackground(event, functionName, payload) {
  const base = siteBaseUrl(event);
  if (!base) throw new Error("Could not determine the site URL for the background job.");
  const body = JSON.stringify(payload);
  const response = await fetch(`${base}/.netlify/functions/${functionName}`, {
    method: "POST",
    headers: signedHeaders(body),
    body,
  });
  if (!response.ok) throw new Error(`${functionName} rejected the job (${response.status}).`);
  return response;
}

module.exports = { siteBaseUrl, triggerBackground };
