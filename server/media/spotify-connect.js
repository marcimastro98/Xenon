// Signing in to Spotify: the address Spotify sends the user back to, and the page shown there.

// Persist the streaming app credentials (from the Settings → Streaming inputs) to
// the gitignored stream-config.json and re-create the providers so they take
// effect immediately. Only the known credential keys are accepted.
// The Spotify OAuth redirect target. Pinned to the loopback IP (Spotify rejects
// `localhost` redirect URIs) with the server's actual port taken from the — already
// loopback-verified — Host header. This exact string must be registered in the
// user's Spotify app (see docs/streaming-setup.md); it's the same for every install
// on the default port: http://127.0.0.1:3030/stream/spotify/callback.
function spotifyRedirectUri(req) {
  const host = String((req && req.headers && req.headers.host) || '').trim();
  const port = (host.match(/:(\d+)$/) || [])[1] || '3030';
  return 'http://127.0.0.1:' + port + '/stream/spotify/callback';
}

// The minimal page shown after Spotify redirects back — the Settings poll detects
// the connected state, so this only needs to reassure the user and self-close.
function spotifyCallbackPage(ok) {
  const title = ok ? 'Spotify connected' : 'Spotify connection failed';
  const body = ok
    ? 'You can close this window and return to the dashboard.'
    : 'Something went wrong. Close this window and try Connect again.';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>'
    + '<style>html{color-scheme:dark}body{margin:0;height:100vh;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:10px;background:#0b0f0e;color:#e7e9ee;'
    + 'font:600 15px/1.5 system-ui,Segoe UI,sans-serif;text-align:center;padding:24px}'
    + '.d{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;'
    + 'font-size:26px;background:' + (ok ? 'rgba(30,215,96,.16);color:#1ed760' : 'rgba(237,66,69,.16);color:#ed4245') + '}'
    + 'p{margin:0;opacity:.75;font-weight:500;max-width:320px}</style></head><body>'
    + '<div class="d">' + (ok ? '✓' : '✕') + '</div><div>' + title + '</div><p>' + body + '</p>'
    + '<script>setTimeout(function(){window.close()},2500)</script></body></html>';
}

module.exports = { spotifyRedirectUri, spotifyCallbackPage };
