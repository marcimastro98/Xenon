'use strict';
// Lyrics translation and reading for the supporter Lyrics widget. One
// controller for every copy of the tile: one song plays at a time.
//
// What it costs is decided on the server (lyrics-translator.js: once per song,
// monthly cap); this side only decides WHEN to ask, and asks late on purpose:
//   • first a cachedOnly ask, which never spends: a song heard before shows its
//     translation at once;
//   • a new song is sent only after LISTEN_MS of actual playback with a tile on
//     screen, so skipping through a playlist costs nothing.
(function () {
  const LISTEN_MS = 20 * 1000;

  const listeners = new Set();
  let songKey = '';
  let askedLang = '';          // a language switch asks again for the same song
  let status = 'off';          // off | idle | checking | waiting | loading | ready | same | <error code>
  let extras = null;           // { tr, read } by the server's line order
  let heardMs = 0;
  let listenStartedAt = 0;
  let listenTimer = null;
  let asking = false;

  const base = () => (typeof SERVER === 'string' ? SERVER : '');
  const enabled = () => typeof hubSettings === 'object' && hubSettings && hubSettings.lyricsTranslate === true;
  const uiLang = () => String((typeof lang === 'string' && lang) || 'en').slice(0, 2).toLowerCase();

  function notify() {
    for (const fn of listeners) { try { fn(); } catch (e) { console.error('[lyrics-translation]', e); } }
  }

  function set(nextStatus, nextExtras) {
    status = nextStatus;
    extras = nextExtras || null;
    notify();
  }

  function stopListening() {
    if (listenTimer) {
      clearTimeout(listenTimer);
      listenTimer = null;
      heardMs += performance.now() - listenStartedAt;
    }
  }

  function cleanList(v) {
    return Array.isArray(v) ? v.map(s => (typeof s === 'string' ? s : '')) : [];
  }

  async function ask(cachedOnly) {
    if (asking) return;
    const key = songKey;
    const language = askedLang;
    asking = true;
    let out = null;
    try {
      const res = await fetch(base() + '/api/lyrics/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, lang: language, cachedOnly }),
      });
      out = await res.json();
    } catch { out = { ok: false, error: 'offline' }; }
    finally { asking = false; }
    if (key !== songKey || language !== askedLang) return;   // song or language changed while we waited
    if (out && out.ok) {
      const tr = cleanList(out.tr);
      const read = cleanList(out.read);
      set(out.same && !read.some(Boolean) ? 'same' : 'ready', { tr, read });
      return;
    }
    const err = (out && typeof out.error === 'string') ? out.error : 'failed';
    if (err === 'not_cached') { set('waiting'); return; }
    set(err);
  }

  // Called by every visible tile on each render with the lyrics snapshot.
  function update(snap, visible) {
    if (!enabled()) { stopListening(); if (status !== 'off') { songKey = ''; set('off'); } return; }
    const listed = snap && (snap.state === 'synced' || snap.state === 'plain') && snap.songKey;
    if (!listed) { stopListening(); if (status !== 'idle') { songKey = ''; set('idle'); } return; }
    if (snap.songKey !== songKey || uiLang() !== askedLang) {
      stopListening();
      songKey = snap.songKey;
      askedLang = uiLang();
      heardMs = 0;
      set('checking');
      void ask(true);
      return;
    }
    if (status !== 'waiting') { stopListening(); return; }
    const playing = !!(snap.playing && visible);
    if (!playing) { stopListening(); return; }
    if (listenTimer) return;
    listenStartedAt = performance.now();
    listenTimer = setTimeout(() => {
      listenTimer = null;
      heardMs += performance.now() - listenStartedAt;
      if (status !== 'waiting') return;
      // A tile re-renders on line changes, not on pause: check the player now.
      const m = typeof mediaData === 'object' && mediaData;
      if (!m || m.playbackStatus !== 'Playing') return;
      set('loading');
      void ask(false);
    }, Math.max(0, LISTEN_MS - heardMs));
  }

  // The setting was switched on or off, or the language changed.
  function reset() {
    stopListening();
    songKey = '';
    set(enabled() ? 'idle' : 'off');
    if (window.LyricsCore) window.LyricsCore.sync();
  }

  async function usage() {
    try {
      const res = await fetch(base() + '/api/lyrics/translate/usage', { cache: 'no-store' });
      const out = await res.json();
      return out && out.ok ? out : null;
    } catch { return null; }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  window.LyricsTranslation = {
    update, reset, usage, subscribe,
    status: () => status, extras: () => extras, LISTEN_MS,
  };
})();
