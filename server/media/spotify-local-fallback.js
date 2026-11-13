// Which media key stands in for which Spotify action while Spotify's own service refuses
// requests.

// All Spotify Deck actions funnel through the provider. Reads `streamSpotify` at
// call time so a re-created provider is picked up automatically.
// While Spotify's Web API refuses the app (a rate limit that can last hours on
// an app with a low quota, even when nothing has been played), play/pause and
// skip still reach the Spotify app through Windows' media keys, which never
// touch the API. Only when the media session in use IS Spotify, so the key can
// never skip another app's track. The SDK widget does the same client-side.
const SPOTIFY_LOCAL_FALLBACK = Object.freeze({ spotifyPlay: 'playpause', spotifyNext: 'next', spotifyPrev: 'previous' });

module.exports = { SPOTIFY_LOCAL_FALLBACK };
