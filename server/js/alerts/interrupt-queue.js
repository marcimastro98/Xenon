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
// This module owns two things and nothing else:
//   1. busy()      — one source of truth for "the user is mid-flow, don't intrude"
//   2. whenIdle()  — ONE shared poller, priority-ordered, instead of one per channel
// The one-a-day limit on Bit's messages lives in server/bit-messages.js.
//
// Deliberately NOT a policy change for existing surfaces. What's New / update
// (`.upd-overlay`) still opens immediately and answers to no one, and the paid
// drop modal keeps its own once-a-day rule and its own "always waits for What's
// New" behaviour. Both simply ask this module instead of carrying their own copy.
//
// Written as a factory over injected doc/storage/timers so the queue ordering is
// unit-testable without a DOM (see test/interrupt-queue.test.mjs).
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
  const TICK_MS = 1500;
  const DEFAULT_MAX_TRIES = 200;   // ~5 min, then give up until the next page load

  // The drops this device was already told about. Nothing writes it any more: the
  // inbox imports it once, so nobody hears about an old drop again.
  const K_SEEN = 'xeneonedge.catalogSeen';

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
    // The two first-run surfaces. They are the FIRST thing a new user sees and
    // the last thing anything may cover: the screen question is a question, and
    // a promo modal landing on top of it leaves someone unable to answer the one
    // thing the app asked them. Measured on a real first run: the catalog drop
    // fires ~20s after load and the hub message ~35s, both found the screen
    // "idle" because neither selector was here, and both drew straight over the
    // dialog. They are listed above everything else because they outrank it.
    '.sp-overlay',             // "Where do you want Xenon?" (first run)
    '.onb-overlay',            // the guided tour that follows it
    '.upd-overlay',            // update available
    '.wn-stage',               // What's New of a major, full screen
    '.rn-overlay',             // what a release fixed, or a failed update
    '.preset-modal-overlay',   // preset import/export
    '.cgal-overlay',           // Store / community gallery
    '.cw-perm-backdrop',       // SDK grant request
    '.cw-clip-backdrop',       // SDK clipboard confirmation
    '.cw-ext-backdrop',        // SDK open-external confirmation
    // Codex or Claude Code is BLOCKED behind this one: a tool call on the user's
    // machine is waiting on the tap. The three above are SDK dialogs, not this — this
    // is the agents' own fullscreen request, and it outranks anything promotional by
    // the same argument as the first-run surfaces above.
    '.ask-overlay',
    '.xm-scrim',               // the Xenon menu on the dashboard: it sits above any card
    '.widget-palette-overlay', // the "+" gallery: someone is choosing a widget
    '.deck-ed-backdrop',       // the Deck's key editor and Smart Profiles: work in progress
    '.deck-mix-backdrop',      // the Deck's mixer
    '.deck-style-modal',       // the Deck's look
    '.xfer-sheet-backdrop',    // Send to PC
  ];

  // Priority ladder, named so channels don't hardcode magic numbers. Limited
  // editions outrank everything below the update modal: copies run out, so it is
  // the only offer that genuinely cannot wait for tomorrow.
  //
  // `update` sits on top because What's New explains the version the user is
  // already running, and reading a promo before being told what changed is the
  // wrong order. It still opens with no delay when the screen is clear —
  // whenIdle() runs immediately in that case — so its long-standing "answers to
  // no one" behaviour only changes when something is genuinely in the way.
  const PRIORITY = { update: 40, limited: 30, drop: 20, message: 10, tip: 0 };

  function create(deps) {
    const d = deps || {};
    const doc = d.doc || (typeof document !== 'undefined' ? document : null);
    const store = d.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
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

    function readSeen() {
      const a = readJSON(K_SEEN, []);
      return Array.isArray(a) ? a : [];
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
        maxTries: Number.isFinite(o.maxTries) || o.maxTries === Infinity ? o.maxTries : DEFAULT_MAX_TRIES,
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
      readSeen,
      PRIORITY,
      _tick: tick,               // test seam: drive the poller without real timers
      _waiting: () => waiters.length,
    };
  }

  return { create, PRIORITY, TICK_MS, K_SEEN };
});
