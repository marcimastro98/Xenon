'use strict';
// Song lyrics: the shared engine behind the Media tile's Lyrics sheet and the
// Lyrics widget. It owns the one fetch of GET /api/lyrics per track (the server
// reads the current track itself and asks LRCLIB), and the timing: which line is
// active at the projected playback position (media.js currentMediaPositionMs).
//
// Timing runs on ONE setTimeout aimed at the next line change, re-aimed on every
// media tick — no requestAnimationFrame loop, so a playing song costs a handful
// of frames per line. Nothing runs (no timer, no fetch) unless at least one
// subscriber reports itself visible.
(function () {
  const STATES = new Set(['off', 'idle', 'live', 'synced', 'plain', 'instrumental', 'none', 'busy', 'error']);
  const MAX_LINES = 2000;
  const MAX_LINE_CHARS = 300;
  const FETCH_DEADLINE_MS = 45 * 1000;    // the server may make up to 4 LRCLIB requests
  const RETRY_LATER_MS = 20 * 1000;       // busy / unreachable
  const TITLE_RACE_RETRY_MS = 1500;       // server answered for the track before this one
  const GAP_MIN_MS = 5000;                // a blank line this long shows the pause dots
  const GAP_STEPS = 3;
  const MIN_TIMER_MS = 40;
  const OFFSET_LIMIT_MS = 3000;

  const subscribers = new Set();
  let snap = blank('idle');
  let wantKey = '';          // track the dashboard is showing
  let fetching = false;
  let titleRetried = false;
  let lineTimer = null;
  let retryTimer = null;

  function blank(state) {
    return { state, key: '', songKey: '', songOffset: null, lines: [], plain: [], index: -1, gapStep: -1, playing: false };
  }

  // ── pure helpers (also read by the tests) ─────────────────────────────
  // Index of the last line whose time is <= ms, or -1 before the first line.
  function activeIndex(lines, ms) {
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  // Dots for a long instrumental pause: which of GAP_STEPS has been reached, or
  // -1 when the active line is not a long blank.
  function gapStep(lines, index, ms) {
    const line = lines[index];
    const next = lines[index + 1];
    if (!line || line.text || !next) return -1;
    const len = next.t - line.t;
    if (len < GAP_MIN_MS) return -1;
    return Math.min(GAP_STEPS - 1, Math.floor((ms - line.t) / (len / GAP_STEPS)));
  }

  // When the view next needs to change: the next line, or the next pause step.
  function nextChangeAt(lines, index, ms) {
    const next = lines[index + 1];
    if (!next) return null;
    const step = gapStep(lines, index, ms);
    if (step >= 0 && step < GAP_STEPS - 1) {
      return lines[index].t + (step + 1) * ((next.t - lines[index].t) / GAP_STEPS);
    }
    return next.t;
  }

  // ── word timing (an estimate: LRCLIB times lines, never words) ─────────
  // Sung time follows syllables, not letters ("through" is one beat, "area"
  // three), plus a short onset per word and a breath after a comma.
  const SYLLABLE_MS = 260;           // ~4 syllables a second, an average pop pace
  const WORD_ONSET = 0.25;           // in syllables
  const COMMA_BREATH = 0.6;          // in syllables
  const LINE_FILL = 0.88;            // the last word lands a little before the next line
  const STRETCH_LIMIT = 1.6;         // a slot up to this much longer than the pace is sung slower
  const VOWEL_GROUPS = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœаеёиоуыэюяіїєαεηιουω]+/giu;
  const SYLLABIC_CHARS = /[぀-ヿ㐀-鿿가-힯]/gu;   // kana, CJK, hangul: one each

  function syllables(word) {
    const cjk = (word.match(SYLLABIC_CHARS) || []).length;
    const vowels = (word.match(VOWEL_GROUPS) || []).length;
    if (cjk || vowels) return cjk + vowels;
    const letters = (word.match(/\p{L}/gu) || []).length;
    return letters ? Math.max(1, Math.round(letters / 3)) : 0;
  }

  // When each word starts, in ms from the line's own time. `slotMs` is the time
  // until the next line (null for the last). A line followed by a long pause is
  // sung at the average pace, not stretched over the pause.
  function wordWeights(words) {
    return words.map(w => syllables(w) + WORD_ONSET + (/[,;:]$/.test(w) ? COMMA_BREATH : 0));
  }

  function wordStarts(words, slotMs) {
    const weights = wordWeights(words);
    const total = weights.reduce((a, n) => a + n, 0) || 1;
    const natural = total * SYLLABLE_MS;
    const slot = Number.isFinite(slotMs) && slotMs > 0 ? slotMs * LINE_FILL : null;
    const span = slot == null ? natural : (slot <= natural * STRETCH_LIMIT ? slot : natural);
    let acc = 0;
    return weights.map(n => { const at = (acc / total) * span; acc += n; return Math.round(at); });
  }

  // ── implied pauses ─────────────────────────────────────────────────────
  // Many LRC files have no blank line before an instrumental break, so the
  // last sung line stayed lit through the whole break and the lyrics looked
  // stuck. When a line has far more time than even a slow singer needs, a
  // blank line goes where the singing has surely ended, and the view shows
  // the pause dots from there.
  const SLOW_PACE = 2;               // sung up to twice slower than the average pace
  const HOLD_TAIL_MS = 1500;         // a held last note

  function withImpliedPauses(lines) {
    const out = [];
    lines.forEach((line, i) => {
      out.push(line);
      const next = lines[i + 1];
      if (!line.text || !next) return;
      const weights = wordWeights(line.text.split(/\s+/).filter(Boolean));
      const sungMs = weights.reduce((a, n) => a + n, 0) * SYLLABLE_MS * SLOW_PACE + HOLD_TAIL_MS;
      const pauseAt = Math.round(line.t + sungMs);
      if (next.t - pauseAt >= GAP_MIN_MS) out.push({ t: pauseAt, text: '' });
    });
    return out;
  }

  // ── boundary: everything from the wire is checked here ────────────────
  function cleanLine(s) {
    return typeof s === 'string' ? s.slice(0, MAX_LINE_CHARS) : '';
  }
  function validReply(d) {
    if (!d || d.ok !== true || !STATES.has(d.state)) return null;
    const out = blank(d.state);
    // The server's own song key: what the supporter widget's timing and
    // translation requests name. `key` below becomes the client's track key.
    out.songKey = typeof d.key === 'string' ? d.key.slice(0, 600) : '';
    out.title = typeof d.title === 'string' ? d.title : '';
    const off = Number(d.offsetMs);
    out.songOffset = Number.isFinite(off) && Math.abs(off) <= OFFSET_LIMIT_MS ? off : null;
    if (d.state === 'synced') {
      if (!Array.isArray(d.lines)) return null;
      // `src` is the line's place in the server's list: a translation comes
      // back in that order, while the pauses added here have none.
      out.lines = withImpliedPauses(d.lines.slice(0, MAX_LINES)
        .map((l, src) => (l && Number.isFinite(l.t) && l.t >= 0 ? { t: l.t, text: cleanLine(l.text), src } : null))
        .filter(Boolean)
        .sort((a, b) => a.t - b.t)).slice(0, MAX_LINES);
      if (!out.lines.length) out.state = 'none';
    } else if (d.state === 'plain') {
      out.plain = Array.isArray(d.plain) ? d.plain.slice(0, MAX_LINES).map(cleanLine) : [];
      if (!out.plain.some(Boolean)) out.state = 'none';
    }
    return out;
  }

  // ── inputs ─────────────────────────────────────────────────────────────
  const media = () => (typeof mediaData === 'object' && mediaData) ? mediaData : null;
  const enabled = () => !(typeof hubSettings === 'object' && hubSettings && hubSettings.mediaLyrics === false);
  function globalOffsetMs() {
    const v = typeof hubSettings === 'object' && hubSettings ? Number(hubSettings.lyricsOffsetMs) : 0;
    return Number.isFinite(v) ? v : 0;
  }
  // The song's own nudge (set from the supporter widget) is added to the
  // global one, and the sum stays inside the same ±3 s.
  function offsetMs() {
    const total = globalOffsetMs() + (Number.isFinite(snap.songOffset) ? snap.songOffset : 0);
    return Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, total));
  }
  // The widget changed this song's nudge: apply it now, before the server
  // answers. 0 = none.
  function setSongOffset(songKey, ms) {
    if (!songKey || songKey !== snap.songKey) return;
    snap.songOffset = Number.isFinite(ms) && ms !== 0 ? ms : null;
    snap.rendered = false;
    tick();
  }
  function current() {
    return snap;
  }
  // A positive offset shows each line earlier.
  function positionMs() {
    return (typeof currentMediaPositionMs === 'function' ? currentMediaPositionMs() : 0) + offsetMs();
  }
  // Changes when the position jumps (seek, pause, track, offset), never for drift.
  function clockEpoch() {
    return (typeof mediaClockEpoch === 'function' ? mediaClockEpoch() : 0) + '|' + offsetMs();
  }
  function clientKey(m) {
    return m ? [m.title, m.artist, m.album, m.duration].map(v => String(v == null ? '' : v)).join('|') : '';
  }
  const anyVisible = () => [...subscribers].some(s => { try { return !!s.isVisible(); } catch { return false; } });

  function emit() {
    for (const s of subscribers) {
      try { if (s.isVisible()) s.render(snap); } catch (e) { console.error('[lyrics]', e); }
    }
  }

  // ── fetch ──────────────────────────────────────────────────────────────
  function stopTimers() {
    clearTimeout(lineTimer); lineTimer = null;
    clearTimeout(retryTimer); retryTimer = null;
  }

  function scheduleRetry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; if (anyVisible()) load(); }, ms);
  }

  async function load() {
    if (fetching) return;
    const key = wantKey;
    fetching = true;
    let reply = null;
    try {
      const r = await fetchWithDeadline(SERVER + '/api/lyrics', FETCH_DEADLINE_MS);
      reply = validReply(await r.json());
    } catch { reply = null; }
    finally { fetching = false; }

    // The track changed while we waited: this answer belongs to the old one.
    if (key !== wantKey) { if (anyVisible()) load(); return; }
    const m = media();
    // The server's media snapshot can trail a skip by a moment.
    if (reply && reply.title && m && reply.title !== String(m.title || '') && !titleRetried) {
      titleRetried = true;
      scheduleRetry(TITLE_RACE_RETRY_MS);
      return;
    }
    snap = reply || blank('error');
    snap.key = key;
    if (snap.state === 'busy' || snap.state === 'error') scheduleRetry(RETRY_LATER_MS);
    tick();
  }

  // ── timing ─────────────────────────────────────────────────────────────
  function tick() {
    clearTimeout(lineTimer); lineTimer = null;
    const m = media();
    snap.playing = !!(m && m.playbackStatus === 'Playing');
    if (snap.state !== 'synced') { emit(); return; }
    const ms = positionMs();
    const index = activeIndex(snap.lines, ms);
    const step = gapStep(snap.lines, index, ms);
    const changed = index !== snap.index || step !== snap.gapStep || !snap.rendered;
    snap.index = index;
    snap.gapStep = step;
    snap.rendered = true;
    if (changed) emit();
    if (!snap.playing) return;
    const at = index < 0 ? (snap.lines[0] && snap.lines[0].t) : nextChangeAt(snap.lines, index, ms);
    if (at == null) return;
    lineTimer = setTimeout(() => { lineTimer = null; if (anyVisible()) tick(); }, Math.max(MIN_TIMER_MS, at - ms));
  }

  // Called by media.js on every media update, and by subscribers when they
  // become visible or the setting changes.
  function sync() {
    if (!anyVisible()) { stopTimers(); return; }
    if (!enabled()) { stopTimers(); wantKey = ''; snap = blank('off'); emit(); return; }
    const m = media();
    const active = typeof hasActiveMedia === 'function' ? hasActiveMedia() : !!(m && m.active);
    if (!active) { stopTimers(); wantKey = ''; snap = blank('idle'); emit(); return; }
    const key = clientKey(m);
    if (key !== wantKey) {
      wantKey = key;
      titleRetried = false;
      clearTimeout(retryTimer); retryTimer = null;
      snap = blank('loading');
      snap.key = key;
      emit();
      load();
      return;
    }
    if (snap.state === 'loading') { if (!fetching && !retryTimer) load(); return; }
    snap.rendered = false;   // a subscriber may have just appeared
    tick();
  }

  function retry() {
    wantKey = '';
    sync();
  }

  // Jump playback to a line. Whole seconds is what the hosts accept; floor so
  // the tapped line is already showing when the host lands.
  async function seekToLine(index) {
    const line = snap.state === 'synced' ? snap.lines[index] : null;
    if (!line) return false;
    const target = Math.max(0, line.t - offsetMs());
    const seconds = Math.floor(target / 1000);
    let ok = false;
    try {
      const r = await fetchWithDeadline(SERVER + '/actions/run', 10000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'mediaSeek', position: seconds }),
      });
      ok = !!((await r.json()) || {}).ok;
    } catch { ok = false; }
    if (ok) {
      if (typeof noteMediaSeek === 'function') noteMediaSeek(seconds * 1000);
      tick();
    } else if (typeof showHubToast === 'function') {
      showHubToast(t('lyrics_title'), t('lyrics_seek_failed'), '');
    }
    return ok;
  }

  // subscriber: { isVisible(): boolean, render(snapshot) }. Returns an unsubscribe.
  function subscribe(sub) {
    subscribers.add(sub);
    sync();
    return () => { subscribers.delete(sub); if (!anyVisible()) stopTimers(); };
  }

  document.addEventListener('visibilitychange', sync);
  window.addEventListener('xenon:page-change', () => sync());

  window.LyricsCore = { subscribe, sync, retry, seekToLine, positionMs, clockEpoch, offsetMs, globalOffsetMs, setSongOffset, current, wordStarts, withImpliedPauses, activeIndex, gapStep, nextChangeAt, GAP_STEPS, GAP_MIN_MS };
})();
