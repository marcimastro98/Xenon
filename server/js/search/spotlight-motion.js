'use strict';

// How the native search window (spotlight.html?frameless=1) comes and goes.
// The window cannot fade or scale itself: it is opaque on purpose
// (spotlight_window.rs), and Windows shows it at once. What it shows first is
// the last picture the page drew, so a window hidden with a search in it came
// back with that search for a few frames, then jumped as the page reset it
// (the "lag" a user saw on Alt+Space). So the page keeps its contents hidden
// while the window is away, does every reset unseen, and only then lets them
// settle in, in one short movement. The panel colour is the window's own, so
// the bare panel is all that ever shows before that.
//
// There is no way out to animate: the shell hides the window at once, and the
// bar is already gone by then (Spotlight.close). Classes on <html>: spot-away
// (hidden) and spot-enter (settling in). The CSS is
// components/Spotlight/SpotlightWindow.css.

(function () {
  const ENTER_MS = 380;

  // Loaded in the head: the very first picture of a new window is the bare
  // panel too, never the bar half styled (Windows can show that picture again
  // on a later open).
  if (/[?&]frameless=1/.test(location.search)) {
    document.documentElement.classList.add('spotlight-frameless-host', 'spot-away');
  }

  function create(doc, opts) {
    const el = doc.documentElement;
    const raf = (opts && opts.raf) || ((fn) => window.requestAnimationFrame(fn));
    const timers = (opts && opts.timers) || { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
    let turn = 0;
    let timer = null;

    function stop() {
      turn++;
      if (timer !== null) timers.clear(timer);
      timer = null;
    }

    // Hidden at once: the window is going, or about to be shown.
    function away() {
      stop();
      el.classList.remove('spot-enter');
      el.classList.add('spot-away');
    }

    // Two frames: the first after the window shows draws the bare panel, the
    // second starts the movement, so none of it is spent behind a hidden window.
    function enter() {
      stop();
      const mine = turn;
      raf(() => raf(() => {
        if (mine !== turn) return;
        el.classList.remove('spot-away');
        el.classList.add('spot-enter');
        timer = timers.set(() => {
          timer = null;
          el.classList.remove('spot-enter');
        }, ENTER_MS);
      }));
    }

    // Once ready settles (the window has its size), never later than maxMs;
    // nothing if the window went away meanwhile.
    function enterAfter(ready, maxMs) {
      stop();
      const mine = turn;
      const go = () => { if (mine === turn) enter(); };
      timer = timers.set(go, maxMs);
      Promise.resolve(ready).then(go, go);
    }

    function isAway() {
      return el.classList.contains('spot-away');
    }

    return { away, enter, enterAfter, isAway };
  }

  window.SpotlightMotion = { create, ENTER_MS };
})();
