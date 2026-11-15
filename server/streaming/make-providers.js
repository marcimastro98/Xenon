// Makes the three accounts of the streaming pages (Twitch, YouTube, Spotify) from the app keys
// kept on this PC. Called once where the engine loads, and again each time the person saves
// new keys in Settings → Streaming, so the new keys count without a restart.

const { createTwitchProvider } = require('../stream-twitch.js');
const { createYouTubeProvider } = require('../stream-youtube.js');
const { createSpotifyProvider } = require('../media/stream-spotify.js');
const { STREAM_TOKENS_FILE, readStreamClientId } = require('./config-files.js');
const { streams } = require('./providers.js');

function makeStreamProviders() {
  streams.twitch = createTwitchProvider({ clientId: readStreamClientId('twitchClientId', 'TWITCH_CLIENT_ID'), tokensFile: STREAM_TOKENS_FILE });
  streams.youtube = createYouTubeProvider({
    clientId: readStreamClientId('youtubeClientId', 'YOUTUBE_CLIENT_ID'),
    clientSecret: readStreamClientId('youtubeClientSecret', 'YOUTUBE_CLIENT_SECRET'),
    tokensFile: STREAM_TOKENS_FILE,
  });
  streams.spotify = createSpotifyProvider({ clientId: readStreamClientId('spotifyClientId', 'SPOTIFY_CLIENT_ID'), tokensFile: STREAM_TOKENS_FILE });
}

module.exports = { makeStreamProviders };
