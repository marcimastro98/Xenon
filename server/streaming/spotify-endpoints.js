'use strict';
// Where the Spotify provider talks to Spotify: the addresses of sign-in and of the API, the
// permissions it asks for, how long an unfinished sign-in is kept, and the base64url spelling
// PKCE wants.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

// Read playback + queue/devices, control playback (add-to-queue, shuffle, transfer,
// start a playlist), read the user's playlists, and save tracks to Liked Songs.
// Playback CONTROL requires Spotify Premium; reads work on free accounts too.
// The last two are for the SDK query API's `recent` and `followedArtists`, and
// they are the only ones here that a CONNECTED user does not already have. An
// existing token keeps working with the scopes it was granted — nothing breaks —
// but those two operations answer `insufficient_scope` until that person
// reconnects, which the error path below already knows how to say.
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'user-library-read',
  'user-library-modify',
  'user-read-recently-played',
  'user-follow-read',
].join(' ');

const PENDING_TTL_MS = 10 * 60 * 1000;   // an unfinished authorize expires after 10 min

// base64url without padding — RFC 7636 PKCE verifier/challenge and the state nonce.
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

module.exports = { AUTH_URL, TOKEN_URL, API, SCOPES, PENDING_TTL_MS, b64url };
