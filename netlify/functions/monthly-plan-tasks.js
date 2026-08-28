// ============================================================================
// LOONA Hub · Monthly Content Plan auto-tasks (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Retainer brands get their content plan prepared a month in advance. Runs
// once daily and, for every retainer brand's strategy lead(s), fires two
// auto-tasks on a fixed cycle within the CURRENT month, both about NEXT
// month's plan:
//
//   Day 1  → "<Next Month> Plan for <Brand>"          due the 10th
//   Day 10 → "Share the <Next Month> Plan with <Brand>" due the 17th
//
// Example: on 1 Sep, Anam (Shookra's strategy lead) gets "October Plan for
// Shookra", due 10 Sep. On 10 Sep, she gets "Share the October Plan with
// Shookra", due 17 Sep. Both tasks are tagged plan_month="2026-10" — that's
// what index.html's renderMonthlyPlanProgress() widget filters on to show
// "how's next month's plan coming along", regardless of which day this
// month the tasks themselves are due.
//
// "Retainer brand" = brands/{key}.on_monthly_plan !== false (same opt-out
// flag the Admin → Add/Edit Brand form's "Retainer (Monthly Plan)" dropdown
// already writes — see index.html's ab-retainer select). "Strategy lead" =
// that brand's strategy field, comma-separated names — one task per name if
// more than one person shares the brand.
//
// Firebase paths:
//   /monthlyPlanTaskLog/{safe(brand|planMonth|taskType|member)} = true
//     Permanent "already created this one" ledger — protects against a
//     duplicate manual re-run on the same day creating the same task twice.
//
// Manual run (for testing): GET /.netlify/functions/monthly-plan-tasks
// ============================================================================

const FB = (process.env.FIREBASE_DB_URL || 'https://loona-hub-c85d7-default-rtdb.firebaseio.com').replace(/\/+$/, '');

function fbSafeKey(s) {
  return String(s).replace(/[.#$[\]/]/g, '_');
}
async function fbGet(path) {
  const resp = await fetch(FB + '/' + path + '.json');
  return resp.json().catch(() => null);
}
async function fbPatch(path, obj) {
  return fetch(FB + '/' + path + '.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
}
async function fbPush(path, obj) {
  const resp = await fetch(FB + '/' + path + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  return resp.json().catch(() => null);
}

function todayIST() {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}
function pad2(n) { return String(n).padStart(2, '0'); }
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function runMonthlyPlanTasks() {
  const { y, m, d } = todayIST();
  const todayISO = `${y}-${pad2(m)}-${pad2(d)}`;
  let taskType = null;
  if (d === 1) taskType = 'draft';
  else if (d === 10) taskType = 'share';
  if (!taskType) return { skipped: 'not day 1 or day 10 of the month', today: todayISO };

  const nextMonthIdx = m === 12 ? 0 : m; // 0-based index into MONTH_NAMES
  const nextMonthYear = m === 12 ? y + 1 : y;
  const nextMonthNum = m === 12 ? 1 : m + 1;
  const planMonth = `${nextMonthYear}-${pad2(nextMonthNum)}`;
  const nextMonthName = MONTH_NAMES[nextMonthIdx];

  const dueDate = `${y}-${pad2(m)}-${pad2(taskType === 'draft' ? 10 : 17)}`;

  const brandsData = await fbGet('brands');
  const brands = Object.values(brandsData || {}).filter(b => b && b.brand && !b.inactive && b.on_monthly_plan !== false);

  const log = await fbGet('monthlyPlanTaskLog') || {};
  const created = [];
  const skippedNoLead = [];

  for (const b of brands) {
    const leads = String(b.strategy || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!leads.length) { skippedNoLead.push(b.brand); continue; }
    for (const member of leads) {
      const sig = fbSafeKey(`${b.brand}|${planMonth}|${taskType}|${member}`);
      if (log[sig]) continue;

      const taskText = taskType === 'draft'
        ? `${nextMonthName} Plan for ${b.brand}`
        : `Share the ${nextMonthName} Plan with ${b.brand}`;

      const task = {
        member,
        brand: b.brand,
        brands: [b.brand],
        task: taskText,
        assigned_by: 'Gokul',
        priority: 'Medium',
        status: 'Not Started',
        due_date: dueDate,
        asylum: '',
        is_auto: true,
        plan_month: planMonth,
        plan_task_type: taskType,
        created_at: new Date().toISOString(),
        assigned_on: todayISO
      };
      await fbPush('tasks', task);
      await fbPatch('monthlyPlanTaskLog', { [sig]: true });
      created.push({ brand: b.brand, member, task: taskText, due_date: dueDate });
    }
  }

  return { taskType, planMonth, dueDate, created, skippedNoLead };
}

exports.handler = async () => {
  try {
    const result = await runMonthlyPlanTasks();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
