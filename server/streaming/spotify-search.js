'use strict';
// Finding something on Spotify and playing it: a search, its first result played or queued, a
// track played alone inside its album, and an address checked before it is played.

function makeSearch({ apiRequest, apiResult, clampInt }) {
  // Search the catalog and return simplified matches. Used by the AI assistant
  // to turn "play <song>" / "queue <song>" into a concrete Spotify URI. Needs no
  // extra scope. `type` is one of track/album/artist/playlist (default track).
  async function search(query, type, limit) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return { ok: false, error: 'no_query' };
    const t = ['track', 'album', 'artist', 'playlist'].includes(String(type)) ? String(type) : 'track';
    const n = clampInt(limit || 5, 1, 10);
    const r = await apiRequest('GET', '/search?type=' + t + '&limit=' + n + '&q=' + encodeURIComponent(q));
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'search_failed' };
    const bucket = r.data[t + 's'];
    const items = (bucket && Array.isArray(bucket.items)) ? bucket.items : [];
    return {
      ok: true,
      type: t,
      results: items.filter(Boolean).slice(0, n).map(it => ({
        name: it.name || '',
        uri: it.uri || '',
        artist: Array.isArray(it.artists) ? it.artists.map(a => a && a.name).filter(Boolean).join(', ') : '',
      })),
    };
  }

  // Search for the top match and start playing it. A track plays inside its
  // album (playTrackAlone); an album/artist/playlist plays as a `context_uri`.
  // Requires Premium (403 → premium_required, like every other playback control).
  async function playSearch(query, type) {
    const s = await search(query, type, 1);
    if (!s.ok) return s;
    const hit = s.results[0];
    if (!hit || !hit.uri) return { ok: false, error: 'not_found' };
    const sent = s.type === 'track'
      ? await playTrackAlone(hit.uri)
      : await apiRequest('PUT', '/me/player/play', { context_uri: hit.uri });
    const r = apiResult(sent, 'play_failed');
    return r.ok ? { ok: true, playing: hit } : r;
  }

  // Spotify's desktop app answers a lone track (`uris: [track]`) with "playing"
  // and then loads nothing: seen on the Microsoft Store build 1.308.620 in
  // November 2026, while the same track inside its album starts at once. The
  // API answers 204 either way, so the failure cannot be seen and retried: a
  // track with no list of its own plays inside its album, from that track on,
  // and goes alone only when that is refused or the album cannot be read.
  const TRACK_RE = /^spotify:track:([A-Za-z0-9]{1,40})$/;
  const ALBUM_RE = /^spotify:album:[A-Za-z0-9]{1,40}$/;
  async function albumOf(trackUri) {
    const id = TRACK_RE.exec(trackUri);
    if (!id) return null;
    const r = await apiRequest('GET', '/tracks/' + id[1] + '?market=from_token');
    const data = r.ok && r.data && typeof r.data === 'object' ? r.data : null;
    const album = data && data.album ? String(data.album.uri || '') : '';
    if (!ALBUM_RE.test(album)) return null;
    // A track relinked for this account's country comes back as the copy its
    // album holds, so the offset names that copy and the two always match.
    const copy = String(data.uri || '');
    return { album, track: TRACK_RE.test(copy) ? copy : trackUri };
  }
  async function playTrackAlone(trackUri) {
    const home = await albumOf(trackUri);
    if (home) {
      const r = await apiRequest('PUT', '/me/player/play', { context_uri: home.album, offset: { uri: home.track } });
      if (r.ok) return r;
    }
    return apiRequest('PUT', '/me/player/play', { uris: [trackUri] });
  }

  // Add the top-matching track to the current playback queue.
  async function queueSearch(query) {
    const s = await search(query, 'track', 1);
    if (!s.ok) return s;
    const hit = s.results[0];
    if (!hit || !hit.uri) return { ok: false, error: 'not_found' };
    const r = apiResult(await apiRequest('POST', '/me/player/queue?uri=' + encodeURIComponent(hit.uri)), 'queue_failed');
    return r.ok ? { ok: true, queued: hit } : r;
  }

  // Start a specific Spotify URI. The four kinds a browser needs, and no others:
  // a `context` for the collections, a track for a single song, which is the
  // distinction Spotify's own play endpoint draws.
  //
  // `contextUri` is what you were listening INSIDE. Playing a track by its own
  // URI used to replace whatever was playing with a queue of exactly one song,
  // so tapping a track in a playlist played it and then stopped — the rest of
  // the list gone. Reported by the widget author who moved a Spotify browser
  // onto the SDK and lost the surrounding context in the move.
  //
  // With a context, the same tap becomes "play this playlist, starting here",
  // which is what Spotify's own clients do and what the queue afterwards should
  // look like. Without one, the track plays inside its own album
  // (playTrackAlone), because a lone track loads nothing on the desktop app.
  const URI_RE = /^spotify:(track|album|artist|playlist):[A-Za-z0-9]{1,40}$/;
  const CONTEXT_RE = /^spotify:(album|playlist|artist):[A-Za-z0-9]{1,40}$/;
  async function playUri(uri, contextUri) {
    const u = String(uri || '');
    if (!URI_RE.test(u)) return { ok: false, error: 'bad_uri' };
    const ctx = String(contextUri || '');
    const isTrack = u.startsWith('spotify:track:');
    // A context is only meaningful for a track — it is the thing the track sits
    // in. Spotify accepts an offset for album and playlist contexts only, so an
    // artist context cannot start at a chosen song; rather than silently playing
    // a DIFFERENT track from the one that was tapped, the context is dropped and
    // the named track plays as a track with no context does. That is a smaller
    // surprise than the wrong song.
    const usable = isTrack && CONTEXT_RE.test(ctx) && !ctx.startsWith('spotify:artist:');
    let r = null;
    if (usable) r = await apiRequest('PUT', '/me/player/play', { context_uri: ctx, offset: { uri: u } });
    // A queue holds tracks the CONTEXT does not: anything added with "add to
    // queue" sits in Up Next while belonging to no playlist, and Spotify rejects
    // an offset naming a track its context has never heard of. The API gives us no
    // way to tell those rows apart beforehand, so the offset is attempted and the
    // named track plays without it if it is refused — a tap always plays the
    // song that was tapped, and only loses the "carry on through the list" part
    // that could not have applied anyway.
    if (!r || !r.ok) r = isTrack ? await playTrackAlone(u) : await apiRequest('PUT', '/me/player/play', { context_uri: u });
    return r.ok ? { ok: true } : { ok: false, error: r.error || 'play_failed', status: r.status || 0 };
  }

  return { search, playSearch, queueSearch, playUri };
}

module.exports = { makeSearch };
