// Where the Spotify tiles are: every tile, the ones on screen, a repaint of each, and how often a
// visible tile asks the hub.
'use strict';

(() => {
  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it does no polling.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="spotify"]')).filter(el => el.closest('.pager-page, .layer-slot')); }

  // Tiles the user is actually looking at. The pager keeps off-screen pages
  // mounted, so a tile parked on page 2 still passes document.hidden and would
  // otherwise keep burning Spotify API quota invisibly — gate polling on this.
  // getClientRects() additionally catches a widget parked in a tab GROUP whose tab
  // isn't selected (display:none ancestor): it sits on the current page yet is
  // invisible, and polling Spotify for it all session long is what tripped the
  // rate limit that froze the player state (same class of bug as the v4.5.1
  // Cameras/Second-screen tab-visibility fix). NOT offsetParent: that reads null
  // for a genuinely-visible tile too (any position:fixed or display:contents
  // ancestor), which would wrongly freeze its polling and seek bar. An empty
  // getClientRects() means no layout box — i.e. a display:none somewhere above —
  // without those false negatives (same test jQuery's :visible uses).
  function visibleTiles() { return tiles().filter(el => onVisiblePage(el) && el.getClientRects().length > 0); }

  // Repaint one region of every BUILT mount (unbuilt tiles are skipped — the
  // skeleton hasn't run yet). Every repaint loop in this file goes through here.
  function repaintAll(fn) { tiles().forEach(tile => { const m = tile.querySelector('.spotify-widget-mount'); if (m && m.dataset.spBuilt === '1') fn(m); }); }

  const POLL_MS = 6000;      // network refresh cadence while a tile is visible

  window.SpotifyWidgetTiles = { tiles, visibleTiles, repaintAll, POLL_MS };
})();
