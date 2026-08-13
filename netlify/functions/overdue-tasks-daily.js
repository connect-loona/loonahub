// ============================================================================
// LOONA Hub · Missed Due Date notifications (Netlify Scheduled Function)
// ----------------------------------------------------------------------------
// Runs once daily (see netlify.toml). Finds every task whose due_date was
// exactly yesterday (IST) and is still not Completed/Deferred, and posts one
// Loona Board announcement per task, e.g.
//   "🔴 Chinmay hasn't finished 'Update captions' for Shookra — due yesterday. (Status: Not Started)"
// A task already sitting in Awaiting Approval/Awaiting Deferral gets its own
// gentler phrasing instead of being lumped in as "hasn't finished" — the
// assignee DID submit it, it's just still waiting on someone else's review —
// but it's still surfaced here since the review itself is now overdue too.
//
// Each post also carries an "Ask why" action button (wired client-side in
// renderLoonaBoard(), see index.html's askOverdueWhy()) that pings the
// assignee for a reason and relays whatever they type back to both Gokul and
// the assigner, regardless of which of the two clicked it — see
// index.html's overdueReasonRequests flow for the receiving side.
//
// NOT broadcast to the whole team — each post carries a `visibleTo` allowlist
// (index.html's renderLoonaBoard() already filters by this, same mechanism
// used elsewhere for restricted posts) limited to just Gokul and whoever
// assigned the task, so it shows up on exactly those two people's Loona
// Board and nowhere else. No push notification is sent for these (push-send's
// sendPushBroadcast fans out to every subscribed device with no per-recipient
// targeting, which would leak this outside the allowlist) — the in-app board
// is the only delivery channel here.
//
// Only checks due_date === yesterday (not "any date in the past") so the same
// task doesn't get reposted every single day it stays overdue — a
// /overdue_notified/<date>/<taskKey> ledger also guards a manual re-run from
// double-posting the same task.
//
// Personal to-dos (is_personal) are skipped — those are private reminders,
// not something to call out at all.
//
// Manual run (for testing): GET /.netlify/functions/overdue-tasks-daily
// ============================================================================

const https = require("https");
const { URL } = require("url");

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

function req(method, urlStr, headers, bodyObj) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const data = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const h = Object.assign({ "Accept": "application/json" }, headers || {});
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let b; try { b = JSON.parse(buf); } catch (e) { b = { _raw: buf.slice(0, 300) }; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: String(e) } }));
    if (data) r.write(data);
    r.end();
  });
}

function fbGet(path) { return req("GET", FB + path + ".json", null, null); }
function fbPut(path, val) { return req("PUT", FB + path + ".json", null, val); }
function fbPost(path, val) { return req("POST", FB + path + ".json", null, val); }

function todayIST() {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}
function yesterdayIST() {
  const now = new Date(Date.now() + 5.5 * 3600000 - 86400000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
}

// Mirrors index.html's taskBrandList() — brands (multi-brand tasks) falls
// back to the single brand field for tasks that predate that feature.
function taskBrandLabel(t) {
  if (Array.isArray(t.brands) && t.brands.length) return t.brands.join(", ");
  return t.brand || "an unassigned brand";
}

// Awaiting Approval/Awaiting Deferral means the assignee already submitted
// their side — calling that "hasn't finished" alongside a genuinely
// untouched Not Started task was the actual complaint, so these get their
// own wording plus the raw status always tacked on either way.
function overdueMessage(t) {
  const brandLabel = taskBrandLabel(t);
  const isAwaiting = t.status === "Awaiting Approval" || t.status === "Awaiting Deferral";
  const text = isAwaiting
    ? `${t.member} submitted "${t.task}" for ${brandLabel} but it's still ${t.status.toLowerCase()} — due yesterday. (Status: ${t.status})`
    : `${t.member} hasn't finished "${t.task}" for ${brandLabel} — due yesterday. (Status: ${t.status})`;
  return { text, emoji: isAwaiting ? "🟠" : "🔴" };
}

exports.handler = async () => {
  try {
    const date = todayIST();
    const dueDate = yesterdayIST();

    const tasksResp = await fbGet("/tasks");
    if (tasksResp.status < 200 || tasksResp.status >= 300) {
      return { statusCode: 502, body: JSON.stringify({ success: false, message: "Firebase read failed: " + JSON.stringify(tasksResp.body).slice(0, 300) }) };
    }
    const tasksByKey = tasksResp.body || {};

    const missed = Object.entries(tasksByKey)
      .map(([key, t]) => ({ key, ...t }))
      .filter((t) => t && t.due_date === dueDate && !t.is_personal && t.status !== "Completed" && t.status !== "Deferred" && t.member && t.task);

    if (!missed.length) {
      return { statusCode: 200, body: JSON.stringify({ success: true, date, dueDate, checked: Object.keys(tasksByKey).length, posted: 0 }) };
    }

    const notifiedResp = await fbGet("/overdue_notified/" + dueDate);
    const alreadyNotified = notifiedResp.body || {};

    const toPost = missed.filter((t) => !alreadyNotified[t.key]);
    if (!toPost.length) {
      return { statusCode: 200, body: JSON.stringify({ success: true, date, dueDate, missed: missed.length, posted: 0, skipped: "already notified" }) };
    }

    const base = Date.now();
    const posts = toPost.map((t, i) => {
      const { text, emoji } = overdueMessage(t);
      return {
        id: base + i,
        text,
        author: "Loona Board",
        emoji,
        timestamp: new Date().toISOString(),
        // Gokul always sees it; whoever assigned the task sees it too (often a
        // different person from the assignee, who is deliberately NOT on this
        // list — the ask was Gokul + the assigner specifically). Falls back to
        // just Gokul if the task has no recorded assigner.
        visibleTo: Array.from(new Set(["Gokul", t.assigned_by].filter(Boolean))),
        // Powers the "Ask why" button (askOverdueWhy() in index.html) — kept
        // as plain fields on the announcement itself (not just baked into the
        // text) so the client can ping the right person without re-parsing it.
        action: "overdue-ask-why",
        taskKey: t.key,
        taskMember: t.member,
        taskTitle: t.task,
        taskBrand: taskBrandLabel(t),
        taskAssignedBy: t.assigned_by || ""
      };
    });

    const results = await Promise.all(posts.map((p) => fbPost("/announcements", p)));
    const failed = results.map((r, i) => ({ r, t: toPost[i] })).filter(({ r }) => r.status < 200 || r.status >= 300);
    const succeeded = results.map((r, i) => ({ r, t: toPost[i] })).filter(({ r }) => r.status >= 200 && r.status < 300);

    // Claim only the ones that actually posted — a failed post should be
    // retried on the next run rather than silently marked as notified.
    await Promise.all(succeeded.map(({ t }) => fbPut("/overdue_notified/" + dueDate + "/" + t.key, true)));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, date, dueDate, missed: missed.length, posted: succeeded.length, failed: failed.length })
    };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
