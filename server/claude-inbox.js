'use strict';

// ── Tile messages for a Claude Code session open in a terminal ───────────────
// The Xenon mod (integrations/claude-code/, 0.3.0 and later) asks here, from a
// timer in an interactive session, whether the Claude tile has a message for
// that session. The request is held open (a long poll) for two reasons: a
// message typed on the tile reaches the session at once instead of on the next
// ask, and the hub knows which sessions have a mod listening RIGHT NOW. A
// session with a request held here, or with one that ended a moment ago, is
// "present", and only a present session is offered the tile's "goes into the
// open session" mode; every other idle session is continued as a background run
// exactly as before.
//
// This module only parks and answers requests. What may be handed over, and
// when, is the bridge's call (`take` → claude-bridge.js takeForTerminal): only
// to an idle session, and only once. The text passes through; it is never kept
// or logged here.
//
// Bounded: a few waiters per session and a cap overall, one hold timer per
// waiter and one short grace timer per session that just lost its last waiter,
// all unref'd and all cleared by stop().

// Claude Code session ids are UUIDs; the shape the transcript readers accept.
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
// Well under the mod's own limit of 30 s for one $.http.fetch.
const HOLD_MS = 20 * 1000;
// The mod asks again about a second after each answer. A session stays present
// across that gap, and stops being present this long after its last request
// ended: the terminal was closed, or Claude Code exited.
const GRACE_MS = 5 * 1000;
// One Claude Code per session is the norm; the same session resumed in a
// second terminal is tolerated, and a third request retires the oldest.
const MAX_PER_SESSION = 2;
const MAX_WAITERS = 40;

function send(res, body) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch { /* the caller already left */ }
}

function createInbox(opts) {
  const options = opts || {};
  const take = typeof options.take === 'function' ? options.take : () => '';
  const onPresence = typeof options.onPresence === 'function' ? options.onPresence : () => {};
  const holdMs = options.holdMs || HOLD_MS;
  const graceMs = options.graceMs || GRACE_MS;

  const waiters = new Map();   // session id → [{ res, timer, onClose }], oldest first
  const lingering = new Map(); // session id → grace timer, after its last waiter left
  const shown = new Set();     // session ids last reported present
  let total = 0;
  let stopped = false;

  function present(sessionId) {
    return waiters.has(sessionId) || lingering.has(sessionId);
  }

  // Tells the caller about a change only, so a session that keeps asking does
  // not repaint the dashboard every twenty seconds.
  function report(id) {
    if (stopped) return;
    const now = present(id);
    if (now === shown.has(id)) return;
    if (now) shown.add(id); else shown.delete(id);
    try { onPresence(id, now); } catch { /* a listener must never break the inbox */ }
  }

  function linger(id) {
    if (stopped || lingering.has(id)) return;
    const timer = setTimeout(() => { lingering.delete(id); report(id); }, graceMs);
    if (typeof timer.unref === 'function') timer.unref();
    lingering.set(id, timer);
  }

  function unlinger(id) {
    const timer = lingering.get(id);
    if (!timer) return;
    clearTimeout(timer);
    lingering.delete(id);
  }

  // Ends one waiter: answers it with `body`, or with nothing when its caller
  // is already gone. Safe to call twice for the same waiter.
  function settle(id, w, body) {
    const list = waiters.get(id);
    const i = list ? list.indexOf(w) : -1;
    if (i < 0) return;
    list.splice(i, 1);
    if (!list.length) waiters.delete(id);
    total -= 1;
    clearTimeout(w.timer);
    w.res.off('close', w.onClose);
    if (body) send(w.res, body);
    if (!waiters.has(id)) linger(id);
    report(id);
  }

  // 'answered' (a message was waiting, or the inbox is shutting down), 'held',
  // 'busy' (too many open requests: the caller answers 429) or 'bad_session'
  // (the caller answers 400). Only 'busy' and 'bad_session' leave `res` to it.
  function hold(sessionId, res) {
    const id = typeof sessionId === 'string' && SESSION_RE.test(sessionId) ? sessionId : '';
    if (!id) return 'bad_session';
    if (stopped) { send(res, {}); return 'answered'; }
    const text = take(id);
    if (text) {
      send(res, { text });
      linger(id);
      report(id);
      return 'answered';
    }
    const list = waiters.get(id) || [];
    while (list.length >= MAX_PER_SESSION) settle(id, list[0], {});
    if (total >= MAX_WAITERS) return 'busy';
    const w = { res, timer: null, onClose: null };
    w.onClose = () => settle(id, w, null);
    w.timer = setTimeout(() => settle(id, w, {}), holdMs);
    if (typeof w.timer.unref === 'function') w.timer.unref();
    res.on('close', w.onClose);
    unlinger(id);
    list.push(w);
    waiters.set(id, list);
    total += 1;
    report(id);
    return 'held';
  }

  // A message was just queued for this session: hand it to the newest waiter,
  // the one most likely to still be connected. With nobody waiting it stays
  // queued, and the mod's next ask (about a second away) takes it.
  function wake(sessionId) {
    const list = waiters.get(sessionId);
    if (!list || !list.length) return false;
    const text = take(sessionId);
    if (!text) return false;
    settle(sessionId, list[list.length - 1], { text });
    return true;
  }

  // Shutdown: answer every held request with nothing, so no Claude Code is
  // left waiting on a response the hub will never send.
  function stop() {
    stopped = true;
    for (const [id, list] of Array.from(waiters)) {
      for (const w of list.slice()) settle(id, w, {});
    }
    for (const timer of lingering.values()) clearTimeout(timer);
    lingering.clear();
    shown.clear();
  }

  return {
    hold, wake, present, stop,
    get waiting() { return total; },
  };
}

module.exports = { createInbox, HOLD_MS, GRACE_MS, MAX_PER_SESSION, MAX_WAITERS };
