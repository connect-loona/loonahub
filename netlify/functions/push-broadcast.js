// Fans a manually-posted Loona Board broadcast (submitBroadcast(), index.html)
// out as a real Web Push notification to every subscribed phone/desktop, so it
// arrives even for people who don't have the tab open — same delivery path the
// scheduled loona-daily-broadcast.js uses for its own posts.
const { sendPushBroadcast } = require("./lib/push-send");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const text = (body.text || "").toString();
  if (!text.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing text" }) };
  }

  try {
    const result = await sendPushBroadcast({
      text,
      author: (body.author || "").toString(),
      emoji: (body.emoji || "📢").toString(),
    });
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, message: String(err && err.message || err) }) };
  }
};
