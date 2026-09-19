// BB's 00 IST message to the team. The work lives in lib/strategy/digest-run.js — this file
// exists because Netlify schedules a cron per function, so each slot needs its own entry
// point. See netlify.toml for the schedule itself.
//
// Also reachable by hand (GET /.netlify/functions/bb-digest-morning) for testing; the
// per-day claim in runDigest stops a manual run from double-sending.
import digestRun from "./lib/strategy/digest-run.js";
import Anthropic from "@anthropic-ai/sdk";
import * as OpenAIAgents from "@openai/agents";

globalThis.__anthropicSdkBundled = Anthropic;
globalThis.__openaiAgentsBundled = OpenAIAgents;

export default async function () {
  try {
    const result = await digestRun.runDigest("morning");
    return new Response(JSON.stringify({ success: true, ...result }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("bb-digest-morning failed:", error);
    return new Response(JSON.stringify({ success: false, error: error.message || String(error) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
