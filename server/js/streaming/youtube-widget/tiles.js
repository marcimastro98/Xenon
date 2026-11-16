// Where the YouTube tiles are, and how often a tile on a page asks the server.
'use strict';

(() => {
  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it must NOT
  // poll the YouTube API. Adding the widget moves it into a page → polling starts
  // on the next layout pass; removing it parks it back → polling stops.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="youtube"]')).filter(el => el.closest('.pager-page, .layer-slot')); }

  const POLL_MS = 30000;    // slow on purpose (YouTube Data API quota)

  window.YoutubeWidgetTiles = { tiles, POLL_MS };
})();
