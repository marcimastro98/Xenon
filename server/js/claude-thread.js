'use strict';
// The conversation of one Claude Code session, kept current for the tile's
// console. It exists because "the terminal finished but the tile never showed
// the end" had four causes, each fixed here:
//
//   * The Stop hook fires around the moment Claude Code appends the final
//     reply, not after it, so a single read on Stop could land before the line
//     did and nothing read again. After every state change the thread is
//     re-read a few times (SETTLE_MS) until the transcript shows the lines that
//     close a turn (`closed` from /api/claude/transcript).
//   * A session going waiting -> idle was never re-read (the old poll only did
//     a last read if its timer had been running). Any state change settles now.
//   * An older answer could overwrite a newer one, and a failed read emptied the
//     thread. Answers carry a sequence number; a failure keeps what is shown.
//   * The Stop hook already carries the final text (`lastSaid`). Until the
//     transcript has it, it is shown as a provisional last message.
//
// The pure parts are exported for node tests (test/claude-thread.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClaudeThread = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const POLL_MS = 2500;
  const SETTLE_MS = [500, 1500, 4000, 9000];
  const MATCH_CHARS = 160;

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  // Same thread? Compared on length and the last message, which is what changes
  // while a session works; repainting an unchanged thread restarts animations
  // and fights the scroll position for nothing.
  function sameThread(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    if (!a.length) return true;
    const x = a[a.length - 1], y = b[b.length - 1];
    return x.text === y.text && x.role === y.role && !!x.provisional === !!y.provisional;
  }

  // The transcript, plus the Stop hook's final text when the transcript does
  // not have it yet. Matched on a normalised prefix, since the hook's copy is
  // clamped and the transcript's may be cut for size.
  function withProvisional(messages, sess, closed) {
    const list = Array.isArray(messages) ? messages : [];
    if (closed || !sess || sess.state !== 'idle' || !sess.lastSaid) return list;
    const want = norm(sess.lastSaid).slice(0, MATCH_CHARS);
    if (!want) return list;
    const recent = list.slice(-4).filter((m) => m.role === 'assistant');
    if (recent.some((m) => norm(m.text).slice(0, MATCH_CHARS) === want)) return list;
    return list.concat([{ role: 'assistant', text: sess.lastSaid, at: 0, provisional: true }]);
  }

  /**
   * One controller per surface. `fetchJson(url)` resolves to JSON or null;
   * `onChange()` is called when what should be drawn changed.
   */
  function create({ fetchJson, onChange, setTimer = setTimeout, clearTimer = clearTimeout,
    setEvery = setInterval, clearEvery = clearInterval }) {
    let id = '';
    let messages = null;       // null = not loaded yet
    let closed = false;
    let full = false;
    let seq = 0;
    let poll = null;
    let settle = [];
    let lastState = '';
    let unread = false;        // a new reply arrived while the reader was scrolled up
    let atBottom = true;

    function clearSettle() { settle.forEach(clearTimer); settle = []; }
    function stopPoll() { if (poll) { clearEvery(poll); poll = null; } }

    async function load() {
      if (!id) return;
      const mine = ++seq;
      const want = id;
      const d = await fetchJson('/api/claude/transcript?session=' + encodeURIComponent(want) + (full ? '&full=1' : ''));
      if (want !== id || mine !== seq) return;      // a newer read or another session
      if (!d) return;                                // network hiccup: keep what is shown
      const next = d.ok && Array.isArray(d.messages) ? d.messages : (messages || []);
      closed = !!d.closed;
      if (closed) clearSettle();
      if (messages && sameThread(messages, next)) return;
      if (messages && next.length && !atBottom) unread = true;
      messages = next;
      onChange();
    }

    function startSettle() {
      clearSettle();
      settle = SETTLE_MS.map((ms) => setTimer(() => { load(); }, ms));
    }

    /** Called with the session's live record on every push. */
    function sync(sess) {
      if (!id) return;
      const state = sess ? (sess.ended ? 'ended' : sess.state) : 'gone';
      if (state === 'running' && !poll) poll = setEvery(load, POLL_MS);
      if (state !== 'running') stopPoll();
      if (lastState && state !== lastState) startSettle();
      lastState = state;
    }

    function open(sessionId) {
      if (sessionId === id) return;
      close();
      id = sessionId || '';
      if (!id) return;
      atBottom = true;
      load();
    }

    function close() {
      stopPoll(); clearSettle();
      id = ''; messages = null; closed = false; full = false; lastState = ''; unread = false;
      seq++;
    }

    return {
      open, close, sync, load,
      get id() { return id; },
      view(sess) { return messages === null ? null : withProvisional(messages, sess, closed); },
      get closed() { return closed; },
      get full() { return full; },
      showFull() { if (!full) { full = true; load(); } },
      get unread() { return unread; },
      setAtBottom(v) { atBottom = !!v; if (atBottom) unread = false; },
      get atBottom() { return atBottom; },
    };
  }

  return { create, withProvisional, sameThread, POLL_MS, SETTLE_MS };
});
