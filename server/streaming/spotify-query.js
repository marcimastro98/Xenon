'use strict';
// What an SDK widget may read from Spotify: the list of readings and the address each one
// builds from checked parts, its answer shaped, and the same reading shared while it runs and
// remembered for a few seconds.

function makeQuery({
  retryAfterMs, queryCacheGet, queryCachePut, apiRequest, spotifyId, clampInt, getPlayer,
  normalizeQueue,
}) {
  // ── SDK read cache ──────────────────────────────────────────────────────────
  // Every `query` op below spends the USER's Spotify quota, and that quota is
  // shared with Xenon's own tile: a widget re-reading a page on each render does
  // not only slow itself down, it can stop the dashboard's music working. A
  // widget author paging a library ten albums at a time reported exactly that,
  // as "spotify's api burst rates".
  //
  // Two collapses, both keyed on the built path — the same key the widget cannot
  // choose, so nothing here can be steered from outside:
  //   in-flight  two identical reads still running share one upstream call (two
  //              tiles of the same widget, or a re-render mid-fetch)
  //   short TTL  a repeat within seconds (scrolling back, a remount, a tile
  //              coming out of hiding) is answered from memory
  //
  // Deliberately small and short: this is a burst absorber, not a store. Sixteen
  // entries for a few seconds means the library still visibly changes, and the
  // memory it can hold is bounded by what the widget already has on screen.
  const QUERY_TTL_MS = 10000;           // library reads: pages, search results
  const QUERY_TTL_VOLATILE_MS = 3000;   // what is playing right now, on which device
  const QUERY_VOLATILE = new Set(['player', 'queue', 'devices']);
  const _queryPending = new Map();      // path -> in-flight promise, shared

  // ── Read API for SDK widgets (GET /stream/spotify/query) ───────────────────
  //
  // A widget that browses a library needs authenticated reads, and the two ways
  // to give it those are to hand over the token or to name the reads. This names
  // them. The widget never sees a token, cannot reach a path we did not write,
  // and cannot turn this into a general Spotify proxy: `op` indexes a table of
  // functions, so an op we do not have is simply not a request.
  //
  // Requested by a widget author who had built the library browser against a
  // private sidecar of his own and wanted to delete it.
  //
  // Spotify's own objects are passed through unshaped, and that is deliberate.
  // Reshaping them would drop fields a widget legitimately wants and would make
  // Xenon the owner of a schema it does not control; documenting them as
  // "Spotify's shapes, proxied" is the honest contract.
  // An id for a path segment. Delegates to spotifyId above, which already accepts
  // a bare id, a spotify: URI or an open.spotify.com link — a widget should not
  // have to know which of the three it is holding — and then caps the length,
  // because that one is unbounded and this value is about to be a URL path.
  const queryId = (v, kind) => {
    const id = spotifyId(v, kind);
    return /^[A-Za-z0-9]{1,40}$/.test(id) ? id : '';
  };
  // clampInt is already in scope above and floors junk to `lo`; paging wants a
  // sensible DEFAULT when a field is simply absent, which is a different thing.
  const pageInt = (v, lo, hi, dflt) => (v === undefined || v === null || v === ''
    ? dflt : clampInt(v, lo, hi));
  // Paging matters more than it looks: without it a library browser shows the
  // first page of a 2000-track collection and nothing else, which is how this
  // kind of API quietly ships half-working.
  const page = (p, max) => 'limit=' + pageInt(p.limit, 1, max, Math.min(50, max))
    + '&offset=' + pageInt(p.offset, 0, 10000, 0);

  // Two of these endpoints do not page by offset at all — Spotify walks them by
  // cursor, and differently from each other: `followedArtists` continues from
  // the last artist id it handed back (`artists.cursors.after`), `recent` walks
  // backwards in time from a unix-ms timestamp (`cursors.before`). Both cursors
  // are already in the answer, which goes to widgets unshaped, so a widget reads
  // one off a page and hands it straight back. Papering the difference over with
  // one uniform cursor of our own would only build a request Spotify does not
  // honour.
  //
  // Without this, a library browser sees the first 50 followed artists and has
  // no way to ask for the 51st — `offset` is not a thing on either endpoint.
  // Reported by the author of the Spotify library browser.
  const cursorMs = (v) => (/^\d{1,20}$/.test(String(v).trim()) ? String(v).trim() : '');
  // A cursor that is present but unreadable is refused rather than dropped. Drop
  // it and the request quietly becomes "page 1 again", which a widget's "load
  // more" cannot tell from a real page — it appends the same rows and asks
  // again, forever, spending the user's quota on a loop.
  const cursorPath = (base, key, raw, clean) => {
    if (raw === undefined || raw === null || raw === '') return base;
    const v = clean(raw);
    return v ? base + '&' + key + '=' + v : '';
  };

  const SEARCH_TYPES = ['track', 'album', 'artist', 'playlist'];

  const QUERY_OPS = Object.freeze({
    player:          () => '/me/player',
    queue:           () => '/me/player/queue',
    devices:         () => '/me/player/devices',
    playlists:       (p) => '/me/playlists?' + page(p, 50),
    savedAlbums:     (p) => '/me/albums?' + page(p, 50),
    savedTracks:     (p) => '/me/tracks?' + page(p, 50),
    recent:          (p) => cursorPath('/me/player/recently-played?limit=' + pageInt(p.limit, 1, 50, 50), 'before', p.before, cursorMs),
    followedArtists: (p) => cursorPath('/me/following?type=artist&limit=' + pageInt(p.limit, 1, 50, 50), 'after', p.after, (v) => queryId(v, 'artist')),
    artistAlbums:    (p) => (queryId(p.id, 'artist') ? '/artists/' + queryId(p.id, 'artist') + '/albums?' + page(p, 50) : ''),
    albumTracks:     (p) => (queryId(p.id, 'album') ? '/albums/' + queryId(p.id, 'album') + '/tracks?' + page(p, 50) : ''),
    playlistTracks:  (p) => (queryId(p.id, 'playlist') ? '/playlists/' + queryId(p.id, 'playlist') + '/tracks?' + page(p, 100) : ''),
    search:          (p) => {
      const q = String(p.q || '').trim().slice(0, 200);
      if (!q) return '';
      const types = String(p.types || 'track,album,artist,playlist').split(',')
        .map((x) => x.trim()).filter((x) => SEARCH_TYPES.includes(x));
      if (!types.length) return '';
      return '/search?type=' + types.join(',') + '&limit=' + pageInt(p.limit, 1, 50, 20)
        + '&offset=' + pageInt(p.offset, 0, 1000, 0) + '&q=' + encodeURIComponent(q);
    },
  });

  // One op's raw answer is not the truth, and this is where that gets fixed for
  // widgets. Spotify pads /me/player/queue by wrapping the context — the tile's
  // getQueue has cut that since it was reported, but a widget reading the same
  // thing through the SDK was still handed the padding. The person who reported
  // it uses the SDK, so the fix that skipped this path missed its own reporter.
  //
  // It is not a reshaping — the objects are Spotify's own, as everything here is.
  // What comes off is the part of the list that will never play.
  const QUERY_AFTER = Object.freeze({
    queue: async (data) => {
      if (!data || !Array.isArray(data.queue)) return data;
      const p = await getPlayer();                    // cached: usually costs nothing
      const state = (p && p.ok) ? p : null;
      return Object.assign({}, data, {
        queue: normalizeQueue(data.queue, data.currently_playing, state),
      });
    },
  });
  async function shapeQueryAnswer(name, data) {
    const after = Object.hasOwn(QUERY_AFTER, name) ? QUERY_AFTER[name] : null;
    if (typeof after !== 'function') return data;
    try { return await after(data); } catch { return data; }
  }

  async function query(op, params) {
    // hasOwn, not a plain lookup: `QUERY_OPS.constructor` resolves up the
    // prototype chain to a real function, so `op: 'constructor'` would have
    // passed the guard, been called, and handed apiRequest an object where a
    // path belongs. `toString`, `valueOf` and friends are the same door.
    // Object.freeze does not close it — only asking about OWN keys does.
    const name = String(op || '');
    const build = Object.hasOwn(QUERY_OPS, name) ? QUERY_OPS[name] : null;
    if (typeof build !== 'function') return { ok: false, error: 'bad_op' };
    const path = build(params && typeof params === 'object' ? params : {});
    if (!path) return { ok: false, error: 'bad_params' };

    const cached = queryCacheGet(path);
    if (cached) return cached;
    const inflight = _queryPending.get(path);
    if (inflight) return inflight;

    const ttl = QUERY_VOLATILE.has(name) ? QUERY_TTL_VOLATILE_MS : QUERY_TTL_MS;
    const p = apiRequest('GET', path).then(async (r) => {
      if (r.ok) return { ok: true, data: await shapeQueryAnswer(name, r.data) };
      // The two new scopes are the one failure worth naming: a user connected
      // before they existed holds a perfectly valid token that simply cannot read
      // these, and "reconnect" is the fix rather than anything the widget did.
      if (r.status === 403) return { ok: false, error: 'insufficient_scope', status: 403 };
      // Say how long, so a widget can wait rather than retry into the same wall.
      if (r.status === 429) return { ok: false, error: 'rate_limited', status: 429, retryAfterMs: retryAfterMs() };
      return { ok: false, error: r.error || 'failed', status: r.status || 0 };
    }).then((res) => {
      // Only an answer is worth keeping. Caching a failure would turn one blip
      // into ten seconds of a widget that looks broken, and a rate-limit answer
      // held past its own cooldown would keep telling a widget to wait when the
      // way is already clear.
      if (res.ok) queryCachePut(path, ttl, res);
      return res;
    });
    _queryPending.set(path, p);
    try { return await p; } finally { _queryPending.delete(path); }
  }


  return { query };
}

module.exports = { makeQuery };
