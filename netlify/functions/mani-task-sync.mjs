import taskSync from "./lib/strategy/mani-task-sync.js";
import operationalSync from "./lib/strategy/mani-operational-sync.js";

export default async function () {
  try {
    const [tasks, operations] = await Promise.all([
      taskSync.reconcileTasks(),
      operationalSync.reconcileOperationalActivity(),
    ]);
    return new Response(JSON.stringify({ ok: true, tasks, operations }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("mani-task-sync failed:", error);
    return new Response(JSON.stringify({ error: error.message || String(error) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export const config = { schedule: "*/5 * * * *" };
