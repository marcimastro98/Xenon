'use strict';

// Which Settings categories someone with no dashboard sees when Settings opens in
// the Xenon menu's window (js/sheet-page.js). Pure, so it can be tested alone.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SheetUsage = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // What only the dashboard has.
  const DASHBOARD_ONLY = Object.freeze(['island', 'background', 'display', 'secondscreen']);
  // A tile's own settings: they matter once that tile is on the screen.
  const WITH_TILE = Object.freeze({
    weather: ['weather'],
    stocks: ['stocks', 'football', 'news'],
    slideshow: ['slideshow'],
    claude: ['claude', 'openaicodex', 'chatgpt'],
    unifi: ['unifi'],
    browser: ['browser'],
    streaming: ['twitch', 'twitchwatch', 'youtube', 'youtubelive', 'discord', 'obs', 'streamerbot'],
  });

  function placedTiles(settings) {
    const widgets = settings && settings.layers && settings.layers.widgets;
    if (!Array.isArray(widgets)) return new Set();
    return new Set(widgets.filter((w) => w && w.kind === 'tile').map((w) => w.widget));
  }

  function hiddenCategories(settings) {
    if (!settings || settings.usageMode !== 'widgets') return [];
    const placed = placedTiles(settings);
    const unused = Object.keys(WITH_TILE).filter((cat) => !WITH_TILE[cat].some((tile) => placed.has(tile)));
    return [...DASHBOARD_ONLY, ...unused];
  }

  // Which rows of the list go, in order: a group's label goes with its last row.
  function navState(rows, hidden) {
    const off = rows.map((r) => !!r.cat && hidden.includes(r.cat));
    rows.forEach((r, i) => {
      if (!r.label) return;
      let next = i + 1;
      while (next < rows.length && !rows[next].label && off[next]) next += 1;
      off[i] = next >= rows.length || !!rows[next].label;
    });
    return off;
  }

  // Settings leaves the open page only when this list hides it. A row hidden
  // for another reason is not one: Capture shows only after the server says the
  // engine runs, and the menu's "All capture options" opened before that answer
  // (it landed on General).
  function leavesActive(rows, off) {
    const i = rows.findIndex((r) => r.active);
    return i >= 0 && !!off[i];
  }

  return Object.freeze({ hiddenCategories, navState, leavesActive });
});
