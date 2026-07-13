// ============================================================================
// LOONA Hub · Loona Radio — resolve-track (Netlify Function)
// ----------------------------------------------------------------------------
// Takes any music link (Spotify / Apple Music / YouTube / song.link) and
// cross-platform matches it via Odesli (song.link's API), so a member can
// paste whatever link they have and still land in the one shared Spotify
// playlist. No secrets involved — Odesli needs no API key at this volume —
// so this is just URL validation + a passthrough, kept server-side only so
// the client never has to know Odesli's endpoint shape or handle its rate
// limit directly.
//
// POST body: { url }
// Returns: { success: true, trackName, artistName, albumArt, spotifyUri,
//   spotifyUrl, appleMusicUrl, youtubeUrl, songlinkUrl }
// If Odesli found the track but NOT on Spotify: spotifyUri is null — the
// client falls back to the manual queue in that case.
// ============================================================================

const ALLOWED_HOSTS = [
  "open.spotify.com", "spotify.com",
  "music.apple.com", "itunes.apple.com",
  "youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be",
  "song.link", "album.link", "odesli.co"
];

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
    const url = String(body.url || "").trim();
    if (!url) return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: "Paste a track link first." }) };

    let parsed;
    try { parsed = new URL(url); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: "That doesn't look like a valid link." }) };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: "Link must be http(s)." }) };
    }
    if (!ALLOWED_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith("." + h))) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: "That link isn't from Spotify, Apple Music, YouTube, or song.link." }) };
    }

    const odesliResp = await fetch("https://api.song.link/v1-alpha.1/links?url=" + encodeURIComponent(url));
    if (odesliResp.status === 429) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: "Odesli's a little busy right now — try again in a minute." }) };
    }
    if (!odesliResp.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: "Couldn't look up that link right now (Odesli returned " + odesliResp.status + ")." }) };
    }
    const data = await odesliResp.json().catch(() => null);
    if (!data || !data.entitiesByUniqueId) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: "Couldn't find that track." }) };
    }

    const entity = data.entityUniqueId ? data.entitiesByUniqueId[data.entityUniqueId] : Object.values(data.entitiesByUniqueId)[0];
    const links = data.linksByPlatform || {};
    const spotifyUrl = links.spotify && links.spotify.url || null;
    // Odesli's own entityUniqueId for Spotify (e.g. "SPOTIFY_SONG::4cOdK2wGLETKBW3PvgPWqT")
    // isn't the same string Spotify's Web API wants — build the real spotify:track:{id}
    // URI from the id embedded in the spotify.com URL instead of trusting that format.
    const spotifyIdMatch = spotifyUrl && spotifyUrl.match(/\/track\/([a-zA-Z0-9]+)/);
    const spotifyUri = spotifyIdMatch ? `spotify:track:${spotifyIdMatch[1]}` : null;

    if (!entity) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: "Couldn't find track details for that link." }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        trackName: entity.title || "",
        artistName: entity.artistName || "",
        albumArt: entity.thumbnailUrl || "",
        spotifyUri,
        spotifyUrl,
        appleMusicUrl: (links.appleMusic && links.appleMusic.url) || null,
        youtubeUrl: (links.youtube && links.youtube.url) || (links.youtubeMusic && links.youtubeMusic.url) || null,
        songlinkUrl: data.pageUrl || url
      })
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ success: false, message: String((err && err.message) || err) }) };
  }
};
