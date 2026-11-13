// The last cover picture that was good, and the key of the one last sent to the screens, so a
// track that briefly loses its cover keeps showing it.

const thumbMemory = {
  // Sticky per-track album art. SMTC — browser/YouTube sessions especially —
  // often reports a track's metadata a beat before (or, after an idle/reconnect,
  // briefly without) its artwork stream. The client backfills a missing cover
  // from its own `_lastThumb`, but a client that connects in that window (a
  // reload, an iCUE restart mid-playback, a second surface) has an empty
  // `_lastThumb` and shows the "no media" placeholder even though the cover was
  // available seconds earlier. Remember the last non-empty thumbnail keyed by
  // track and backfill it whenever a later read of the SAME track comes back
  // without one, so every consumer (SSE connect-seed, GET /media, the 2s
  // broadcast, lockscreen, mini-player, deck, SDK relay) keeps the art through a
  // transient null read or a reconnect. Keyed by track, so a genuine track change
  // (new key) never inherits the previous cover — it clears to the placeholder
  // until the new track's artwork arrives, exactly like the client's `_lastThumb`.
  lastGood: { title: '', artist: '', album: '', value: '' },
  // The album-art thumbnail is a ~50-100KB base64 data URI. Re-sending it on every
  // 2s 'media' broadcast is pure waste once the client holds it: the client caches
  // the last thumbnail per track (media.js `_lastThumb`) and reuses it whenever a
  // payload omits one for the same track. So strip the thumbnail from BROADCASTS
  // while the track is unchanged — the SSE connect-seed and GET /media still carry
  // it in full so a fresh or reconnecting client always gets the art. The key
  // mirrors the client's `trackKey` so we re-send whenever the client would clear.
  lastSentKey: null,
};

module.exports = { thumbMemory };
