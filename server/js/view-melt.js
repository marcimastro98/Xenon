'use strict';
// One slow melt of the whole page, for the moments where the new look is the point: the first
// question into the dashboard, What's New into the person's own screen and back. It lasts longer
// than a page change on purpose (the rules on this class are in styles/global.css). Where nothing
// should move, or the page cannot do it, the change simply happens.
(function () {
  const MELTING = 'xenon-melting';

  const calm = () => document.body.classList.contains('low-power-gpu')
    || document.body.classList.contains('perf-mode')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.XenonMelt = function melt(change) {
    if (typeof document.startViewTransition !== 'function' || calm()) {
      change();
      return Promise.resolve();
    }
    const root = document.documentElement;
    root.classList.add(MELTING);
    return document.startViewTransition(change).finished
      .catch((e) => console.warn('[melt] the fade did not run', e))
      .finally(() => root.classList.remove(MELTING));
  };
})();
