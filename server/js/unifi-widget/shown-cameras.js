// Which cameras the camera tile shows and in what order: the ones chosen on the UniFi console and
// in Home Assistant, as one list.
'use strict';

(() => {
  const { readHubSettings, layoutOf, orderCameras } = window.UnifiWidgetCameraLayout;

  // The user's selected UniFi camera ids (empty = show every camera the console
  // reports). HA cameras are opt-in instead — see selectedHaIds.
  function selectedUnifiIds() {
    try {
      const u = readHubSettings().unifi;
      if (u && Array.isArray(u.cameras)) return u.cameras.slice();
    } catch (e) { /* default */ }
    return [];
  }

  // The user's selected Home Assistant camera entity ids, in display order. OPT-IN:
  // empty = show NO HA cameras (connecting HA for control never dumps every camera
  // onto the tile). The array is both the selection and the order.
  function selectedHaIds() {
    try {
      const ha = readHubSettings().homeAssistant;
      if (ha && Array.isArray(ha.cameras)) return ha.cameras.slice();
    } catch (e) { /* default */ }
    return [];
  }

  // STRUCTURAL signature — only what forces a full grid REBUILD: config state, the
  // error empty-state, the selection, and the SET of cameras by id. A camera's
  // connected flag or name is deliberately NOT here: those change often (a wireless
  // camera flapping online/offline) and are applied in place (updateStatuses) so a
  // single status change never rebuilds — and re-fades — the whole grid.
  function stateSig(tile) {
    const s = tile.state || {};
    const uni = s.unifi || {}, ha = s.ha || {};
    const uids = Array.isArray(uni.cameras) ? uni.cameras.map((c) => c.id).join(',') : '';
    const hids = Array.isArray(ha.cameras) ? ha.cameras.map((c) => c.id).join(',') : '';
    return [!!uni.configured, uni.error ? 'e' : '', !!ha.configured, ha.error ? 'e' : '',
      selectedUnifiIds().join(','), selectedHaIds().join(','), uids, hids].join('|');
  }

  // Merge the configured sources into ONE display list — UniFi first (ordered by the
  // saved order, filtered by the UniFi selection; empty = all), then the user's
  // chosen HA cameras (opt-in, in their saved order). Each camera is tagged with its
  // source so snapshot URL + angle storage resolve correctly downstream.
  function mergedCameras(tile) {
    const s = tile.state || {};
    const out = [];
    const uni = s.unifi || {};
    if (uni.configured && Array.isArray(uni.cameras)) {
      const sel = selectedUnifiIds();
      const list = sel.length ? uni.cameras.filter((c) => sel.includes(c.id)) : uni.cameras;
      orderCameras(list, layoutOf().order).forEach((c) => out.push({ id: c.id, name: c.name, connected: c.connected, source: 'unifi' }));
    }
    const ha = s.ha || {};
    if (ha.configured && Array.isArray(ha.cameras)) {
      const byId = new Map(ha.cameras.map((c) => [c.id, c]));
      selectedHaIds().forEach((id) => { const c = byId.get(id); if (c) out.push({ id: c.id, name: c.name, connected: c.connected, source: 'ha' }); });
    }
    return out;
  }

  window.UnifiWidgetShownCameras = { selectedHaIds, stateSig, mergedCameras };
})();
