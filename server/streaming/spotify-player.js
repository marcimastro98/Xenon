'use strict';
// What is playing on Spotify: the snapshot of the player kept for a few seconds and shared by
// everyone who asks, whether the track is liked, the playlists and the devices.

function makePlayer({ playerState, apiRequest }) {
  const PLAYER_TTL_MS = 4000;   // upstream cap: a 204 (paused) costs a 2nd call, so with two surfaces polling this bounds /me/player to ~30 Spotify calls/min; the 1s client ticker hides the coarser snapshot

  async function getPlaylists() {
    const r = await apiRequest('GET', '/me/playlists?limit=50');
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'failed' };
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    return {
      ok: true,
      playlists: items.filter(Boolean).map(p => ({
        name: p.name || '',
        uri: p.uri || '',
        image: (Array.isArray(p.images) && p.images.length) ? (p.images[0].url || '') : '',
        tracks: (p.tracks && p.tracks.total != null) ? p.tracks.total : null,
      })),
    };
  }

  async function getDevices() {
    const r = await apiRequest('GET', '/me/player/devices');
    if (r.status === 403) return { ok: false, error: 'forbidden' };   // missing user-read-playback-state
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'failed', retryAfterMs: r.retryAfterMs };
    const list = Array.isArray(r.data.devices) ? r.data.devices : [];
    return {
      ok: true,
      devices: list.filter(Boolean).map(dv => ({
        id: dv.id || '',
        name: dv.name || '',
        type: String(dv.type || '').toLowerCase(),
        active: !!dv.is_active,
        volume: (dv.volume_percent != null) ? dv.volume_percent : null,
      })),
    };
  }

  // Full now-playing shape for the widget hero: the LARGEST cover (crisp at the
  // hero size, unlike the list rows which take the smallest), the track id (for
  // save/like state) and album name. Returns null for a non-track item (ad/episode).
  function trackFull(t) {
    if (!t || typeof t !== 'object' || t.type === 'ad') return null;
    const imgs = (t.album && Array.isArray(t.album.images)) ? t.album.images : [];
    return {
      id: t.id || '',
      name: t.name || '',
      uri: t.uri || '',
      artist: Array.isArray(t.artists) ? t.artists.map(a => a && a.name).filter(Boolean).join(', ') : '',
      album: (t.album && t.album.name) || '',
      image: imgs.length ? (imgs[0].url || '') : '',   // widest-first → [0] is largest
    };
  }

  // Is a track in the user's Liked Songs? Needs the user-library-read scope.
  // Returns null (unknown) on any failure so the heart just stays neutral.
  async function isSaved(id) {
    if (!id) return null;
    const r = await apiRequest('GET', '/me/tracks/contains?ids=' + encodeURIComponent(id));
    return (r.ok && Array.isArray(r.data)) ? !!r.data[0] : null;
  }

  const lastLiked = {
    // Cached variant for the hero poll: the liked state only changes when the track
    // changes or the user toggles the heart, so re-checking it every poll is a wasted
    // API call (and on a low-limit Dev-Mode app, wasted calls trip the rate limit).
    _likedCache: { id: '', liked: null },
  };
  async function isSavedCached(id) {
    if (!id) return null;
    if (id === lastLiked._likedCache.id && lastLiked._likedCache.liked !== null) return lastLiked._likedCache.liked;
    const liked = await isSaved(id);
    if (liked !== null) lastLiked._likedCache = { id, liked };
    return liked;
  }

  // Full playback state for the widget's now-playing hero — one call covers the
  // track, progress, shuffle/repeat, and the active device's volume. A 204 (no
  // active device) is a normal "nothing playing" state, not an error.
  // opts.fresh skips the snapshot cache (still folds into any in-flight read): used
  // by the client's post-control resync (next/prev/seek), where a cached snapshot
  // would keep serving the pre-action state for the whole TTL.
  async function getPlayer(opts) {
    const now = Date.now();
    const fresh = !!(opts && opts.fresh);
    if (!fresh && playerState._playerCache && (now - playerState._playerCache.at) < PLAYER_TTL_MS) return playerState._playerCache.data;
    if (playerState._playerPending) return playerState._playerPending;              // fold concurrent callers into one call
    const gen = playerState._playerGen;
    playerState._playerPending = (async () => {
      try {
        const data = await _getPlayerUncached();
        // Skip caching if a control action (play/pause/…) raced in during this read —
        // otherwise the pre-action snapshot would poison the cache for the whole TTL.
        if (gen === playerState._playerGen) playerState._playerCache = { at: Date.now(), data };
        return data;
      } finally { playerState._playerPending = null; }
    })();
    return playerState._playerPending;
  }

  async function _getPlayerUncached() {
    const r = await apiRequest('GET', '/me/player');
    if (r.error === 'not_connected') return { ok: false, error: 'not_connected' };
    // 403 on a playback READ = the stored token is missing user-read-playback-state
    // (an old login from before we requested it). Surface it distinctly so the UI can
    // say "reconnect to grant permission" instead of the misleading "no active device"
    // — the app can be playing and we still can't see it.
    if (r.status === 403) return { ok: false, error: 'forbidden' };
    if (!r.ok) return { ok: false, error: r.error || ('http_' + (r.status || '?')) };
    // A 204 (or a body with no item) means there is no ACTIVE Spotify Connect
    // device — which happens shortly after you PAUSE, even though a track is
    // still loaded. `/me/player/currently-playing` keeps reporting that paused
    // track for much longer, so fall back to it to match what the Media tile
    // (Windows SMTC) shows instead of going blank. That endpoint carries no
    // device/shuffle/repeat, so those degrade to neutral defaults below.
    let data = r.data;
    if (r.status === 204 || !data || !data.item) {
      const cp = await apiRequest('GET', '/me/player/currently-playing');
      if (cp.ok && cp.status !== 204 && cp.data && cp.data.item) data = cp.data;
      else return { ok: true, playing: false, track: null };
    }
    const dev = data.device || null;
    const track = trackFull(data.item);
    return {
      ok: true,
      playing: !!data.is_playing,
      track,
      progressMs: data.progress_ms || 0,
      durationMs: (data.item && data.item.duration_ms) || 0,
      shuffle: !!data.shuffle_state,
      repeat: data.repeat_state || 'off',           // 'off' | 'context' | 'track'
      // Playback context type ('playlist'|'album'|'artist'|…) or '' when playing a
      // loose/"random" track (single, Liked Songs, radio). Consumed by getQueue to
      // decide whether Spotify's Up Next order can be trusted.
      context: (data.context && data.context.type) ? String(data.context.type) : '',
      // …and the context's own URI. Playing one track OUT of a playlist needs it:
      // `context_uri` + `offset` is what makes Spotify continue through the rest of
      // the list afterwards, where a bare track uri would strand playback at the
      // end of that one song. Only the type was exposed before, which was all
      // getQueue needed; tapping a row in Up Next needs the identity.
      contextUri: (data.context && data.context.uri) ? String(data.context.uri) : '',
      device: dev ? (dev.name || '') : '',
      volume: (dev && dev.volume_percent != null) ? dev.volume_percent : null,
      supportsVolume: !!(dev && dev.supports_volume),
      liked: track ? await isSavedCached(track.id) : null,
    };
  }

  return { getPlaylists, getDevices, isSaved, lastLiked, getPlayer };
}

module.exports = { makePlayer };
