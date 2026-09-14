"use strict";
const { fbGet, fbSet, fbSafeKey } = require("./firebase");

function monthKey(iso) { return String(iso || new Date().toISOString()).slice(0, 7); }
function eventPath(id, iso) { return `api_usage_events/${monthKey(iso)}/${fbSafeKey(id)}`; }

async function recordApiUsage(input) {
  const createdAt = input.createdAt || new Date().toISOString();
  const id = input.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const event = {
    id,
    createdAt,
    userId: input.userId || null,
    userEmail: input.userEmail || null,
    userName: input.userName || "Unknown Hub user",
    identityVerified: Boolean(input.identityVerified),
    provider: input.provider || "unknown",
    model: input.model || null,
    feature: input.feature || "unknown",
    operation: input.operation || "request",
    brandId: input.brandId || null,
    chatId: input.chatId || null,
    jobId: input.jobId || null,
    status: input.status || "succeeded",
    requests: Number(input.requests || 1),
    outputCount: Number(input.outputCount || 0),
  };
  await fbSet(eventPath(id, createdAt), event);
  return event;
}

function monthsBetween(startIso, endIso) {
  const out = [];
  const cursor = new Date(`${String(startIso).slice(0, 7)}-01T00:00:00Z`);
  const end = String(endIso).slice(0, 7);
  while (!Number.isNaN(cursor.getTime()) && out.length < 24) {
    const key = cursor.toISOString().slice(0, 7);
    out.push(key);
    if (key === end) break;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

async function listApiUsage(startIso, endIso) {
  const groups = await Promise.all(monthsBetween(startIso, endIso).map(async (month) => {
    const raw = await fbGet(`api_usage_events/${month}`);
    return raw ? Object.values(raw) : [];
  }));
  return groups.flat().filter((event) => event.createdAt >= startIso && event.createdAt < endIso);
}

function add(target, key, event) {
  if (!target[key]) target[key] = { key, requests: 0, outputs: 0, generations: 0, enhancements: 0, strategyRuns: 0, picks: 0, reviews: 0, failures: 0 };
  const row = target[key];
  row.requests += Number(event.requests || 0);
  row.outputs += Number(event.outputCount || 0);
  if (event.operation === "generate") row.generations += 1;
  if (event.operation === "magnific_precision") row.enhancements += 1;
  if (event.operation === "strategy_stage") row.strategyRuns += 1;
  if (event.operation === "pick") row.picks += 1;
  if (event.operation === "quality_review") row.reviews += 1;
  if (event.status === "failed") row.failures += 1;
  return row;
}

function summarizeApiUsage(events) {
  const users = {};
  const providers = {};
  for (const event of events) {
    const userKey = event.userId || event.userEmail || `unverified:${event.userName}`;
    const user = add(users, userKey, event);
    user.name = event.userName || "Unknown Hub user";
    user.email = event.userEmail || null;
    user.verified = Boolean(event.identityVerified);
    add(providers, event.provider || "unknown", event).name = event.provider || "unknown";
  }
  return {
    totals: add({}, "all", { requests: events.reduce((n, x) => n + Number(x.requests || 0), 0), outputCount: events.reduce((n, x) => n + Number(x.outputCount || 0), 0) }),
    users: Object.values(users).sort((a, b) => b.requests - a.requests),
    providers: Object.values(providers).sort((a, b) => b.requests - a.requests),
  };
}

module.exports = { recordApiUsage, listApiUsage, summarizeApiUsage, monthKey, monthsBetween };
