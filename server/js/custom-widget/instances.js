// Which tile an instance of a widget is: the ids of the frames that are not tiles, the key an
// instance is assigned under, and the id read off a tile.
'use strict';

(() => {
  // instanceId → { frame, pkgId, ready, lastAction, lastFetch, lastState, ambient? }.
  // Ambient entries are fullscreen scene frames registered by AmbientMode under
  // a reserved id — they are not tiles, so every tile-driven cleanup below must
  // skip them (AmbientMode owns their lifecycle).
  const AMBIENT_INST_ID = '__ambient-scene__';

  // The Weather window's host: its own frame, the Weather tile's assignment.
  const WEATHER_VIEW_ID = 'weather@view';

  // The sdkWidgets.assign key an instance reads and writes.
  function assignKeyOf(instId) {
    return instId === WEATHER_VIEW_ID ? 'weather' : instId;
  }

  // The tile kind an instance belongs to: 'custom', or 'weather' for a Weather host.
  function hostKindOf(instId) {
    return String(assignKeyOf(instId) || '').split('~')[0];
  }

  // Identity comes from the ATOM (data-dashboard-instance, set on every
  // duplicated copy; the primary has none → base id), NEVER from the enclosing
  // .grid-stack-item's gs-id: inside a tab group that item is the GROUP's
  // (gs-id "g-…"), so every member would collapse onto one shared key — the
  // assignment "vanished" into an unreachable key when a tile joined a group,
  // two custom tabs fought over one slot, and unassigning one killed both.
  // Standalone tiles are unaffected: a primary's gs-id IS the base id and a
  // copy's gs-id IS its data-dashboard-instance, so stored keys keep working.
  function instanceIdOf(tile) {
    return tile.getAttribute('data-cw-host') || tile.getAttribute('data-dashboard-instance') || tile.getAttribute('data-dashboard-widget') || 'custom';
  }

  window.CustomWidgetInstances = {
    AMBIENT_INST_ID, WEATHER_VIEW_ID, assignKeyOf, hostKindOf, instanceIdOf,
  };
})();
