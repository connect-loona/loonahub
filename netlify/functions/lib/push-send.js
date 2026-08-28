// Shared by loona-daily-broadcast.js (scheduled) and push-broadcast.js (manual
// posts from submitBroadcast()) — fans a single Loona Board post out to every
// team member's subscribed phone/desktop as a real Web Push notification (this
// is what lets it arrive even when nobody has the tab open, unlike the
// Notification API used for the in-tab desktop alert).
const https = require("https");
const { URL } = require("url");
const webpush = require("web-push");

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
function fbDelete(path) { return req("DELETE", FB + path + ".json", null, null); }

// Mirrors index.html's fbMemberKey() so a Firebase key looked up here matches
// what the client wrote its subscription under, regardless of spaces/punctuation
// in the member's name.
function fbMemberKey(name) { return (name || "").replace(/[.#$/[\]\s]/g, "_"); }

// Sends one Loona Board post to every subscribed device, skipping the author's
// own (mirrors the desktop notification's self-notify suppression). Dead
// subscriptions (push service returns 404/410 — uninstalled, permission
// revoked, etc.) are pruned from Firebase so the list doesn't grow stale.
async function sendPushBroadcast({ text, author, emoji, actionLabel }) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) return { sent: 0, skipped: "VAPID keys not configured" };

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:connect@loona.in", vapidPublic, vapidPrivate);

  const subsResp = await fbGet("/push_subscriptions");
  const byMember = subsResp.body || {};

  const payload = JSON.stringify({
    title: (emoji ? emoji + " " : "") + (author || "Loona Board"),
    body: (text || "").slice(0, 200),
    tag: "loona-board-" + Date.now(),
  });

  let sent = 0, pruned = 0;
  const jobs = [];
  const authorKey = fbMemberKey(author);
  Object.keys(byMember).forEach((member) => {
    if (member === authorKey) return; // don't notify the person who posted it
    const subsForMember = byMember[member] || {};
    Object.keys(subsForMember).forEach((subId) => {
      const sub = subsForMember[subId];
      if (!sub || !sub.endpoint) return;
      jobs.push(
        webpush.sendNotification(sub, payload)
          .then(() => { sent++; })
          .catch((err) => {
            const code = err && err.statusCode;
            if (code === 404 || code === 410) {
              pruned++;
              return fbDelete("/push_subscriptions/" + encodeURIComponent(member) + "/" + subId);
            }
          })
      );
    });
  });
  await Promise.all(jobs);
  return { sent, pruned };
}

module.exports = { sendPushBroadcast };
