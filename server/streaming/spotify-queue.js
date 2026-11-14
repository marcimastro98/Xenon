'use strict';
// What Spotify plays next: one track made into a row, and the queue cut where it starts over.

function makeQueue({ apiRequest, getPlayer }) {
  // ── Reads for the dashboard widget (trimmed, client-safe shapes) ───────────
  // Smallest album image for a compact list; the full array is widest-first.
  function trackLite(t) {
    if (!t || typeof t !== 'object') return null;
    const imgs = (t.album && Array.isArray(t.album.images)) ? t.album.images : [];
    return {
      name: t.name || '',
      uri: t.uri || '',
      artist: Array.isArray(t.artists) ? t.artists.map(a => a && a.name).filter(Boolean).join(', ') : '',
      image: imgs.length ? (imgs[imgs.length - 1].url || '') : '',
    };
  }

  // ── The queue Spotify hands back is not always a queue ──────────────────────
  // Reported by a widget author: playing a short album, /me/player/queue answers
  // with the remaining tracks and then the whole context again, and again —
  // "D E A B C D E A B C" for a five-track album sitting on C. It is padding a
  // fixed-length answer by wrapping around the context, and with repeat OFF none
  // of that wrap will ever play: after E, playback stops.
  //
  // Deduplicating by track would be the wrong tool. A playlist may hold the same
  // song twice on purpose, and a queue may genuinely play one twice in a row, so
  // this works on the ORDER and never on the set: it looks for the sequence
  // repeating as a whole and cuts the repetition, leaving what remains in place
  // and in order.
  //
  // Three conditions, all required, because each is a way for the repetition to
  // be REAL rather than padding:
  //   repeat off   with repeat on, the album really does play again — collapsing
  //                it would hide the truth rather than reveal it
  //   shuffle off  with shuffle on the queue is not the context's order, so
  //                "the sequence repeats" says nothing about a wrap
  //   the cycle ends on the track that is playing  — this is the signal that
  //                makes it safe. A context wrap always reads
  //                [next … end, start … current], so the block ends on the
  //                current track; and with repeat off the current track cannot
  //                play again, which is what proves the block is padding rather
  //                than a coincidence. A queue that happens to repeat a run of
  //                songs does not end on the one playing now.
  //
  // The trailing current track goes with it, for the same reason it identified
  // the wrap: it cannot come round again.
  //
  // What is NOT ours to touch, checked on a real account: at the END of a context
  // Spotify's own client shows a queue again — the reporter first described it as
  // recommendations and then as the previous queue reloaded — and either way the
  // track does not start playing again. So whatever appears there is what Spotify
  // itself displays, and a widget showing the same thing is right rather than
  // broken. The conditions above do not hold for it and it passes through
  // untouched. Written down because a list of songs appearing right after an album
  // ends looks exactly like something this function failed to clean up, and the
  // temptation is to keep cutting.
  //
  // NOT solved here, deliberately: the part of the wrap BEFORE the current track
  // (the "A B" above) is still returned. Identifying it needs the context's own
  // track order — from the queue alone, "…, E, A, B, …" and a real playlist that
  // runs E then A then B are the same five bytes. Left in rather than guessed at.
  function queueCycleLength(keys, currentKey) {
    const n = keys.length;
    if (n < 2 || !currentKey) return n;
    for (let p = 1; p < n; p++) {
      if (keys[p - 1] !== currentKey) continue;   // a cycle ends on the current track
      let repeats = true;
      for (let i = p; i < n; i++) {
        if (keys[i] !== keys[i - p]) { repeats = false; break; }
      }
      if (repeats) return p;
    }
    return n;
  }

  /** The upcoming tracks, with a context wrap cut off. Pure — `state` is
   *  { repeat, shuffle } as getPlayer reports them. */
  function normalizeQueue(queue, current, state) {
    const list = Array.isArray(queue) ? queue : [];
    const st = state || {};
    if (st.repeat !== 'off' || st.shuffle) return list;
    const currentKey = (current && current.uri) || '';
    if (!currentKey || list.length < 2) return list;
    const keys = list.map(t => (t && t.uri) || '');
    const p = queueCycleLength(keys, currentKey);
    if (p >= list.length) return list;            // nothing repeats: leave it alone
    return list.slice(0, p - 1);                  // drop the trailing current track too
  }

  async function getQueue() {
    const r = await apiRequest('GET', '/me/player/queue');
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'no_playback' };
    // Spotify's queue is the REAL upcoming order only when playback has a context
    // (playlist/album/artist). Playing a loose "random" track — a single, Liked
    // Songs, or radio — makes this endpoint return autoplay GUESSES that routinely
    // don't match what actually plays next. Flag that (reliable:false) so the UI can
    // annotate the list instead of presenting a wrong "next" as fact. getPlayer is
    // cached, so this rarely costs an extra call.
    const p = await getPlayer();
    const reliable = !!(p && p.ok && p.context);
    const current = trackLite(r.data.currently_playing);
    const raw = Array.isArray(r.data.queue) ? r.data.queue.slice(0, 20).map(trackLite).filter(Boolean) : [];
    return {
      ok: true,
      current,
      queue: normalizeQueue(raw, current, p && p.ok ? p : null),
      reliable,
      // What the queue is a queue OF, so a tapped row can resume the rest of it.
      contextUri: (p && p.ok && p.contextUri) ? p.contextUri : '',
    };
  }


  return { normalizeQueue, getQueue };
}

module.exports = { makeQueue };
