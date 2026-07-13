// ============================================================================
// LOONA Hub · Loona Radio — remove-from-playlist (Netlify Function)
// ----------------------------------------------------------------------------
// Admin-only (Gokul) quiet cleanup: removes a track from the actual Spotify
// playlist and deletes its radio/log entry. No UI is shown to non-admins for
// this at all, but the admin check happens here too — a hidden button is not
// a security boundary on its own.
//
// POST body: { idToken, spotifyUri, logId }
// ============================================================================

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "AIzaSyBnESbCpAiVcSPHOZk4ANFwlIqw7DhB4A0";

async function fbGet(path) {
  const resp = await fetch(FB + "/" + path + ".json");
  return resp.json().catch(() => null);
}
async function fbDelete(path) {
  return fetch(FB + "/" + path + ".json", { method: "DELETE" });
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

let cachedToken = null;
let cachedExpiry = 0;
async function getSpotifyAccessToken() {
  if (cachedToken && Date.now() < cachedExpiry - 30000) return cachedToken;
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
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function getPlaylistId() {
  const configured = await fbGet("radio/config/spotifyPlaylistId");
  return configured || process.env.SPOTIFY_PLAYLIST_ID;
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ success: false, message: "Method not allowed" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const { idToken, spotifyUri, logId } = body;
    if (!spotifyUri || !logId) return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: "Missing spotifyUri or logId." }) };

    const memberName = await resolveCaller(idToken);
    if (!memberName) return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: "Not logged in — refresh and try again." }) };
    if (memberName.toLowerCase() !== "gokul") {
      return { statusCode: 403, headers, body: JSON.stringify({ success: false, message: "Only Gokul can remove tracks." }) };
    }

    const playlistId = await getPlaylistId();
    if (!playlistId) return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: "No Spotify playlist configured." }) };

    const accessToken = await getSpotifyAccessToken();
    const delResp = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ tracks: [{ uri: spotifyUri }] })
    });
    if (!delResp.ok) {
      const errText = await delResp.text().catch(() => "");
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: "Spotify wouldn't remove that track (" + delResp.status + ")." + (errText ? " " + errText.slice(0, 200) : "") }) };
    }

    await fbDelete("radio/log/" + logId);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
