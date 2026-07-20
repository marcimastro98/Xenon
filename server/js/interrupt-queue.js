'use strict';
// Interrupt arbiter — the single place that decides WHEN something is allowed to
// interrupt the user, and how often.
//
// Why this exists: coordination used to live as a hardcoded selector list inside
// catalog-drop.js, so every overlay had to know the CSS class of every other
// overlay (N² relationships kept in sync by hand), and every channel ran its own
// 1.5s poller and its own daily throttle. Nobody knew how many times the user had
// already been interrupted today, so a release landing on the same day as a
// limited drop stacked two modals back to back.
//
// This module owns three things and nothing else:
//   1. busy()      — one source of truth for "the user is mid-flow, don't intrude"
//   2. whenIdle()  — ONE shared poller, priority-ordered, instead of one per channel
//   3. claimDaily()— an opt-in interruption budget shared across channels
//
// Deliberately NOT a policy change for existing surfaces. What's New / update
// (`.upd-overlay`) still opens immediately and answers to no one, and the paid
// drop modal keeps its own once-a-day rule and its own "always waits for What's
// New" behaviour. Both simply ask this module instead of carrying their own copy.
// New channels are the ones that take a budget slot.
//
// Written as a factory over injected doc/storage/timers so the queue ordering and
// budget rules are unit-testable without a DOM (see test/interrupt-queue.test.mjs).
// UMD like sdk-perf.js / theme-palette.js. Node gets the factory namespace; a
// real browser additionally gets the live instance on window. The DOM check is
// the honest browser test — an instance without a document could never answer
// busy(), which is the whole point of the module.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object' && typeof document !== 'undefined') {
    root.XenonInterrupts = api.create();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DAY = 24 * 3600 * 1000;
  const TICK_MS = 1500;
  const DEFAULT_MAX_TRIES = 200;   // ~5 min, then give up until the next page load
  const SEEN_CAP = 250;

  // Same storage key catalog-drop.js has always used, so existing installs carry
  // their announced-id history over untouched.
  const K_SEEN = 'xeneonedge.catalogSeen';
  const K_BUDGET = 'xeneonedge.interruptBudget';

  // Immersive/full-screen states where an interruption is never acceptable.
  const BUSY_CLASSES = [
    'game-mode',
    'lock-screen-active',
    'ambient-scene-open',
    'ambient-canvas-open',
    'ambient-idle',
  ];

  // Overlays that count as "something is already on screen". Channels extend this
  // via registerOverlay() rather than editing each other's files.
  //
  // The three cw-* backdrops are new to this list: they are the SDK permission,
  // clipboard-confirm and open-external dialogs. A promo modal appearing over a
  // security prompt the user is being asked to approve is the one stacking order
  // that must never happen, and the old selector list did not cover it.
  const DEFAULT_OVERLAYS = [
    '.upd-overlay',            // What's New / update available (top precedence)
    '.preset-modal-overlay',   // preset import/export
    '.cgal-overlay',           // Store / community gallery
    '.xdrop-overlay',          // paid catalog drop nudge
    '.cw-perm-backdrop',       // SDK grant request
    '.cw-clip-backdrop',       // SDK clipboard confirmation
    '.cw-ext-backdrop',        // SDK open-external confirmation
  ];

  // Priority ladder, named so channels don't hardcode magic numbers. Limited
  // editions outrank everything below the update modal: copies run out, so it is
  // the only offer that genuinely cannot wait for tomorrow.
  const PRIORITY = { limited: 30, drop: 20, message: 10, tip: 0 };

  function create(deps) {
    const d = deps || {};
    const doc = d.doc || (typeof document !== 'undefined' ? document : null);
    const store = d.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const now = d.now || Date.now;
    const setT = d.setInterval || ((fn, ms) => setInterval(fn, ms));
    const clearT = d.clearInterval || ((h) => clearInterval(h));

    const overlaySelectors = DEFAULT_OVERLAYS.slice();

    function registerOverlay(selector) {
      if (typeof selector !== 'string' || !selector) return;
      if (!overlaySelectors.includes(selector)) overlaySelectors.push(selector);
    }

    function busy() {
      if (!doc || !doc.body) return false;
      const c = doc.body.classList;
      for (const cls of BUSY_CLASSES) if (c.contains(cls)) return true;
      return !!doc.querySelector(overlaySelectors.join(', '));
    }

    // ── Storage helpers ──────────────────────────────────────────────────────
    // Every read/write is guarded: storage can be full, blocked by policy, or
    // absent in a stripped WebView. None of that may take the dashboard down.
    function readJSON(key, fallback) {
      if (!store) return fallback;
      try {
        const v = JSON.parse(store.getItem(key));
        return (v === null || v === undefined) ? fallback : v;
      } catch { return fallback; }
    }
    function writeJSON(key, value) {
      if (!store) return;
      try { store.setItem(key, JSON.stringify(value)); } catch { /* full/blocked */ }
    }

    // ── Shared announced-id set ──────────────────────────────────────────────
    // Lives here because two channels can describe the same catalog entry (a paid
    // drop and a hub announcement about it), and the second must not re-announce
    // what the first already showed.
    function readSeen() {
      const a = readJSON(K_SEEN, []);
      return Array.isArray(a) ? a : [];
    }
    function markSeen(ids) {
      if (!ids || !ids.length) return;
      const set = readSeen();
      for (const id of ids) if (id && !set.includes(id)) set.push(id);
      // Keep the most recent ids only — an unbounded list would grow forever.
      writeJSON(K_SEEN, set.slice(-SEEN_CAP));
    }
    const hasSeen = (id) => !!id && readSeen().includes(id);

    // ── Daily interruption budget ────────────────────────────────────────────
    // Opt-in: a channel that calls claimDaily() agrees to stay silent for the rest
    // of the day if another budgeted channel got there first. Existing surfaces do
    // not call it, so their cadence is unchanged.
    function budgetSpent() {
      const b = readJSON(K_BUDGET, null);
      if (!b || typeof b.at !== 'number') return false;
      return (now() - b.at) < DAY;             // older than a day → unspent again
    }
    function claimDaily(channel) {
      if (budgetSpent()) return false;
      // A blocked storage means the claim isn't remembered; allow anyway. A lost
      // budget shows one extra modal, a lost message is never seen at all.
      writeJSON(K_BUDGET, { at: now(), channel: String(channel || '') });
      return true;
    }

    // ── The single poller ────────────────────────────────────────────────────
    // One timer for every waiting channel. Highest priority first; only ONE waiter
    // runs per idle tick, because presenting something makes busy() true again and
    // the rest must re-evaluate against the new state.
    const waiters = [];
    let timer = null;
    let seq = 0;

    function stopTimer() {
      if (timer !== null) { clearT(timer); timer = null; }
    }

    function tick() {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (++waiters[i].tries > waiters[i].maxTries) waiters.splice(i, 1);
      }
      if (!waiters.length) { stopTimer(); return; }
      if (busy()) return;

      // Ties break by insertion order so an equal-priority channel that has been
      // waiting longer is not starved by a later arrival.
      waiters.sort((a, b) => (b.priority - a.priority) || (a.id - b.id));
      const next = waiters.shift();
      if (!waiters.length) stopTimer();
      try { next.fn(); } catch { /* a channel throwing must not stall the queue */ }
    }

    // Run `fn` as soon as nothing else is on screen. Returns a cancel function.
    // priority: higher wins when several are waiting for the same gap.
    function whenIdle(fn, opts) {
      if (typeof fn !== 'function') return () => {};
      const o = opts || {};
      const entry = {
        id: ++seq,
        fn,
        priority: Number.isFinite(o.priority) ? o.priority : 0,
        tries: 0,
        maxTries: Number.isFinite(o.maxTries) ? o.maxTries : DEFAULT_MAX_TRIES,
      };
      // Immediate path: an open gap right now should not cost a 1.5s delay. Only
      // when nothing is already queued, or a late low-priority caller would jump
      // the queue ahead of someone who has been waiting.
      if (!waiters.length && !busy()) {
        try { fn(); } catch { /* ignore */ }
        return () => {};
      }
      waiters.push(entry);
      if (timer === null) timer = setT(tick, TICK_MS);
      return () => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        if (!waiters.length) stopTimer();
      };
    }

    return {
      busy,
      whenIdle,
      registerOverlay,
      claimDaily,
      budgetSpent,
      readSeen,
      markSeen,
      hasSeen,
      PRIORITY,
      _tick: tick,               // test seam: drive the poller without real timers
      _waiting: () => waiters.length,
    };
  }

  return { create, PRIORITY, DAY, TICK_MS, K_SEEN, K_BUDGET };
});
