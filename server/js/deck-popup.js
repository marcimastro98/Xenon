'use strict';
// Virtual Deck popup bootstrap — a "main.js-lite" for deck-popup.html.
//
// Runs BEFORE deck.js's DOMContentLoaded boot (scripts are synchronous), so it
// can stamp the ?instance= id onto the tile first; then it opens its own SSE
// stream and feeds exactly the events the deck snapshot consumes. View+press
// only: no editor, no layout shell, no settings — key presses go through the
// same POST /actions/run as the dashboard.
(function () {
  // ── Which deck instance to mirror (default: the primary tile) ──
  const params = new URLSearchParams(location.search);
  const instance = (params.get('instance') || '').trim();
  const tile = document.querySelector('[data-dashboard-widget="deck"]');
  if (tile && instance && /^deck(~[a-z0-9]+)?$/.test(instance) && instance !== 'deck') {
    tile.setAttribute('data-dashboard-instance', instance);
  }

  // ── SSE relay → Deck.refreshStates (js/deck-feed.js) ──
  function connect() {
    const es = new EventSource('/sse');
    window.DeckFeed.attach(es);
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
    };
  }
  connect();
})();
