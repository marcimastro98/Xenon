// Where a widget stands: the tiles that hold one, the box it opens into, and the page and shape a
// new one is placed on.
'use strict';

(() => {
  const { WEATHER_VIEW_ID } = window.CustomWidgetInstances;

  // Tiles on a dashboard page, plus those a layer surface has moved into its slots.
  // A layer window shows its slots only: the dashboard pages it also boots stay
  // hidden, and mounting their widgets cost memory and ran their Deck states twice.
  function tiles() {
    const layerOnly = (window.LayerHost && window.LayerHost.active) || (typeof isSheetPage === 'function' && isSheetPage());
    const scope = layerOnly ? '.layer-slot' : '.pager-page, .layer-slot';
    // A Weather tile set to Style "Your widget" holds a .custom-widget-mount of its
    // own (js/weather/weather-look.js) and hosts a package like a custom tile does.
    const onPages = Array.from(document.querySelectorAll('[data-dashboard-widget="custom"], [data-dashboard-widget="weather"]'))
      .filter(n => n.closest(scope) && (n.getAttribute('data-dashboard-widget') === 'custom' || n.querySelector('.custom-widget-mount')));
    // The Weather window on the same style shows that widget too, in a host of its
    // own outside the grid (never a [data-dashboard-widget] the layout would claim).
    return onPages.concat(Array.from(document.querySelectorAll(`[data-cw-host="${WEATHER_VIEW_ID}"]`))
      .filter(n => n.querySelector('.custom-widget-mount')));
  }

  function expandWrapOf(entry) {
    const f = entry && entry.frame;
    return (f && typeof f.closest === 'function') ? f.closest('.cw-wrap') : null;
  }

  // A widget the assistant just made goes on the page the person is looking
  // at, in the shape it was drawn for. A new version of one already on a tile
  // only refreshes that tile.
  function currentPageId() {
    const pager = window.DashboardPager;
    return (pager && pager.getCurrentPage && pager.getCurrentPage()) || undefined;
  }

  // The shape the package was drawn for on `page`, when it names one.
  function spanOnPage(pkg, page) {
    const DG = window.DashboardGrid;
    return pkg && pkg.size && DG && typeof DG.sizeForHint === 'function' ? DG.sizeForHint(pkg.size, page) : null;
  }

  window.CustomWidgetPlaces = { tiles, expandWrapOf, currentPageId, spanOnPage };
})();
