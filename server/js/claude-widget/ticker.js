// The countdown texts of the Claude tile, changed once a second without repainting the tile.
'use strict';

(() => {
  const { dur, until } = window.ClaudeWidgetWords;
  const { mmss } = window.ClaudeWidgetModelWords;
  const { widgetState, aged, stopTicker } = window.ClaudeWidgetKnown;

  // Only the countdown texts change every second. Repainting the whole tile for
  // that would throw away scroll position and fight the user's taps, so the tick
  // mutates just those nodes — and stops entirely when nothing counts down.
  function tick() {
    const nodes = document.querySelectorAll('[data-reset-at], [data-expires-at], [data-age-base]');
    nodes.forEach(n => {
      if (n.dataset.resetAt) n.textContent = until(Number(n.dataset.resetAt));
      else if (n.dataset.expiresAt) n.textContent = (n.dataset.tpl || '{t}').replace('{t}', mmss(Number(n.dataset.expiresAt) - Date.now()));
      else n.textContent = (n.dataset.agePrefix || '') + dur(aged(Number(n.dataset.ageBase)));
    });
    if (!nodes.length) stopTicker();
  }

  function startTicker() {
    if (widgetState.ticker) return;
    widgetState.ticker = setInterval(tick, 1000);
  }

  window.ClaudeWidgetTicker = { startTicker };
})();
