// ============================================================================
// LOONA Hub · Loona Radio — spotify-playback-token (Netlify Function)
// ----------------------------------------------------------------------------
// Hands the browser a short-lived Spotify access token so the Web Playback
// SDK can authenticate directly (no Spotify login/cookie needed in the
// browser at all) — this is what lets the in-Hub player work around Safari's
// cross-site cookie blocking that makes the plain iframe embed get stuck on
// 30-second previews. (Web Playback SDK itself only runs on desktop
// browsers — Chrome/Firefox/Edge — not mobile browsers at all; see
// index.html's radioPlayerSupported() for where that's surfaced to users.)
//
// Still uses Gokul's one refresh token (same as add-to-playlist.js), so
// playback is tied to his one Spotify Premium account — only one device can
// be the active listener at a time. Verifies the caller is a real, logged-in
// Loona Hub member first (same Identity Toolkit pattern as the other radio
// functions) so this short-lived token — which *can* control playback, even
// though it can't touch the playlist's track list — doesn't leak to randoms.
//
// GET or POST (idToken as query param or body). Returns:
//   { success: true, access_token, expires_in }
// ============================================================================

const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "AIzaSyBnESbCpAiVcSPHOZk4ANFwlIqw7DhB4A0";
const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");

async function fbGet(path) {
  const resp = await fetch(FB + "/" + path + ".json");
  return resp.json().catch(() => null);
}

function deriveEmail(member) {
  if (member.email) return member.email;
  return String(member.name || "").toLowerCase().replace(/\s+/g, "") + "@loona.in";
}

async function resolveCaller(idToken) {
  if (!idToken) return null;
  const lookupResp = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_WEB_API_KEY,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) }
  );
  const lookupData = await lookupResp.json().catch(() => null);
  if (!lookupResp.ok || !lookupData || !lookupData.users || !lookupData.users[0]) return null;
  const email = String(lookupData.users[0].email || "").toLowerCase();
  if (!email) return null;

  const membersData = await fbGet("members");
  const members = Object.values(membersData || {}).filter((m) => m && m.name);
  const match = members.find((m) => deriveEmail(m).toLowerCase() === email);
  return match ? match.name : null;
}

async function getSpotifyAccessToken() {
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64")
    },
    body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(process.env.SPOTIFY_REFRESH_TOKEN)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error("Spotify auth failed: " + JSON.stringify(data).slice(0, 200));
  return data;
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    let idToken = null;
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      idToken = body.idToken;
    } else {
      idToken = (event.queryStringParameters || {}).idToken;
    }

    const memberName = await resolveCaller(idToken);
    if (!memberName) return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: "Not logged in — refresh and try again." }) };

    const tokenData = await getSpotifyAccessToken();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, access_token: tokenData.access_token, expires_in: tokenData.expires_in || 3600 })
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
