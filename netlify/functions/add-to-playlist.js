// ============================================================================
// LOONA Hub · Loona Radio — add-to-playlist (Netlify Function)
// ----------------------------------------------------------------------------
// Adds a resolved track to the shared Loona Radio Spotify playlist, using
// G's Spotify account (via a stored refresh token) so teammates never need
// their own Spotify account or dev-mode authorization slot. Verifies the
// caller is a real, logged-in Loona Hub member first (Firebase ID token,
// checked against the same Identity Toolkit REST endpoint the client's own
// Firebase Auth talks to — no firebase-admin dependency needed, consistent
// with every other function here talking to Firebase over plain REST).
//
// POST body: { idToken, spotifyUri, trackMeta: {trackName, artistName,
//   albumArt, songlinkUrl}, note }
// ============================================================================

const FB = (process.env.FIREBASE_DB_URL || "https://loona-hub-c85d7-default-rtdb.firebaseio.com").replace(/\/+$/, "");
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "AIzaSyBnESbCpAiVcSPHOZk4ANFwlIqw7DhB4A0";
const MAX_ADDS_PER_MEMBER_PER_DAY = 5;

async function fbGet(path) {
  const resp = await fetch(FB + "/" + path + ".json");
  return resp.json().catch(() => null);
}
async function fbPost(path, obj) {
  const resp = await fetch(FB + "/" + path + ".json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, data };
}

// Same convention as calendar-create.js's deriveEmail()/loginDeriveEmail() in
// index.html — a member's own "email" override field wins, otherwise it's
// firstname@loona.in.
function deriveEmail(member) {
  if (member.email) return member.email;
  return String(member.name || "").toLowerCase().replace(/\s+/g, "") + "@loona.in";
}

// Verifies the ID token is genuinely a live Firebase session for this project
// and resolves which team member it belongs to — mirrors what
// firebase.auth().onAuthStateChanged does client-side, just server-side and
// via REST instead of the SDK.
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

function todayIST() {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
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
    const { idToken, spotifyUri, trackMeta, note } = body;
    if (!spotifyUri || !/^spotify:track:/.test(spotifyUri)) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: "Missing or invalid spotifyUri." }) };
    }

    const memberName = await resolveCaller(idToken);
    if (!memberName) return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: "Not logged in — refresh and try again." }) };

    const logData = await fbGet("radio/log");
    const logEntries = Object.entries(logData || {}).map(([k, v]) => ({ ...v, _key: k }));

    // Dedupe — this exact track is already on the playlist.
    if (logEntries.some((e) => e.spotifyUri === spotifyUri)) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, reason: "duplicate", message: "already in the mix 🌙" }) };
    }

    // Rate limit — counts today's (IST) log entries by this member, server-side
    // so it can't be bypassed by just not calling the client-side check.
    const date = todayIST();
    const todaysCount = logEntries.filter((e) => e.addedBy === memberName && String(e.ts ? new Date(e.ts + 5.5 * 3600000).toISOString().slice(0, 10) : "") === date).length;
    if (todaysCount >= MAX_ADDS_PER_MEMBER_PER_DAY) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, reason: "rate_limited", message: "That's " + MAX_ADDS_PER_MEMBER_PER_DAY + " for today — give the playlist a rest. More tomorrow 🌙" }) };
    }

    const playlistId = await getPlaylistId();
    if (!playlistId) return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: "No Spotify playlist configured yet — set radio/config/spotifyPlaylistId in Firebase." }) };

    const accessToken = await getSpotifyAccessToken();
    const addResp = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [spotifyUri] })
    });
    if (!addResp.ok) {
      const errText = await addResp.text().catch(() => "");
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: "Spotify wouldn't take that track (" + addResp.status + ")." + (errText ? " " + errText.slice(0, 200) : "") }) };
    }

    // Best-effort — powers the Radio page's "hours" stat. Not worth failing
    // the whole add over if this one lookup hiccups.
    let durationMs = 0;
    try {
      const trackId = spotifyUri.replace("spotify:track:", "");
      const trackResp = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, { headers: { Authorization: "Bearer " + accessToken } });
      if (trackResp.ok) {
        const trackData = await trackResp.json().catch(() => null);
        if (trackData && trackData.duration_ms) durationMs = trackData.duration_ms;
      }
    } catch (e) { /* duration is a nice-to-have, not worth failing the add over */ }

    const logEntry = {
      spotifyUri,
      trackName: (trackMeta && trackMeta.trackName) || "",
      artistName: (trackMeta && trackMeta.artistName) || "",
      albumArt: (trackMeta && trackMeta.albumArt) || "",
      songlinkUrl: (trackMeta && trackMeta.songlinkUrl) || "",
      durationMs,
      addedBy: memberName,
      note: note || "",
      ts: Date.now()
    };
    const written = await fbPost("radio/log", logEntry);
    if (!written.ok) {
      // The track IS on the playlist at this point — don't tell the user it
      // failed, just log it server-side so it's visible in Netlify's function
      // logs that the feed entry itself didn't save.
      console.error("Track added to Spotify but radio/log write failed:", JSON.stringify(written.data).slice(0, 300));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "on air 🌙" }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
