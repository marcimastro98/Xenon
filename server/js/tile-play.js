// What Bit asked to play in a tile (server/tile-play.js, SSE `tile_play`): a
// Twitch channel, a YouTube video or a web page. Every window of this PC with
// that tile asks to take it, the server lets the first one through, and that
// window shows the tile (its page, its tab) and plays it with the same entry
// the widget SDK uses. A window where the tile is in sight asks at once, one
// where it is on another page or tab a moment later, so the tile the user is
// looking at wins. Phones are refused by the server.
(function () {
  'use strict';

  const LATER_MS = 400;
  const WIDGET_OF = { twitch: 'twitchwatch', youtube: 'youtube', browser: 'browser' };

  function tileElements(widget) {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="' + widget + '"]'))
      .filter((n) => n.closest('.pager-page, .layer-slot'));
  }

  function inSight(node) {
    if (!node.getClientRects().length) return false;
    const pager = window.DashboardPager;
    if (!node.closest('.pager-page') || !pager || typeof pager.isOnCurrentPage !== 'function') return true;
    return pager.isOnCurrentPage(node);
  }

  // Its page first, then its tab when it sits in a tab group.
  function bringIntoView(node, widget) {
    const pager = window.DashboardPager;
    if (pager && typeof pager.goToPageOf === 'function') pager.goToPageOf(node);
    const TG = window.DashboardTabGroups;
    if (!TG || typeof getDashboardLayout !== 'function') return;
    const id = node.dataset.dashboardWidget || widget;
    try {
      const layout = getDashboardLayout();
      const gid = TG.widgetGroupOf(layout.groups || {}, id);
      if (gid) TG.setGroupActive(gid, id, false);
    } catch (e) { /* no layout yet: the tile stays where it is */ }
  }

  function play(tile, value) {
    if (tile === 'twitch' && window.TwitchWatchWidget) return window.TwitchWatchWidget.playFromSdk(value);
    if (tile === 'youtube' && window.YouTubeWidget) return window.YouTubeWidget.playFromSdk(value);
    // openFromSdk re-checks the address and brings a hidden Browser tile into view.
    if (tile === 'browser' && window.BrowserTile) return window.BrowserTile.openFromSdk(value);
    return { ok: false, error: 'unavailable' };
  }

  function claim(nonce) {
    const base = typeof SERVER !== 'undefined' ? SERVER : '';
    return fetch(base + '/tiles/play-claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }),
    }).then((r) => (r.ok ? r.json() : null)).then((r) => !!(r && r.ok)).catch(() => false);
  }

  function onOffer(e) {
    let data;
    try { data = JSON.parse(e.data); } catch (err) { return; }
    const widget = data && WIDGET_OF[data.tile];
    if (!widget || typeof data.value !== 'string') return;
    const nodes = tileElements(widget);
    if (!nodes.length) return;
    const seen = nodes.find(inSight);
    setTimeout(() => {
      claim(data.nonce).then((won) => {
        if (!won) return;
        if (!seen && data.tile !== 'browser') bringIntoView(nodes[0], widget);
        play(data.tile, data.value);
      });
    }, seen ? 0 : LATER_MS);
  }

  function listen(es) { es.addEventListener('tile_play', onOffer); }

  window.TilePlay = { listen };
})();
