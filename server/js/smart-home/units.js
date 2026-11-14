// How the devices of a home are read: which kinds switch or run, what a device can do, the state a
// tile shows, and the devices of one thing gathered under its main one.
'use strict';

(() => {
  // Which domains render as a one-tap toggle vs a run-button vs a read-only value.
  // SHEET_DOMAINS additionally open a per-device control panel (the detail sheet)
  // exposing exactly the controls that device supports.
  const TOGGLE_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean', 'automation', 'siren', 'lock']);
  const RUN_DOMAINS = new Set(['scene', 'script', 'button']);
  const ICON_FOR = { light: 'light', switch: 'switch', fan: 'fan', climate: 'climate', lock: 'lock', cover: 'cover', media_player: 'media', scene: 'scene', script: 'script', button: 'press', input_boolean: 'plug', automation: 'plug', humidifier: 'plug', siren: 'plug', vacuum: 'vacuum', water_heater: 'waterheater', alarm_control_panel: 'alarm', valve: 'valve', lawn_mower: 'mower', number: 'slider', input_number: 'slider', select: 'list', input_select: 'list' };

  // Home Assistant supported_features bitmasks — only the bits we surface.
  const FEAT = {
    mp: { pause: 1, seek: 2, volSet: 4, volMute: 8, prev: 16, next: 32, on: 128, off: 256, playMedia: 512, volStep: 1024, source: 2048, stop: 4096, play: 16384, shuffle: 32768, sound: 65536, repeat: 262144 },
    cover: { open: 1, close: 2, setPos: 4, stop: 8, openTilt: 16, closeTilt: 32, stopTilt: 64, setTilt: 128 },
    fan: { speed: 1, oscillate: 2, direction: 4, preset: 8 },
    vacuum: { pause: 4, stop: 8, return: 16, fanSpeed: 32, locate: 512, cleanSpot: 1024, start: 8192 },
    valve: { open: 1, close: 2, setPos: 4, stop: 8 },
    alarm: { armHome: 1, armAway: 2, armNight: 4, trigger: 8, armCustom: 16, armVacation: 32 },
    mower: { start: 1, pause: 2, dock: 4 },
  };
  const has = (feat, bit) => ((Number(feat) || 0) & bit) !== 0;

  // The server's snapshot (SSE or the seed GET) → the tile's state, validated here.
  function stateFrom(d) {
    const order = window.SmartHomeOrder;
    return {
      configured: !!d.configured,
      connected: !!d.connected,
      entities: Array.isArray(d.entities) ? d.entities : [],
      areaOrder: order.normalizeAreaOrder(d.areaOrder),
      tileView: order.normalizeTileView(d.tileView),
    };
  }

  // Order a device's entities so the primary controls come first and helpers last.
  const DOMAIN_ORDER = ['media_player', 'climate', 'water_heater', 'light', 'fan', 'cover', 'valve', 'vacuum', 'lawn_mower', 'humidifier', 'alarm_control_panel', 'switch', 'input_boolean', 'lock', 'remote', 'number', 'input_number', 'select', 'input_select', 'scene', 'script', 'button', 'binary_sensor', 'sensor'];

  function domainRank(dom) { const i = DOMAIN_ORDER.indexOf(dom); return i < 0 ? DOMAIN_ORDER.length : i; }

  // The "face" entity of a device (its icon + summary on the merged card).
  function primaryEntity(ents) { return ents.slice().sort((a, b) => domainRank(a.domain) - domainRank(b.domain))[0]; }

  // Strip the device name off an entity's friendly name ("BRAVIA … Riavvia" → "Riavvia").
  function entityShortName(e, deviceName) {
    let n = e.name || e.id;
    if (deviceName && n.toLowerCase().startsWith(String(deviceName).toLowerCase())) {
      const rest = n.slice(deviceName.length).replace(/^[\s\-:·|]+/, '').trim();
      if (rest) n = rest;
    }
    return n;
  }

  // Split an area's entities into render units: standalone entities stay single;
  // entities sharing a physical device merge into one device unit (order preserved).
  function groupUnits(items) {
    const byDev = new Map();
    const order = [];
    items.forEach((e) => {
      if (e.device) {
        if (!byDev.has(e.device)) { byDev.set(e.device, []); order.push({ dev: e.device }); }
        byDev.get(e.device).push(e);
      } else { order.push({ entity: e }); }
    });
    const units = [];
    order.forEach((o) => {
      if (o.entity) { units.push({ type: 'single', entity: o.entity }); return; }
      const ents = byDev.get(o.dev);
      if (!ents) return;                       // device already emitted
      byDev.delete(o.dev);
      if (ents.length === 1) units.push({ type: 'single', entity: ents[0] });
      else units.push({ type: 'device', id: o.dev, name: ents[0].deviceName || primaryEntity(ents).name, entities: ents });
    });
    return units;
  }

  window.SmartHomeUnits = {
    TOGGLE_DOMAINS, RUN_DOMAINS, ICON_FOR, FEAT, has, stateFrom, domainRank, primaryEntity,
    entityShortName, groupUnits,
  };
})();
