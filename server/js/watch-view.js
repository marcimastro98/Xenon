'use strict';

// ── How a watching tile shows its player (Twitch, YouTube) ──────────────────
// Both watching widgets offer the same three ways to look at what is playing,
// plus full screen, and the rules for them are identical, so they live here once:
//
//   normal  the tile as built: player, the list to pick from, the chat if on
//   cinema  player and ONE side panel (Twitch: the chat, YouTube: the list)
//   fill    the player covers the whole tile, controls float over it
//   screen  the same tile covering the whole screen, with or without the side
//           panel. Never the Fullscreen API: on the kiosk leaving it hands the
//           window back under the Windows taskbar (see the widgets' CSS).
//
// Nothing in here moves the player's iframe in the DOM — moving it reloads it,
// which drops the stream. Every view is a CSS arrangement of the same nodes,
// switched by `data-view` / `.is-screen` on the widget's wrap.
//
// The view and the side-panel choice are remembered per surface in
// localStorage: the Edge and a phone want different views of the same tile, and
// this is a viewing convenience, not a setting to sync. Full screen itself is
// never remembered — a reload must not open over the dashboard.
//
// UMD like sdk-perf.js so effectiveView is unit-testable under Node
// (test/watch-view.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.WatchView = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const VIEWS = ['normal', 'cinema', 'fill'];
  const IDLE_MS = 3500;

  // What the tile actually shows, from what the user asked for and what is true
  // right now. Nothing playing, or the layout editor open, is always `normal`:
  // without the list there is no way to pick something, and the editor has to
  // see the real cards it is arranging. `overlay` = the controls float over the
  // picture and fade (fill, and every full-screen arrangement).
  function effectiveView(input) {
    const s = input || {};
    const side = s.side !== false;
    if (!s.playing || s.editing) return { view: 'normal', screen: false, side, overlay: false };
    if (s.screen) return { view: side ? 'cinema' : 'fill', screen: true, side, overlay: true };
    const view = VIEWS.includes(s.view) ? s.view : 'normal';
    return { view, screen: false, side, overlay: view === 'fill' };
  }

  // Full screen keeps the arrangement the tile was in: from cinema it opens with
  // the side panel, from fill without, and from normal with whatever the user
  // last chose at full screen.
  function sideOnEnter(view, remembered) {
    if (view === 'cinema') return true;
    if (view === 'fill') return false;
    return remembered !== false;
  }

  function readPrefs(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null');
      if (!raw || typeof raw !== 'object') return { view: 'normal', side: true };
      return { view: VIEWS.includes(raw.view) ? raw.view : 'normal', side: raw.side !== false };
    } catch { return { view: 'normal', side: true }; }
  }
  function writePrefs(key, prefs) {
    try { localStorage.setItem(key, JSON.stringify({ view: prefs.view, side: prefs.side })); }
    catch { /* private window, blocked storage: the view simply is not remembered */ }
  }

  // opts:
  //   prefix        class prefix: 'tww' or 'yt'
  //   storageKey    localStorage key for the remembered view
  //   tiles()       the widget's tiles on dashboard pages
  //   ownerWrap()   the wrap whose stage holds the live player, or null
  //   canIdle()     whether the floating controls may fade right now
  //   onChange()    repaint after a change the user made
  function createController(opts) {
    const o = opts || {};
    const P = String(o.prefix || 'w');
    const prefs = readPrefs(o.storageKey);
    let screen = false;
    let side = prefs.side;
    let idle = false;
    let idleT = null;
    let current = effectiveView({});

    const editing = () => document.body.classList.contains('layout-editing');
    const owner = () => { try { return o.ownerWrap() || null; } catch { return null; } };

    function compute() {
      return effectiveView({ view: prefs.view, screen, side, playing: !!owner(), editing: editing() });
    }

    // Writes the arrangement onto the DOM. Only the wrap that owns the player is
    // ever arranged: a second copy of the tile has no picture, and a cinema view
    // of an empty stage is a black box beside a chat for nobody.
    function apply() {
      // Full screen is a moment, not a mode the tile returns to on its own: the
      // editor opening or the picture going away ends it for good.
      if (screen && (editing() || !owner())) screen = false;
      current = compute();
      const own = owner();
      document.body.classList.toggle(P + '-expanded', current.screen);
      o.tiles().forEach(tile => {
        const wrap = tile.querySelector('.' + P + '-wrap');
        const mine = !!wrap && wrap === own;
        tile.classList.toggle(P + '-tile-expanded', mine && current.screen);
        if (!wrap) return;
        const v = mine ? current : effectiveView({});
        wrap.dataset.view = v.view;
        wrap.classList.toggle('is-screen', v.screen);
        wrap.classList.toggle('is-overlay', v.overlay);
        wrap.classList.toggle('is-idle', mine && v.overlay && idle);
      });
      if (!current.overlay) clearIdle();
      return current;
    }

    function changed() {
      apply();
      if (current.overlay) wake();
      if (typeof o.onChange === 'function') o.onChange();
    }

    // Tapping the active view's button again goes back to the normal tile.
    function toggleView(view) {
      if (!VIEWS.includes(view)) return;
      prefs.view = prefs.view === view ? 'normal' : view;
      writePrefs(o.storageKey, prefs);
      changed();
    }
    function setScreen(on) {
      const want = !!on && !!owner() && !editing();
      if (want === screen) return;
      if (want) side = sideOnEnter(prefs.view, prefs.side);
      screen = want;
      changed();
    }
    function toggleSide() {
      side = !side;
      prefs.side = side;
      writePrefs(o.storageKey, prefs);
      changed();
    }

    // ── Floating controls fade out, and come back on a touch ────────────────
    function setIdleClass(on) {
      idle = on;
      document.querySelectorAll('.' + P + '-wrap.is-overlay').forEach(w => w.classList.toggle('is-idle', on));
    }
    function clearIdle() {
      clearTimeout(idleT); idleT = null;
      if (idle) setIdleClass(false);
    }
    function armIdle() {
      clearTimeout(idleT); idleT = null;
      if (!current.overlay || !(typeof o.canIdle === 'function' ? o.canIdle() : true)) return;
      idleT = setTimeout(() => { idleT = null; setIdleClass(true); }, IDLE_MS);
    }
    function wake() {
      if (idle) setIdleClass(false);
      armIdle();
    }

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && screen) setScreen(false); });
    // Swiping to another page leaves the screen to that page, the same as an
    // expanded SDK widget does.
    window.addEventListener('xenon:page-change', () => { if (screen) setScreen(false); });

    return {
      apply,
      toggleView,
      setScreen,
      toggleSide,
      wake,
      armIdle,
      clearIdle,
      state: () => current,
      wanted: () => prefs.view,
      isScreen: () => screen,
    };
  }

  return { VIEWS, IDLE_MS, effectiveView, sideOnEnter, createController };
});
