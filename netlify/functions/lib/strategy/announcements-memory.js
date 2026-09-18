// Loona Board / "Loona Broadcast": the team's daily brand introductions and other
// announcements posted from the dashboard's Broadcast modal, stored in Firebase under
// /announcements. These posts are the closest thing Hub has to "here's a brand we work with
// and a link to it" — exactly the kind of context Global BB should be able to recall, since
// the team refers back to these brand introductions afterwards.
"use strict";
const { fbGet } = require("./firebase");

const MAX_ANNOUNCEMENTS = 40;

function announcementLine(entry) {
  const text = String((entry && entry.text) || "").trim();
  if (!text) return null;
  const when = String((entry && entry.timestamp) || "").slice(0, 10);
  const author = entry && entry.author ? ` · ${entry.author}` : "";
  const links = Array.isArray(entry && entry.links)
    ? entry.links.filter(Boolean)
    : (entry && entry.link ? [entry.link] : []);
  const linkSuffix = links.length ? ` (${links.join(", ")})` : "";
  return `- ${when}${author}: ${text}${linkSuffix}`;
}

async function loadAnnouncementsText(deps = {}) {
  const get = deps.fbGet || fbGet;
  const raw = (await get("announcements")) || {};
  const lines = Object.values(raw)
    .sort((a, b) => (Number((b && b.ts) || 0) - Number((a && a.ts) || 0)))
    .slice(0, MAX_ANNOUNCEMENTS)
    .map(announcementLine)
    .filter(Boolean);
  if (!lines.length) return null;
  return [
    "# Loona Board — recent team announcements",
    "Brand introductions and other things the team has broadcast to everyone, most recent first. Includes any links shared.",
    ...lines,
  ].join("\n");
}

module.exports = { loadAnnouncementsText };
