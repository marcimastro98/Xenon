'use strict';
// Smart Home (Home Assistant) — dashboard tile + Settings page in one module.
//
// TILE: a live, glanceable board of the user's chosen Home Assistant entities,
// grouped by room (area): lights/switches as one-tap toggles, scenes/scripts as
// run buttons, media players with a play/pause, and sensors/climate as read-only
// value cards. EVENT-DRIVEN — the server keeps ONE Home Assistant WebSocket open
// while the tile is on screen and pushes state over SSE (event: 'homeassistant')
// → onSSE(); the tile idles at near-zero cost when nothing in the home changes.
// Renders into every .smarthome-widget-mount (multi-instance safe).
//
// SETTINGS: Settings → Smart Home renders a connect card (address + long-lived
// token, tested against HA) and a searchable, room-grouped device picker that
// chooses which entities the tile shows. The token stays server-side (write-only
// field); this module only ever handles the URL, the selection, and booleans.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js

  const SVG = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    light: SVG('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.2 1 2.5h6c0-1.3.3-1.8 1-2.5A6 6 0 0 0 12 3Z"/>'),
    switch: SVG('<rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="8" cy="12" r="2.4" fill="currentColor"/>'),
    fan: SVG('<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-6 3-6s2 3-1 5M14 12c4 0 6 1 6 3s-3 2-5-1M12 14c0 4-1 6-3 6s-2-3 1-5M10 12c-4 0-6-1-6-3s3-2 5 1"/>'),
    climate: SVG('<path d="M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0Z"/><path d="M12 13V8"/>'),
    sensor: SVG('<path d="M4 14a8 8 0 0 1 16 0"/><path d="M12 14l3-3"/><circle cx="12" cy="14" r="1" fill="currentColor"/>'),
    lock: SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    cover: SVG('<rect x="4" y="3" width="16" height="6" rx="1"/><path d="M5 9v11M19 9v11M9 9v8M15 9v8"/>'),
    media: SVG('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M10 8l5 3-5 3zM7 21h10"/>'),
    scene: SVG('<path d="m12 3 2.2 5.6L20 9.3l-4.3 3.7L17 19l-5-3-5 3 1.3-6L4 9.3l5.8-.7z"/>'),
    script: SVG('<path d="M8 5v14l11-7z"/>'),
    plug: SVG('<path d="M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-10 0zM12 17v4"/>'),
    press: SVG('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
    vacuum: SVG('<circle cx="12" cy="13" r="7"/><circle cx="12" cy="13" r="2.4"/><path d="M12 4v2"/>'),
    slider: SVG('<path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2.4" fill="currentColor"/><circle cx="15" cy="16" r="2.4" fill="currentColor"/>'),
    list: SVG('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>'),
    alarm: SVG('<path d="M12 3l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V6z"/><path d="M9 12l2 2 4-4"/>'),
    valve: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>'),
    waterheater: SVG('<rect x="6" y="3" width="12" height="18" rx="3"/><path d="M12 8s2 2 2 3.5a2 2 0 0 1-4 0C10 10 12 8 12 8Z"/>'),
    mower: SVG('<circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M5 18H4l1-6h7l3 4h4v2h-2"/>'),
    home: SVG('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
    settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.9 7.9 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1L15 3H9l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.9 7.9 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1L9 21h6l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4z"/>'),
  };

  // Which domains render as a one-tap toggle vs a run-button vs a read-only value.
  // SHEET_DOMAINS additionally open a per-device control panel (the detail sheet)
  // exposing exactly the controls that device supports.
  const TOGGLE_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean', 'automation', 'siren', 'lock']);
  const RUN_DOMAINS = new Set(['scene', 'script', 'button']);
  const SHEET_DOMAINS = new Set(['media_player', 'light', 'fan', 'cover', 'climate', 'vacuum', 'humidifier', 'water_heater', 'alarm_control_panel', 'valve', 'lawn_mower', 'number', 'input_number', 'select', 'input_select']);
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
  // Underscored HA enum → "Nice case" fallback when we have no explicit translation.
  function prettify(s) { const v = String(s == null ? '' : s).replace(/_/g, ' ').trim(); return v ? v.charAt(0).toUpperCase() + v.slice(1) : v; }
  function fmtNum(v) { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : String(v); }

  // Latest Home Assistant state (global — one home, shared by every tile instance).
  let state = { configured: false, connected: false, entities: [] };
  let seeded = false;

  // ── Shared helpers ──────────────────────────────────────────────────────────
  function iconFor(e) { return ICONS[ICON_FOR[e.domain] || 'sensor'] || ICONS.sensor; }

  // Is a toggleable entity currently "on"? open/unlocked/playing count as on.
  function isOn(e) {
    if (e.domain === 'lock') return e.state === 'unlocked';
    if (e.domain === 'cover') return e.state === 'open';
    return e.state === 'on' || e.state === 'playing' || e.state === 'home';
  }

  // Split a read-only card's reading into a big number + a small unit, for
  // instrument-style typography. Climate → current temperature; on/off → a word.
  function splitValue(e) {
    if (e.domain === 'climate' && Number.isFinite(e.current)) return { num: String(Math.round(e.current)), unit: '°' };
    if (e.state === 'on') return { num: t('smarthome_on', 'On'), unit: '' };
    if (e.state === 'off') return { num: t('smarthome_off', 'Off'), unit: '' };
    if (e.state == null || e.state === '' || e.state === 'unavailable' || e.state === 'unknown') return { num: '—', unit: '' };
    if (Number.isFinite(Number(e.state))) return { num: String(e.state), unit: e.unit || '' };
    return { num: friendlyState(e), unit: e.unit || '' };
  }

  // Turn a raw textual HA state ("below_horizon", "not_home", "playing") into a
  // friendly, localised word — so a sensor value never reads like a code token.
  const STATE_WORDS = {
    below_horizon: 'smarthome_sun_below', above_horizon: 'smarthome_sun_above',
    home: 'smarthome_home', not_home: 'smarthome_away',
    locked: 'smarthome_locked', unlocked: 'smarthome_unlocked',
    on: 'smarthome_on', off: 'smarthome_off', open: 'smarthome_open', closed: 'smarthome_close_cover',
    idle: 'smarthome_idle', playing: 'smarthome_playing', paused: 'smarthome_paused',
  };
  function friendlyState(e) {
    const key = STATE_WORDS[e.state];
    if (key) { const v = t(key); if (v !== key) return v; }
    return prettify(e.state);
  }
  // Localise a climate HVAC mode (off/heat/cool/auto/dry/fan_only/heat_cool).
  function fmtHvac(m) { const key = 'smarthome_hvac_' + String(m); const v = t(key); return v === key ? prettify(m) : v; }

  // A short, localised "what kind of thing is this" label for an entity's domain
  // (Media player / Remote / Button / Sensor…), so the picker and device panel
  // make each of a device's many entities self-explanatory. input_* fold onto the
  // base type; unknown domains fall back to a humanised domain name.
  const DOMAIN_ALIAS = { input_number: 'number', input_select: 'select', input_boolean: 'switch' };
  function domainLabel(e) {
    const d = DOMAIN_ALIAS[e.domain] || e.domain;
    const key = 'smarthome_dom_' + d;
    const v = t(key);
    return v === key ? prettify(d) : v;
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

  // The signature detail: an ON light emits its OWN colour. If Home Assistant
  // reports the bulb's rgb, the card glows in that hue; otherwise a warm bulb
  // amber. Switches/plugs glow in the dashboard accent. Brightness scales the
  // intensity, so a dimmed lamp glows softly and a bright one blooms.
  function glowRgb(e) {
    if (e.domain === 'light' && Array.isArray(e.rgb) && e.rgb.length === 3) return e.rgb.join(', ');
    if (e.domain === 'light') return '255, 197, 122';
    return 'var(--accent-rgb)';
  }
  function glowAlpha(e) {
    if (e.domain === 'light' && Number.isFinite(e.brightness)) return (0.14 + (e.brightness / 255) * 0.24).toFixed(3);
    return '0.2';
  }
  function applyGlow(node, e) {
    node.style.setProperty('--sh-glow', glowRgb(e));
    node.style.setProperty('--sh-glow-a', glowAlpha(e));
  }

  // Instrument colour-coding for value tiles — by what the sensor measures.
  const TINT = {
    temperature: '250, 150, 90', humidity: '90, 170, 250', power: '250, 200, 90', energy: '250, 200, 90',
    battery: '74, 222, 128', pm25: '74, 222, 128', aqi: '74, 222, 128', illuminance: '250, 210, 120',
    pressure: '160, 150, 240', carbon_dioxide: '120, 200, 160', voc: '120, 200, 160',
  };
  function tintRgb(e) { return TINT[e.deviceClass] || (e.domain === 'climate' ? '250, 150, 90' : 'var(--accent-rgb)'); }

  // A light on with a brightness reading reads "On · 80%"; others just On/Off.
  function stateLabel(e) {
    const on = isOn(e);
    if (e.domain === 'light' && on && Number.isFinite(e.brightness)) return t('smarthome_on', 'On') + ' · ' + Math.round(e.brightness / 255 * 100) + '%';
    return on ? t('smarthome_on', 'On') : t('smarthome_off', 'Off');
  }

  async function callService(domain, service, entityId, data) {
    return api('/api/homeassistant/service', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, service, entityId, data: data || {} }),
    });
  }

  // ── Tile ─────────────────────────────────────────────────────────────────────
  // Only tiles actually placed on a dashboard page count (a hidden/never-added
  // widget sits in the pool outside any .pager-page — mirrors the Discord widget).
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="smarthome"]')).filter((s) => s.closest('.pager-page')); }

  function openSmartHomeSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.hidden && typeof window.toggleSettings === 'function') window.toggleSettings();
    if (typeof window.settingsSetCategory === 'function') window.settingsSetCategory('smarthome');
  }

  // A guided empty state (not configured / offline / nothing picked).
  function emptyCard(msgKey) {
    const card = el('div', 'sh-empty');
    const ico = el('div', 'sh-empty-ico'); ico.innerHTML = ICONS.home;   // static, trusted SVG
    card.append(ico, el('div', 'sh-empty-msg', t(msgKey, '')));
    const btn = el('button', 'sh-empty-btn', t('smarthome_open_settings', 'Open Settings'));
    btn.type = 'button';
    btn.addEventListener('click', openSmartHomeSettings);
    card.appendChild(btn);
    return card;
  }

  // A single toggle row (light/switch/…): icon + name, tap toggles it. Optimistic
  // flip for instant feedback; the SSE push reconciles the real state right after.
  // On sheet-capable devices (light, fan) the switch still toggles, but tapping the
  // rest of the card opens the full control panel instead of a blunt on/off.
  function toggleItem(e) {
    const hasSheet = SHEET_DOMAINS.has(e.domain);
    const on = isOn(e);
    const b = el('button', 'sh-item sh-item--toggle' + (on ? ' is-on' : '') + (hasSheet ? ' has-sheet' : ''));
    b.type = 'button';
    if (on) applyGlow(b, e);                            // lit card emits the bulb's colour
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(e);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    body.append(el('span', 'sh-item-name', e.name), el('span', 'sh-item-sub', stateLabel(e)));
    const sw = el('span', 'sh-switch');
    b.append(ico, body, sw);
    const doToggle = () => {
      const nowOn = !b.classList.contains('is-on');
      b.classList.toggle('is-on', nowOn);              // optimistic
      if (nowOn) applyGlow(b, e); else { b.style.removeProperty('--sh-glow'); b.style.removeProperty('--sh-glow-a'); }
      callService('homeassistant', 'toggle', e.id);
    };
    sw.addEventListener('click', (ev) => { ev.stopPropagation(); doToggle(); });
    b.addEventListener('click', () => { if (hasSheet) openSheet(e.id); else doToggle(); });
    return b;
  }

  // A run button (scene / script / button): tap activates it, with a confirm flash.
  function runItem(e) {
    const b = el('button', 'sh-item sh-item--run');
    b.type = 'button';
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(e);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    body.appendChild(el('span', 'sh-item-name', e.name));
    const go = el('span', 'sh-item-go'); go.innerHTML = SVG(e.domain === 'button' ? '<circle cx="12" cy="12" r="6.5"/>' : '<path d="M9 6l6 6-6 6"/>');
    b.append(ico, body, go);
    b.addEventListener('click', async () => {
      b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
      if (e.domain === 'button') await callService('button', 'press', e.id);
      else await callService(e.domain, 'turn_on', e.id);
    });
    return b;
  }

  // A control card (climate/cover/vacuum/number/select): a glanceable summary of the
  // device's current state + a chevron; tapping it opens the full control panel.
  function controlItem(e) {
    const b = el('button', 'sh-item sh-item--control' + (isOn(e) ? ' is-on' : ''));
    b.type = 'button';
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(e);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    body.append(el('span', 'sh-item-name', e.name), el('span', 'sh-item-sub', controlSummary(e)));
    const go = el('span', 'sh-item-go'); go.innerHTML = SVG('<path d="M9 6l6 6-6 6"/>');
    b.append(ico, body, go);
    b.addEventListener('click', () => openSheet(e.id));
    return b;
  }

  // The one-line summary shown on a control card, tailored per device type.
  function controlSummary(e) {
    if (e.domain === 'climate' || e.domain === 'water_heater') {
      const mode = (e.domain === 'climate' && e.state) ? fmtHvac(e.state) : '';
      const temps = (Number.isFinite(e.current) ? fmtNum(e.current) + '°' : '') + (Number.isFinite(e.target) ? ' → ' + fmtNum(e.target) + '°' : '');
      return [mode, temps].filter(Boolean).join(' · ') || stateLabel(e);
    }
    if (e.domain === 'cover' || e.domain === 'valve') {
      const word = e.state === 'open' ? t('smarthome_open') : e.state === 'closed' ? t('smarthome_close_cover') : prettify(e.state);
      return word + (Number.isFinite(e.position) ? ' · ' + Math.round(e.position) + '%' : '');
    }
    if (e.domain === 'vacuum' || e.domain === 'lawn_mower') return friendlyState(e) + (Number.isFinite(e.battery) ? ' · ' + Math.round(e.battery) + '%' : '');
    if (e.domain === 'alarm_control_panel') return prettify(e.state);
    if (e.domain === 'humidifier') return (isOn(e) ? t('smarthome_on') : t('smarthome_off')) + (Number.isFinite(e.target) ? ' · ' + Math.round(e.target) + '%' : '');
    if (e.domain === 'number' || e.domain === 'input_number') { const v = Number(e.state); return (Number.isFinite(v) ? fmtNum(v) : prettify(e.state)) + (e.unit ? ' ' + e.unit : ''); }
    if (e.domain === 'select' || e.domain === 'input_select') return prettify(e.state);
    return stateLabel(e);
  }

  // A media player card: an album-art chip (gradient placeholder — the real cover
  // is auth-gated behind HA) + what's playing + a play/pause. Tapping the art/body
  // opens the full remote (power, volume, sources…); play/pause stays inline.
  function mediaItem(e) {
    const playing = e.state === 'playing';
    const row = el('div', 'sh-item sh-item--media' + (playing ? ' is-playing' : ''));
    const open = el('button', 'sh-media-open'); open.type = 'button';
    const art = el('span', 'sh-media-art'); art.innerHTML = iconFor(e);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    const title = e.title || e.name;
    const sub = e.title ? (e.artist || e.name)
      : (playing ? e.name : (e.state && !['off', 'unavailable', 'unknown', 'idle', ''].includes(e.state) ? friendlyState(e) : t('smarthome_off', 'Off')));
    body.append(el('span', 'sh-item-name', title), el('span', 'sh-item-sub', sub));
    open.append(art, body);
    open.addEventListener('click', () => openSheet(e.id));
    const play = el('button', 'sh-mini-btn');
    play.type = 'button';
    play.innerHTML = playing
      ? SVG('<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>')
      : SVG('<path d="M8 5v14l11-7z"/>');
    play.addEventListener('click', (ev) => { ev.stopPropagation(); callService('media_player', 'media_play_pause', e.id); });
    row.append(open, play);
    return row;
  }

  // A read-only value tile (sensor / climate / binary_sensor / …): an instrument
  // reading — big tabular number + small unit, tinted by what it measures.
  function valueItem(e) {
    const card = el('div', 'sh-item sh-item--value');
    card.style.setProperty('--sh-tint', tintRgb(e));
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(e);   // static, trusted SVG
    card.appendChild(ico);
    const body = el('div', 'sh-item-body');
    const val = el('span', 'sh-item-val');
    const parts = splitValue(e);
    val.appendChild(document.createTextNode(parts.num));
    if (parts.unit) val.appendChild(el('span', 'sh-item-unit', parts.unit));
    body.append(val, el('span', 'sh-item-name', e.name));
    card.appendChild(body);
    return card;
  }

  function buildItem(e) {
    if (e.domain === 'media_player') return mediaItem(e);
    if (RUN_DOMAINS.has(e.domain)) return runItem(e);
    if (TOGGLE_DOMAINS.has(e.domain)) return toggleItem(e);
    if (SHEET_DOMAINS.has(e.domain)) return controlItem(e);
    return valueItem(e);
  }

  // A merged DEVICE card: several HA entities of one physical device (a TV = a
  // media_player + remote + buttons) collapse into a single card that opens a
  // unified control panel — so the TV appears once, not four times.
  function deviceCard(unit) {
    const pe = primaryEntity(unit.entities);
    const anyOn = unit.entities.some((x) => isOn(x));
    const b = el('button', 'sh-item sh-item--control sh-item--device' + (anyOn ? ' is-on' : ''));
    b.type = 'button';
    if (anyOn && pe.domain === 'light') applyGlow(b, pe);
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(pe);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    body.append(el('span', 'sh-item-name', unit.name), el('span', 'sh-item-sub', deviceSummary(pe)));
    const badge = el('span', 'sh-item-badge', String(unit.entities.length));
    const go = el('span', 'sh-item-go'); go.innerHTML = SVG('<path d="M9 6l6 6-6 6"/>');
    b.append(ico, body, badge, go);
    b.addEventListener('click', () => openDevice(unit.id));
    return b;
  }
  function deviceSummary(pe) {
    if (pe.domain === 'media_player') return pe.title || (pe.state && !['off', 'unavailable', 'unknown', 'idle', ''].includes(pe.state) ? friendlyState(pe) : t('smarthome_off'));
    if (SHEET_DOMAINS.has(pe.domain)) return controlSummary(pe);
    return friendlyState(pe);
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

  // Group entities by area, preserving first-seen order (the server already sorts
  // them by area then name, so rooms read the same way every render).
  function groupByArea(list) {
    const groups = new Map();
    list.forEach((e) => {
      const a = e.area || '~';   // sentinel sorts the "no area" bucket last-ish
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push(e);
    });
    return groups;
  }

  // ── Adaptive layout ──────────────────────────────────────────────────────────
  // When the widget has room, each device's FULL controls are shown INLINE; when it
  // doesn't (small tile / many devices), it falls back to compact cards that open
  // the modal. The fit is measured per tile and re-checked on resize; a generation
  // counter forces a fresh attempt when the chosen entities change.
  let renderGen = 0;
  let lastEntitySig = '';
  let tileRO = null;

  function ensureTileRO() {
    if (tileRO || typeof ResizeObserver === 'undefined') return tileRO;
    tileRO = new ResizeObserver((entries) => {
      let changed = false;
      entries.forEach((en) => {
        const mount = en.target;
        if (!document.contains(mount)) { tileRO.unobserve(mount); return; }   // tile gone → prune
        const section = mount.closest('[data-dashboard-widget="smarthome"]');
        if (!section) return;
        const w = Math.round(en.contentRect.width), h = Math.round(en.contentRect.height);
        if (section._shW === w && section._shH === h) return;
        section._shW = w; section._shH = h;
        section._shGen = -1;          // size changed → re-attempt the adaptive layout
        changed = true;
      });
      if (changed) paint();
    });
    return tileRO;
  }

  // True while the user is dragging a slider or typing in a Smart Home field —
  // paint() must not rebuild the tile under them (it would drop the drag / input).
  function isEditingSmartHome() {
    const ae = document.activeElement;
    if (!ae || (ae.tagName !== 'INPUT' && ae.tagName !== 'SELECT' && ae.tagName !== 'TEXTAREA')) return false;
    return !!(ae.closest && (ae.closest('.smarthome-widget-mount') || ae.closest('.sh-sheet-overlay')));
  }

  // An inline device panel (expanded mode): the modal's controls, shown in-tile.
  function inlinePanel(iconEntity, name, bodyEl) {
    const panel = el('div', 'sh-inline');
    const head = el('div', 'sh-inline-head');
    const ico = el('span', 'sh-inline-ico'); ico.innerHTML = iconFor(iconEntity);   // static, trusted SVG
    head.append(ico, el('span', 'sh-inline-name', name));
    panel.append(head, bodyEl);
    return panel;
  }

  function expandedUnit(u) {
    if (u.type === 'device') return inlinePanel(primaryEntity(u.entities), u.name, buildDeviceBody(u.entities, u.name));
    const e = u.entity;
    if (SHEET_DOMAINS.has(e.domain)) return inlinePanel(e, e.name, buildSheetBody(e));
    return buildItem(e);   // pure toggles / run buttons / value tiles stay compact
  }

  // How many units would become tall inline panels (devices + sheet-capable single
  // entities). Simple toggles / value cards don't count — they stay compact.
  function countSheetUnits() {
    let n = 0;
    groupByArea(state.entities).forEach((items) => {
      groupUnits(items).forEach((u) => { if (u.type === 'device' || SHEET_DOMAINS.has(u.entity.domain)) n++; });
    });
    return n;
  }

  function buildBoard(expanded) {
    const board = el('div', 'sh-board' + (expanded ? ' sh-board--expanded' : ''));
    groupByArea(state.entities).forEach((items, area) => {
      const group = el('section', 'sh-area');
      const ahead = el('div', 'sh-area-head');
      ahead.appendChild(el('span', 'sh-area-title', area === '~' ? t('smarthome_no_area', 'Other') : area));
      const onCount = items.filter((e) => TOGGLE_DOMAINS.has(e.domain) && isOn(e)).length;
      if (onCount) ahead.appendChild(el('span', 'sh-area-count', String(onCount)));
      group.appendChild(ahead);
      const grid = el('div', 'sh-grid' + (expanded ? ' sh-grid--stack' : ''));
      groupUnits(items).forEach((u) => grid.appendChild(expanded ? expandedUnit(u) : (u.type === 'device' ? deviceCard(u) : buildItem(u.entity))));
      group.appendChild(grid);
      board.appendChild(group);
    });
    return board;
  }

  function buildWrap(expanded) {
    const wrap = el('div', 'sh-wrap');
    const head = el('div', 'sh-head');
    const brand = el('div', 'sh-brand');
    const logo = el('span', 'sh-logo'); logo.innerHTML = ICONS.home;   // static, trusted SVG
    brand.append(logo, el('span', 'sh-title', t('smarthome_title', 'Smart Home')));
    const pill = el('span', 'sh-pill' + (state.connected ? ' on' : ''));
    head.append(brand, pill);
    wrap.appendChild(head);
    if (!state.configured) wrap.appendChild(emptyCard('smarthome_setup'));
    else if (!state.connected) wrap.appendChild(emptyCard('smarthome_offline'));
    else if (!state.entities.length) wrap.appendChild(emptyCard('smarthome_pick'));
    else wrap.appendChild(buildBoard(expanded));
    return wrap;
  }

  function paint() {
    if (sheetDragging || isEditingSmartHome()) return;   // don't rebuild under a drag / typed field
    syncSheet();                 // keep an open control panel in step with live state
    const list = tiles();
    if (!list.length) return;
    const sig = state.entities.map((e) => e.id).join(',');
    if (sig !== lastEntitySig) { lastEntitySig = sig; renderGen++; }   // devices changed → re-try inline
    const ro = ensureTileRO();
    list.forEach((section) => {
      const mount = section.querySelector('.smarthome-widget-mount');
      if (!mount) return;
      if (ro) ro.observe(mount);
      const hasBoard = state.configured && state.connected && state.entities.length > 0;
      const mode = (section._shGen === renderGen && section._shMode) ? section._shMode : 'auto';
      const expanded = hasBoard && mode !== 'compact';
      mount.replaceChildren(buildWrap(expanded));
      if (!expanded) { section._shGen = renderGen; section._shMode = hasBoard ? 'compact' : 'auto'; return; }
      // Decide after layout. Keep the controls INLINE when there's a single device
      // (worth showing even if it has to scroll — far better than a lone card in a
      // big empty tile) or when everything fits. Fall back to compact cards only
      // when the tile is genuinely short, or several device panels don't fit.
      requestAnimationFrame(() => {
        if (!document.contains(mount)) return;
        const bd = mount.querySelector('.sh-board');
        const avail = bd ? bd.clientHeight : 0;
        let compact = false;
        if (avail > 0) {                                   // avail 0 = not laid out yet → keep inline, re-check later
          const units = countSheetUnits();
          const overflow = bd.scrollHeight > avail + 4;
          compact = (avail < 180) || (overflow && units > 1);
        }
        if (compact) {
          section._shMode = 'compact';
          if (!sheetDragging && !isEditingSmartHome()) mount.replaceChildren(buildWrap(false));
        } else {
          section._shMode = 'expanded';
        }
        section._shGen = renderGen;
      });
    });
  }

  // One-shot seed so a freshly-added tile paints current state without waiting for
  // the next HA change (the SSE stream only pushes on change / watch (re)start).
  async function seed() {
    if (seeded) return; seeded = true;
    const d = await api('/api/homeassistant/state');
    if (d && typeof d === 'object') { state = { configured: !!d.configured, connected: !!d.connected, entities: Array.isArray(d.entities) ? d.entities : [] }; }
    paint();
  }

  function onSSE(data) {
    if (!data || typeof data !== 'object') return;
    state = { configured: !!data.configured, connected: !!data.connected, entities: Array.isArray(data.entities) ? data.entities : [] };
    seeded = true;
    paint();
  }

  // ── Device detail sheet (per-device control panel) ───────────────────────────
  // Tapping a controllable device opens a bottom sheet with exactly the controls
  // THAT device supports, derived from Home Assistant's supported_features +
  // attributes (a TV's sources & volume, a thermostat's modes, a blind's position,
  // a light's colour…). Values live-update from the SSE stream while it's open —
  // skipped mid-drag so a slider held under the finger never jumps.
  let sheetEl = null;           // the overlay element (built once, reused)
  let sheetBodyEl = null;
  let sheetKind = 'entity';     // 'entity' (one entity) | 'device' (a whole device)
  let sheetId = null;           // entity id OR device id currently shown, null = closed
  let sheetSig = '';            // last-rendered signature (skip idempotent rebuilds)
  let sheetDragging = false;    // a slider is being dragged → don't rebuild under it

  function entityById(id) { return state.entities.find((x) => x.id === id) || null; }

  // ---- control primitives ---------------------------------------------------
  function ctlGroup(labelText, node) {
    const g = el('div', 'sh-ctl');
    if (labelText) g.appendChild(el('div', 'sh-ctl-label', labelText));
    g.appendChild(node);
    return g;
  }

  function iconBtn(cls, svgPath, onClick, label) {
    const b = el('button', cls); b.type = 'button';
    b.innerHTML = SVG(svgPath);                         // static, trusted SVG
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function pillBtn(labelText, svgPath, onClick) {
    const b = el('button', 'sh-abtn'); b.type = 'button';
    b.innerHTML = SVG(svgPath);                         // static, trusted SVG
    b.appendChild(el('span', 'sh-abtn-label', labelText));
    b.addEventListener('click', onClick);
    return b;
  }

  function actionPills(pills) {
    const row = el('div', 'sh-abtns');
    pills.forEach((p) => { const b = pillBtn(p.labelText, p.svg, p.onClick); if (p.danger) b.classList.add('sh-abtn--danger'); row.appendChild(b); });
    return ctlGroup(null, row);
  }

  // An On | Off segmented control (uses the domain's own turn_on/turn_off).
  function powerRow(e, on) {
    const seg = el('div', 'sh-seg');
    const mk = (labelKey, active, service) => {
      const b = el('button', 'sh-seg-btn' + (active ? ' is-active' : '')); b.type = 'button';
      b.textContent = t(labelKey);
      b.addEventListener('click', () => callService(e.domain, service, e.id));
      return b;
    };
    seg.append(mk('smarthome_power_on', on, 'turn_on'), mk('smarthome_power_off', !on, 'turn_off'));
    return ctlGroup(null, seg);
  }

  function setRangeFill(input, value, min, max) {
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', Math.max(0, Math.min(100, pct)) + '%');
  }

  // A range slider with a live value bubble. onCommit(value) fires on release.
  function sliderRow(labelText, value, min, max, step, unit, onCommit, rightNode) {
    const g = el('div', 'sh-ctl');
    const head = el('div', 'sh-ctl-head');
    head.appendChild(el('span', 'sh-ctl-label', labelText));
    const out = el('span', 'sh-ctl-val'); out.textContent = fmtNum(value) + (unit || '');
    head.appendChild(out);
    if (rightNode) head.appendChild(rightNode);
    g.appendChild(head);
    const input = el('input', 'sh-range'); input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    setRangeFill(input, value, min, max);
    input.addEventListener('pointerdown', () => { sheetDragging = true; });
    const end = () => { sheetDragging = false; };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('input', () => { out.textContent = fmtNum(input.value) + (unit || ''); setRangeFill(input, Number(input.value), min, max); });
    input.addEventListener('change', () => { sheetDragging = false; onCommit(Number(input.value)); });
    g.appendChild(input);
    return g;
  }

  // A wrapping row of selectable chips (sources, modes, presets, options…).
  function chipGroup(labelText, options, current, onPick, fmt) {
    const wrap = el('div', 'sh-chips');
    options.forEach((opt) => {
      const chip = el('button', 'sh-chip' + (String(opt) === String(current) ? ' is-active' : '')); chip.type = 'button';
      chip.textContent = fmt ? fmt(opt) : prettify(opt);
      chip.addEventListener('click', () => onPick(opt));
      wrap.appendChild(chip);
    });
    return ctlGroup(labelText, wrap);
  }

  function switchRow(labelText, on, onChange) {
    const row = el('div', 'sh-switchrow');
    row.appendChild(el('span', 'sh-ctl-label', labelText));
    const sw = el('button', 'sh-switch2' + (on ? ' is-on' : '')); sw.type = 'button';
    sw.addEventListener('click', () => { const next = !sw.classList.contains('is-on'); sw.classList.toggle('is-on', next); onChange(next); });
    row.appendChild(sw);
    return ctlGroup(null, row);
  }

  // ---- per-domain sheet bodies ----------------------------------------------
  function sheetMedia(e, body) {
    const f = e.features || 0;
    const off = ['off', 'standby', 'unavailable', 'unknown', ''].includes(e.state);
    if (e.title) {
      const np = el('div', 'sh-now');
      np.appendChild(el('div', 'sh-now-title', e.title));
      if (e.artist) np.appendChild(el('div', 'sh-now-artist', e.artist));
      body.appendChild(np);
    }
    if (has(f, FEAT.mp.on) || has(f, FEAT.mp.off)) body.appendChild(powerRow(e, !off));
    if (has(f, FEAT.mp.prev) || has(f, FEAT.mp.next) || has(f, FEAT.mp.play) || has(f, FEAT.mp.pause) || has(f, FEAT.mp.stop)) body.appendChild(mediaTransport(e, f));
    if (has(f, FEAT.mp.seek) && Number.isFinite(e.mediaDur) && e.mediaDur > 0) body.appendChild(mediaSeek(e));
    if (has(f, FEAT.mp.shuffle) || has(f, FEAT.mp.repeat)) body.appendChild(mediaShuffleRepeat(e, f));
    if (has(f, FEAT.mp.volSet) || has(f, FEAT.mp.volStep)) body.appendChild(mediaVolume(e, f));
    if (has(f, FEAT.mp.source) && Array.isArray(e.sources) && e.sources.length) body.appendChild(chipGroup(t('smarthome_source'), e.sources, e.source, (s) => callService('media_player', 'select_source', e.id, { source: s })));
    // Direct channel tuning (also the way "back to live TV": tuning switches the TV
    // off any HDMI input onto its tuner). Standard media_player.play_media with a
    // 'channel' type — works on Sony/Samsung/LG/Roku, not a device-specific hack.
    if (has(f, FEAT.mp.playMedia)) body.appendChild(channelRow(e));
    if (has(f, FEAT.mp.sound) && Array.isArray(e.soundModes) && e.soundModes.length) body.appendChild(chipGroup(t('smarthome_sound_mode'), e.soundModes, e.soundMode, (s) => callService('media_player', 'select_sound_mode', e.id, { sound_mode: s })));
  }

  // A channel entry: type a channel number (or, on TVs that support it, a channel/app
  // name) and tune to it. Flashes red if the TV rejects the request.
  function channelRow(e) {
    const g = el('div', 'sh-ctl');
    g.appendChild(el('div', 'sh-ctl-label', t('smarthome_channel')));
    const row = el('div', 'sh-chan');
    const input = el('input', 'sh-chan-input'); input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.placeholder = t('smarthome_channel_ph');
    const go = el('button', 'sh-chan-go'); go.type = 'button'; go.textContent = t('smarthome_channel_go');
    const tune = async () => {
      const v = String(input.value).trim();
      if (!v) return;
      const r = await callService('media_player', 'play_media', e.id, { media_content_id: v, media_content_type: 'channel' });
      if (r && r.ok === false) { row.classList.remove('fail'); void row.offsetWidth; row.classList.add('fail'); }
      else { input.value = ''; }
    };
    go.addEventListener('click', tune);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); tune(); } });
    row.append(input, go);
    g.appendChild(row);
    return g;
  }

  function mediaTransport(e, f) {
    const row = el('div', 'sh-transport');
    if (has(f, FEAT.mp.prev)) row.appendChild(iconBtn('sh-tp', '<path d="M18 5v14M8 12l10-7v14z" fill="currentColor" stroke="none"/>', () => callService('media_player', 'media_previous_track', e.id), t('tip_prev')));
    const playing = e.state === 'playing';
    row.appendChild(iconBtn('sh-tp sh-tp--main', playing
      ? '<rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>'
      : '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', () => callService('media_player', 'media_play_pause', e.id), t('tip_play')));
    if (has(f, FEAT.mp.next)) row.appendChild(iconBtn('sh-tp', '<path d="M6 5v14M16 12L6 5v14z" fill="currentColor" stroke="none"/>', () => callService('media_player', 'media_next_track', e.id), t('tip_next')));
    if (has(f, FEAT.mp.stop)) row.appendChild(iconBtn('sh-tp sh-tp--sm', '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>', () => callService('media_player', 'media_stop', e.id), t('smarthome_stop')));
    return ctlGroup(null, row);
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), h = Math.floor(m / 60), ss = String(s % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m % 60).padStart(2, '0') + ':' + ss : m + ':' + ss;
  }

  // A seek bar for media with a known duration (music, movies — not live TV).
  function mediaSeek(e) {
    const dur = Math.max(1, Math.round(e.mediaDur));
    const pos = Math.max(0, Math.min(dur, Math.round(e.mediaPos || 0)));
    const g = el('div', 'sh-ctl');
    const head = el('div', 'sh-ctl-head');
    head.appendChild(el('span', 'sh-ctl-label', t('smarthome_position')));
    const out = el('span', 'sh-ctl-val'); out.textContent = fmtTime(pos) + ' / ' + fmtTime(dur);
    head.appendChild(out);
    g.appendChild(head);
    const input = el('input', 'sh-range'); input.type = 'range'; input.min = '0'; input.max = String(dur); input.step = '1'; input.value = String(pos);
    setRangeFill(input, pos, 0, dur);
    input.addEventListener('pointerdown', () => { sheetDragging = true; });
    const end = () => { sheetDragging = false; };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('input', () => { out.textContent = fmtTime(Number(input.value)) + ' / ' + fmtTime(dur); setRangeFill(input, Number(input.value), 0, dur); });
    input.addEventListener('change', () => { sheetDragging = false; callService('media_player', 'media_seek', e.id, { seek_position: Number(input.value) }); });
    g.appendChild(input);
    return g;
  }

  // Shuffle + repeat toggles (repeat cycles off → all → one).
  function mediaShuffleRepeat(e, f) {
    const row = el('div', 'sh-abtns');
    if (has(f, FEAT.mp.shuffle)) {
      const on = !!e.shuffle;
      const b = pillBtn(t('smarthome_shuffle'), '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>', () => callService('media_player', 'shuffle_set', e.id, { shuffle: !on }));
      if (on) b.classList.add('is-active');
      row.appendChild(b);
    }
    if (has(f, FEAT.mp.repeat)) {
      const mode = e.repeat || 'off';
      const next = mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
      const b = pillBtn(t('smarthome_repeat') + (mode === 'one' ? ' ·1' : mode === 'all' ? ' ·∞' : ''), '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>', () => callService('media_player', 'repeat_set', e.id, { repeat: next }));
      if (mode !== 'off') b.classList.add('is-active');
      row.appendChild(b);
    }
    return ctlGroup(null, row);
  }

  function mediaVolume(e, f) {
    const muted = !!e.muted;
    const muteBtn = has(f, FEAT.mp.volMute)
      ? iconBtn('sh-icobtn' + (muted ? ' is-active' : ''), muted
        ? '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M17 9l4 6M21 9l-4 6"/>'
        : '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/>', () => callService('media_player', 'volume_mute', e.id, { is_volume_muted: !muted }), t('smarthome_mute'))
      : null;
    if (has(f, FEAT.mp.volSet)) {
      const vol = Math.round((Number(e.volume) || 0) * 100);
      return sliderRow(t('smarthome_volume'), vol, 0, 100, 1, '%', (v) => callService('media_player', 'volume_set', e.id, { volume_level: v / 100 }), muteBtn);
    }
    const row = el('div', 'sh-abtns');
    row.appendChild(pillBtn(t('smarthome_volume_down'), '<path d="M5 12h14"/>', () => callService('media_player', 'volume_down', e.id)));
    if (muteBtn) row.appendChild(muteBtn);
    row.appendChild(pillBtn(t('smarthome_volume_up'), '<path d="M12 5v14M5 12h14"/>', () => callService('media_player', 'volume_up', e.id)));
    return ctlGroup(t('smarthome_volume'), row);
  }

  const LIGHT_SWATCHES = [[255, 147, 41], [255, 190, 140], [255, 244, 229], [212, 229, 255], [130, 175, 255], [255, 84, 84], [97, 222, 140], [181, 120, 255], [255, 110, 196]];
  function sheetLight(e, body) {
    const on = isOn(e);
    body.appendChild(powerRow(e, on));
    const bpct = Number.isFinite(e.brightness) ? Math.round(e.brightness / 255 * 100) : (on ? 100 : 0);
    body.appendChild(sliderRow(t('smarthome_brightness'), bpct, 1, 100, 1, '%', (v) => callService('light', 'turn_on', e.id, { brightness_pct: v })));
    const modes = e.colorModes || [];
    if (modes.includes('color_temp') && Number.isFinite(e.minKelvin) && Number.isFinite(e.maxKelvin) && e.maxKelvin > e.minKelvin) {
      const k = Number.isFinite(e.kelvin) ? e.kelvin : Math.round((e.minKelvin + e.maxKelvin) / 2);
      const row = sliderRow(t('smarthome_white'), k, e.minKelvin, e.maxKelvin, 50, 'K', (v) => callService('light', 'turn_on', e.id, { color_temp_kelvin: v }));
      row.querySelector('.sh-range').classList.add('sh-range--kelvin');
      body.appendChild(row);
    }
    if (modes.some((m) => ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'].includes(m))) {
      const wrap = el('div', 'sh-swatches');
      LIGHT_SWATCHES.forEach((rgb) => {
        const active = Array.isArray(e.rgb) && e.rgb[0] === rgb[0] && e.rgb[1] === rgb[1] && e.rgb[2] === rgb[2];
        const sw = el('button', 'sh-swatch' + (active ? ' is-active' : '')); sw.type = 'button';
        sw.style.setProperty('--sw', rgb.join(','));
        sw.addEventListener('click', () => callService('light', 'turn_on', e.id, { rgb_color: rgb }));
        wrap.appendChild(sw);
      });
      body.appendChild(ctlGroup(t('smarthome_color'), wrap));
    }
    if (Array.isArray(e.effects) && e.effects.length) body.appendChild(chipGroup(t('smarthome_effect'), e.effects, e.effect, (fx) => callService('light', 'turn_on', e.id, { effect: fx })));
  }

  // A −/big-target/+ temperature stepper, shared by climate and water heater.
  function thermoStepper(target, min, max, step, currentTemp, actionText, onSet) {
    const clamp = (v) => Math.max(min, Math.min(max, Math.round(v * 10) / 10));
    const wrap = el('div', 'sh-thermo');
    const mid = el('div', 'sh-thermo-mid');
    mid.appendChild(el('div', 'sh-thermo-target', fmtNum(target) + '°'));
    if (Number.isFinite(currentTemp)) mid.appendChild(el('div', 'sh-thermo-current', t('smarthome_current') + ' ' + fmtNum(currentTemp) + '°'));
    if (actionText) mid.appendChild(el('div', 'sh-thermo-action', actionText));
    wrap.append(
      iconBtn('sh-step', '<path d="M5 12h14"/>', () => onSet(clamp(target - step)), t('smarthome_volume_down')),
      mid,
      iconBtn('sh-step', '<path d="M12 5v14M5 12h14"/>', () => onSet(clamp(target + step)), t('smarthome_volume_up')),
    );
    return ctlGroup(null, wrap);
  }

  function sheetClimate(e, body) {
    const step = e.step > 0 ? e.step : 0.5;
    const min = Number.isFinite(e.min) ? e.min : 7;
    const max = Number.isFinite(e.max) ? e.max : 35;
    const target = Number.isFinite(e.target) ? e.target : (Number.isFinite(e.current) ? e.current : 20);
    body.appendChild(thermoStepper(target, min, max, step, e.current, e.hvacAction ? prettify(e.hvacAction) : '', (v) => callService('climate', 'set_temperature', e.id, { temperature: v })));
    if (Array.isArray(e.hvacModes) && e.hvacModes.length) body.appendChild(chipGroup(t('smarthome_mode'), e.hvacModes, e.state, (m) => callService('climate', 'set_hvac_mode', e.id, { hvac_mode: m }), fmtHvac));
    if (Array.isArray(e.fanModes) && e.fanModes.length) body.appendChild(chipGroup(t('smarthome_fan'), e.fanModes, e.fanMode, (m) => callService('climate', 'set_fan_mode', e.id, { fan_mode: m })));
    if (Array.isArray(e.presetModes) && e.presetModes.length) body.appendChild(chipGroup(t('smarthome_preset'), e.presetModes, e.presetMode, (m) => callService('climate', 'set_preset_mode', e.id, { preset_mode: m })));
    if (Array.isArray(e.swingModes) && e.swingModes.length) body.appendChild(chipGroup(t('smarthome_swing'), e.swingModes, e.swingMode, (s) => callService('climate', 'set_swing_mode', e.id, { swing_mode: s })));
    if (Number.isFinite(e.currentHumidity)) body.appendChild(el('div', 'sh-ctl-note', t('smarthome_humidity') + ' ' + Math.round(e.currentHumidity) + '%'));
  }

  function sheetCover(e, body) {
    const f = e.features || 0;
    const pills = [];
    if (has(f, FEAT.cover.open)) pills.push({ labelText: t('smarthome_open'), svg: '<path d="M12 19V5M6 11l6-6 6 6"/>', onClick: () => callService('cover', 'open_cover', e.id) });
    if (has(f, FEAT.cover.stop)) pills.push({ labelText: t('smarthome_stop'), svg: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>', onClick: () => callService('cover', 'stop_cover', e.id) });
    if (has(f, FEAT.cover.close)) pills.push({ labelText: t('smarthome_close_cover'), svg: '<path d="M12 5v14M6 13l6 6 6-6"/>', onClick: () => callService('cover', 'close_cover', e.id) });
    if (pills.length) body.appendChild(actionPills(pills));
    if (has(f, FEAT.cover.setPos) && Number.isFinite(e.position)) body.appendChild(sliderRow(t('smarthome_position'), e.position, 0, 100, 1, '%', (v) => callService('cover', 'set_cover_position', e.id, { position: v })));
    // Tilt (venetian blinds): open/stop/close tilt + a tilt position slider.
    const tilt = [];
    if (has(f, FEAT.cover.openTilt)) tilt.push(pillBtn(t('smarthome_open'), '<path d="M12 19V5M6 11l6-6 6 6"/>', () => callService('cover', 'open_cover_tilt', e.id)));
    if (has(f, FEAT.cover.stopTilt)) tilt.push(pillBtn(t('smarthome_stop'), '<rect x="7" y="7" width="10" height="10" rx="1.5"/>', () => callService('cover', 'stop_cover_tilt', e.id)));
    if (has(f, FEAT.cover.closeTilt)) tilt.push(pillBtn(t('smarthome_close_cover'), '<path d="M12 5v14M6 13l6 6 6-6"/>', () => callService('cover', 'close_cover_tilt', e.id)));
    if (tilt.length) { const r = el('div', 'sh-abtns'); tilt.forEach((p) => r.appendChild(p)); body.appendChild(ctlGroup(t('smarthome_tilt'), r)); }
    if (has(f, FEAT.cover.setTilt) && Number.isFinite(e.tilt)) body.appendChild(sliderRow(t('smarthome_tilt'), e.tilt, 0, 100, 1, '%', (v) => callService('cover', 'set_cover_tilt_position', e.id, { tilt_position: v })));
  }

  function sheetFan(e, body) {
    const f = e.features || 0;
    body.appendChild(powerRow(e, isOn(e)));
    if (has(f, FEAT.fan.speed)) {
      const pct = Number.isFinite(e.pct) ? e.pct : (isOn(e) ? 100 : 0);
      body.appendChild(sliderRow(t('smarthome_speed'), pct, 0, 100, e.pctStep > 0 ? e.pctStep : 1, '%', (v) => callService('fan', 'set_percentage', e.id, { percentage: v })));
    }
    if (has(f, FEAT.fan.preset) && Array.isArray(e.presetModes) && e.presetModes.length) body.appendChild(chipGroup(t('smarthome_preset'), e.presetModes, e.presetMode, (m) => callService('fan', 'set_preset_mode', e.id, { preset_mode: m })));
    if (has(f, FEAT.fan.oscillate)) body.appendChild(switchRow(t('smarthome_oscillate'), !!e.oscillating, (v) => callService('fan', 'oscillate', e.id, { oscillating: v })));
    if (has(f, FEAT.fan.direction)) {
      const rev = e.direction === 'reverse';
      const r = el('div', 'sh-abtns');
      const fwd = pillBtn(t('smarthome_forward'), '<path d="M12 19V5M6 11l6-6 6 6"/>', () => callService('fan', 'set_direction', e.id, { direction: 'forward' })); if (!rev) fwd.classList.add('is-active');
      const rv = pillBtn(t('smarthome_reverse'), '<path d="M12 5v14M6 13l6 6 6-6"/>', () => callService('fan', 'set_direction', e.id, { direction: 'reverse' })); if (rev) rv.classList.add('is-active');
      r.append(fwd, rv);
      body.appendChild(ctlGroup(t('smarthome_direction'), r));
    }
  }

  function sheetVacuum(e, body) {
    const f = e.features || 0;
    const pills = [];
    if (has(f, FEAT.vacuum.start)) pills.push({ labelText: t('smarthome_start'), svg: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', onClick: () => callService('vacuum', 'start', e.id) });
    if (has(f, FEAT.vacuum.pause)) pills.push({ labelText: t('smarthome_pause'), svg: '<rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/>', onClick: () => callService('vacuum', 'pause', e.id) });
    if (has(f, FEAT.vacuum.stop)) pills.push({ labelText: t('smarthome_stop'), svg: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>', onClick: () => callService('vacuum', 'stop', e.id) });
    if (has(f, FEAT.vacuum.return)) pills.push({ labelText: t('smarthome_return'), svg: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', onClick: () => callService('vacuum', 'return_to_base', e.id) });
    if (has(f, FEAT.vacuum.cleanSpot)) pills.push({ labelText: t('smarthome_clean_spot'), svg: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/>', onClick: () => callService('vacuum', 'clean_spot', e.id) });
    if (has(f, FEAT.vacuum.locate)) pills.push({ labelText: t('smarthome_locate'), svg: '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.5" fill="currentColor"/>', onClick: () => callService('vacuum', 'locate', e.id) });
    if (pills.length) body.appendChild(actionPills(pills));
    if (has(f, FEAT.vacuum.fanSpeed) && Array.isArray(e.fanSpeeds) && e.fanSpeeds.length) body.appendChild(chipGroup(t('smarthome_speed'), e.fanSpeeds, e.fanSpeed, (s) => callService('vacuum', 'set_fan_speed', e.id, { fan_speed: s })));
    if (Number.isFinite(e.battery)) body.appendChild(el('div', 'sh-ctl-note', t('smarthome_battery') + ' ' + Math.round(e.battery) + '%'));
  }

  function sheetHumidifier(e, body) {
    body.appendChild(powerRow(e, isOn(e)));
    if (Number.isFinite(e.target)) body.appendChild(sliderRow(t('smarthome_humidity'), e.target, Number.isFinite(e.min) ? e.min : 0, Number.isFinite(e.max) ? e.max : 100, 1, '%', (v) => callService('humidifier', 'set_humidity', e.id, { humidity: v })));
    if (Array.isArray(e.presetModes) && e.presetModes.length) body.appendChild(chipGroup(t('smarthome_mode'), e.presetModes, e.presetMode, (m) => callService('humidifier', 'set_mode', e.id, { mode: m })));
  }

  function sheetWaterHeater(e, body) {
    body.appendChild(powerRow(e, isOn(e)));
    const min = Number.isFinite(e.min) ? e.min : 30, max = Number.isFinite(e.max) ? e.max : 80;
    const target = Number.isFinite(e.target) ? e.target : (Number.isFinite(e.current) ? e.current : 50);
    body.appendChild(thermoStepper(target, min, max, 1, e.current, '', (v) => callService('water_heater', 'set_temperature', e.id, { temperature: v })));
    if (Array.isArray(e.presetModes) && e.presetModes.length) body.appendChild(chipGroup(t('smarthome_mode'), e.presetModes, e.presetMode, (m) => callService('water_heater', 'set_operation_mode', e.id, { operation_mode: m })));
  }

  function sheetAlarm(e, body) {
    const f = e.features || 0;
    const st = String(e.state || '');
    const armed = st.indexOf('armed') === 0;
    // Optional code entry (only when the panel requires a code to arm/disarm).
    let codeInput = null;
    if (e.codeArm) {
      const g = el('div', 'sh-ctl');
      g.appendChild(el('div', 'sh-ctl-label', t('smarthome_code')));
      codeInput = el('input', 'sh-chan-input'); codeInput.type = 'password'; codeInput.inputMode = 'numeric'; codeInput.autocomplete = 'off';
      g.appendChild(codeInput); body.appendChild(g);
    }
    const code = () => (codeInput && codeInput.value) ? { code: codeInput.value } : {};
    const arm = [];
    if (has(f, FEAT.alarm.armHome)) arm.push({ labelText: t('smarthome_arm_home'), svg: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', onClick: () => callService('alarm_control_panel', 'alarm_arm_home', e.id, code()) });
    if (has(f, FEAT.alarm.armAway)) arm.push({ labelText: t('smarthome_arm_away'), svg: '<path d="M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6z"/>', onClick: () => callService('alarm_control_panel', 'alarm_arm_away', e.id, code()) });
    if (has(f, FEAT.alarm.armNight)) arm.push({ labelText: t('smarthome_arm_night'), svg: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', onClick: () => callService('alarm_control_panel', 'alarm_arm_night', e.id, code()) });
    if (arm.length) body.appendChild(actionPills(arm));
    const dis = pillBtn(t('smarthome_disarm'), '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-2.6"/>', () => callService('alarm_control_panel', 'alarm_disarm', e.id, code()));
    if (!armed) dis.classList.add('is-active');
    const r = el('div', 'sh-abtns'); r.appendChild(dis);
    body.appendChild(ctlGroup(null, r));
  }

  function sheetValve(e, body) {
    const f = e.features || 0;
    const pills = [];
    if (has(f, FEAT.valve.open)) pills.push({ labelText: t('smarthome_open'), svg: '<path d="M12 19V5M6 11l6-6 6 6"/>', onClick: () => callService('valve', 'open_valve', e.id) });
    if (has(f, FEAT.valve.stop)) pills.push({ labelText: t('smarthome_stop'), svg: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>', onClick: () => callService('valve', 'stop_valve', e.id) });
    if (has(f, FEAT.valve.close)) pills.push({ labelText: t('smarthome_close_cover'), svg: '<path d="M12 5v14M6 13l6 6 6-6"/>', onClick: () => callService('valve', 'close_valve', e.id) });
    if (pills.length) body.appendChild(actionPills(pills));
    if (has(f, FEAT.valve.setPos) && Number.isFinite(e.position)) body.appendChild(sliderRow(t('smarthome_position'), e.position, 0, 100, 1, '%', (v) => callService('valve', 'set_valve_position', e.id, { position: v })));
  }

  function sheetLawnMower(e, body) {
    const f = e.features || 0;
    const pills = [];
    if (has(f, FEAT.mower.start)) pills.push({ labelText: t('smarthome_start'), svg: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', onClick: () => callService('lawn_mower', 'start_mowing', e.id) });
    if (has(f, FEAT.mower.pause)) pills.push({ labelText: t('smarthome_pause'), svg: '<rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/>', onClick: () => callService('lawn_mower', 'pause', e.id) });
    if (has(f, FEAT.mower.dock)) pills.push({ labelText: t('smarthome_return'), svg: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', onClick: () => callService('lawn_mower', 'dock', e.id) });
    if (pills.length) body.appendChild(actionPills(pills));
    if (Number.isFinite(e.battery)) body.appendChild(el('div', 'sh-ctl-note', t('smarthome_battery') + ' ' + Math.round(e.battery) + '%'));
  }

  function sheetNumber(e, body) {
    const min = Number.isFinite(e.min) ? e.min : 0;
    const max = Number.isFinite(e.max) ? e.max : 100;
    const step = e.step > 0 ? e.step : 1;
    const val = Number.isFinite(Number(e.state)) ? Number(e.state) : min;
    body.appendChild(sliderRow(e.name, val, min, max, step, e.unit ? ' ' + e.unit : '', (v) => callService(e.domain, 'set_value', e.id, { value: v })));
  }

  function sheetSelect(e, body) {
    if (Array.isArray(e.options) && e.options.length) body.appendChild(chipGroup(t('smarthome_options'), e.options, e.state, (o) => callService(e.domain, 'select_option', e.id, { option: o })));
    else body.appendChild(el('div', 'sh-ctl-note', prettify(e.state)));
  }

  // fillControls: the domain-specific control block for ONE entity, appended to
  // `body`. Shared by the single-entity sheet and each section of a device panel.
  function fillControls(e, body) {
    switch (e.domain) {
      case 'media_player': sheetMedia(e, body); break;
      case 'light': sheetLight(e, body); break;
      case 'climate': sheetClimate(e, body); break;
      case 'cover': sheetCover(e, body); break;
      case 'fan': sheetFan(e, body); break;
      case 'vacuum': sheetVacuum(e, body); break;
      case 'humidifier': sheetHumidifier(e, body); break;
      case 'water_heater': sheetWaterHeater(e, body); break;
      case 'alarm_control_panel': sheetAlarm(e, body); break;
      case 'valve': sheetValve(e, body); break;
      case 'lawn_mower': sheetLawnMower(e, body); break;
      case 'number': case 'input_number': sheetNumber(e, body); break;
      case 'select': case 'input_select': sheetSelect(e, body); break;
      default: body.appendChild(el('div', 'sh-ctl-note', stateLabel(e)));
    }
  }

  function buildSheetBody(e) {
    const body = el('div', 'sh-sheet-body');
    fillControls(e, body);
    return body;
  }

  // Controls for one MAIN entity inside a device panel — rich sheet controls for
  // capable domains, On/Off for a plain switch/remote, lock/unlock for a lock, else
  // a read-only value line. (Buttons/scenes/scripts are collected into the compact
  // "Actions" group instead, so they don't each become a big section.)
  function deviceEntityControls(e) {
    const c = el('div', 'sh-dev-ctls');
    if (SHEET_DOMAINS.has(e.domain)) fillControls(e, c);
    else if (e.domain === 'remote' || e.domain === 'switch' || e.domain === 'input_boolean' || e.domain === 'siren' || e.domain === 'automation') c.appendChild(powerRow(e, isOn(e)));
    else if (e.domain === 'lock') c.appendChild(actionPills([
      { labelText: t('smarthome_unlocked'), svg: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-2.6"/>', onClick: () => callService('lock', 'unlock', e.id) },
      { labelText: t('smarthome_locked'), svg: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', onClick: () => callService('lock', 'lock', e.id) },
    ]));
    else { const p = splitValue(e); c.appendChild(el('div', 'sh-ctl-note', p.num + (p.unit || ''))); }
    return c;
  }

  // A section = a small uppercase label + its controls. Flat (divider between
  // sections, no nested boxes). The label is just the entity TYPE (e.g. "Media
  // player") when the entity is the device itself, or its short name for a distinct
  // part ("Restart") — never the full device name again (it's already the header).
  function deviceSection(e, deviceName) {
    const sec = el('div', 'sh-dev-sec');
    const short = entityShortName(e, deviceName);
    const showName = short && short.toLowerCase() !== String(deviceName || '').toLowerCase();
    sec.appendChild(el('div', 'sh-dev-sec-label', showName ? short + ' · ' + domainLabel(e) : domainLabel(e)));
    sec.appendChild(deviceEntityControls(e));
    return sec;
  }

  // The buttons / scenes / scripts of a device, gathered into ONE compact "Actions"
  // section (small buttons, e.g. Restart / Close apps) rather than a big block each.
  function deviceActions(list, deviceName) {
    const sec = el('div', 'sh-dev-sec');
    sec.appendChild(el('div', 'sh-dev-sec-label', t('smarthome_actions')));
    const row = el('div', 'sh-abtns sh-abtns--wrap');
    list.slice().sort((a, b) => domainRank(a.domain) - domainRank(b.domain)).forEach((e) => {
      const isBtn = e.domain === 'button';
      const b = pillBtn(entityShortName(e, deviceName), isBtn ? '<circle cx="12" cy="12" r="6.5"/>' : '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', async () => {
        b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
        if (isBtn) await callService('button', 'press', e.id);
        else await callService(e.domain, 'turn_on', e.id);
      });
      row.appendChild(b);
    });
    sec.appendChild(row);
    return sec;
  }

  // The device panel body. A physical device (a TV) exposes several entities; rather
  // than a confusing section per entity, we present ONE main control block per real
  // control (media/climate/light…), fold the buttons/scenes into a single "Actions"
  // group, and drop a bare `remote` when a media_player already provides power (its
  // only control would just duplicate the media_player's On/Off).
  function buildDeviceBody(entities, deviceName) {
    const body = el('div', 'sh-sheet-body');
    const hasMedia = entities.some((e) => e.domain === 'media_player');
    const actions = [];
    const sections = [];
    entities.forEach((e) => {
      if (e.domain === 'button' || RUN_DOMAINS.has(e.domain)) actions.push(e);
      else if (e.domain === 'remote' && hasMedia) { /* redundant power — skip */ }
      else sections.push(e);
    });
    sections.sort((a, b) => domainRank(a.domain) - domainRank(b.domain));
    sections.forEach((e) => body.appendChild(deviceSection(e, deviceName)));
    if (actions.length) body.appendChild(deviceActions(actions, deviceName));
    if (!body.firstChild) body.appendChild(el('div', 'sh-ctl-note', stateLabel(primaryEntity(entities))));
    return body;
  }

  // ---- sheet shell + lifecycle ----------------------------------------------
  function ensureSheet() {
    if (sheetEl) return sheetEl;
    const ov = el('div', 'sh-sheet-overlay'); ov.hidden = true;
    const sheet = el('div', 'sh-sheet');
    const head = el('div', 'sh-sheet-head');
    const ico = el('span', 'sh-sheet-ico');
    const titles = el('div', 'sh-sheet-titles');
    const title = el('div', 'sh-sheet-title');
    const sub = el('div', 'sh-sheet-sub');
    titles.append(title, sub);
    const close = el('button', 'sh-sheet-close'); close.type = 'button'; close.setAttribute('aria-label', t('close'));
    close.innerHTML = SVG('<path d="M6 6l12 12M18 6L6 18"/>');   // static, trusted SVG
    close.addEventListener('click', closeSheet);
    head.append(ico, titles, close);
    const scroll = el('div', 'sh-sheet-scroll');
    sheet.append(head, scroll);
    ov.appendChild(sheet);
    ov.addEventListener('click', (ev) => { if (ev.target === ov) closeSheet(); });
    document.body.appendChild(ov);
    sheetEl = ov; sheetBodyEl = scroll;
    sheetEl._ico = ico; sheetEl._title = title; sheetEl._sub = sub;
    return ov;
  }

  function deviceEntitiesById(devId) { return state.entities.filter((x) => x.device === devId); }

  // Render the open sheet from live state — a single entity, or all the entities of
  // one physical device. Skips a rebuild when nothing changed (idempotent sig).
  function renderSheet() {
    if (sheetKind === 'device') {
      const ents = deviceEntitiesById(sheetId);
      if (!ents.length) { closeSheet(); return; }
      const sig = 'dev|' + sheetId + '|' + JSON.stringify(ents);
      if (sig === sheetSig) return;
      sheetSig = sig;
      const pe = primaryEntity(ents);
      const name = ents[0].deviceName || pe.name;
      sheetEl._ico.innerHTML = iconFor(pe);   // static, trusted SVG
      sheetEl._ico.classList.toggle('is-on', ents.some((x) => isOn(x)));
      sheetEl._title.textContent = name;
      sheetEl._sub.textContent = (pe.area && pe.area !== '~') ? pe.area : t('smarthome_title');
      sheetBodyEl.replaceChildren(buildDeviceBody(ents, name));
      return;
    }
    const e = entityById(sheetId);
    if (!e) { closeSheet(); return; }
    const sig = 'ent|' + e.id + '|' + JSON.stringify(e);
    if (sig === sheetSig) return;             // unchanged → don't rebuild under the user
    sheetSig = sig;
    sheetEl._ico.innerHTML = iconFor(e);      // static, trusted SVG
    sheetEl._ico.classList.toggle('is-on', isOn(e));
    sheetEl._title.textContent = e.name;
    sheetEl._sub.textContent = (e.area && e.area !== '~') ? e.area : t('smarthome_title');
    sheetBodyEl.replaceChildren(buildSheetBody(e));
  }

  function openTarget(kind, id) {
    sheetKind = kind; sheetId = id; sheetSig = '';
    ensureSheet();
    renderSheet();
    if (sheetId === null) return;             // renderSheet closed it (nothing to show)
    sheetEl.hidden = false;
    requestAnimationFrame(() => { if (sheetEl) sheetEl.classList.add('is-open'); });
    document.addEventListener('keydown', onSheetKey);
  }
  function openSheet(id) { if (entityById(id)) openTarget('entity', id); }
  function openDevice(devId) { if (deviceEntitiesById(devId).length) openTarget('device', devId); }

  function closeSheet() {
    if (!sheetEl) return;
    sheetId = null; sheetDragging = false;
    sheetEl.classList.remove('is-open');
    document.removeEventListener('keydown', onSheetKey);
    const ov = sheetEl;
    setTimeout(() => { if (sheetId === null) ov.hidden = true; }, 220);
  }

  function onSheetKey(ev) { if (ev.key === 'Escape') closeSheet(); }

  // Reflect live state into an open sheet (called on every paint). Rebuild is
  // skipped mid-drag (so a held slider never jumps) and when nothing changed.
  function syncSheet() {
    if (sheetId === null || !sheetEl || sheetEl.hidden || sheetDragging) return;
    renderSheet();
  }

  // ── Settings page (Settings → Smart Home) ────────────────────────────────────
  let allEntities = null;          // cached full entity list for the picker
  let entitiesInflight = null;

  function settingsMount() { return document.getElementById('settings-smarthome-hub'); }
  function energyMount() { return document.getElementById('settings-energy-hub'); }

  // Which entities qualify as Energy-widget sources: anything HA marks as
  // power/energy/battery, or that reports in watt/kilowatt-hour units (some
  // integrations ship the unit without a device_class).
  const ENERGY_CLASSES = new Set(['power', 'energy', 'battery']);
  const ENERGY_UNITS = new Set(['W', 'kW', 'kWh', 'Wh']);
  const isEnergySource = (e) => ENERGY_CLASSES.has(e.deviceClass) || ENERGY_UNITS.has(e.unit);

  function initSettings() {
    const host = settingsMount();
    if (!host) return;
    const ha = window.getHomeAssistantSettings ? window.getHomeAssistantSettings() : { url: '', entities: [], tokenSet: false };
    host.replaceChildren(buildSettingsCard(ha));
    initEnergySettings(ha);
  }

  // The Energy widget's own picker (Settings → Smart Home → Energy sources):
  // the same area-grouped checkbox list, filtered to power/energy sensors and
  // persisted to the INDEPENDENT homeAssistant.energyEntities selection.
  function initEnergySettings(ha) {
    const host = energyMount();
    if (!host) return;
    host.replaceChildren();
    if (ha.url && ha.tokenSet) {
      const picker = el('div', 'sh-set-picker');
      host.appendChild(picker);
      renderPicker(picker, {
        key: 'energyEntities',
        filter: isEnergySource,
        title: t('power_sources_pick', 'Power & energy sensors to show'),
        hint: t('power_sources_hint', 'Smart plugs, solar production, home meter, UPS — shown in the Energy widget.'),
        empty: t('power_sources_none', 'No power or energy sensors found in Home Assistant.'),
      });
    } else {
      host.appendChild(el('div', 'sh-set-hint', t('settings_ha_select_first', '')));
    }
  }

  function buildSettingsCard(ha) {
    const card = el('div', 'sh-set-card');
    card.appendChild(el('div', 'sh-set-desc', t('settings_ha_desc', '')));

    // Address + token inputs.
    const urlRow = el('label', 'sh-set-row');
    urlRow.appendChild(el('span', 'sh-set-label', t('settings_ha_url', 'Address (URL)')));
    const url = el('input', 'sh-set-input'); url.type = 'text'; url.placeholder = 'http://homeassistant.local:8123'; url.value = ha.url || '';
    urlRow.appendChild(url);
    card.appendChild(urlRow);

    const tokRow = el('label', 'sh-set-row');
    tokRow.appendChild(el('span', 'sh-set-label', t('settings_ha_token', 'Access token')));
    const token = el('input', 'sh-set-input'); token.type = 'password'; token.autocomplete = 'off';
    token.placeholder = ha.tokenSet ? '••••••••  ' + t('settings_ha_token_saved', 'Saved') : '';
    tokRow.appendChild(token);
    card.appendChild(tokRow);
    card.appendChild(el('div', 'sh-set-help', t('settings_ha_token_help', '')));

    // Connect button + status line.
    const actions = el('div', 'sh-set-actions');
    const connect = el('button', 'ui-btn ui-btn--primary'); connect.type = 'button'; connect.textContent = t('settings_ha_connect', 'Connect');
    const status = el('span', 'sh-set-status');
    actions.append(connect, status);
    card.appendChild(actions);

    // Device picker (rendered after a successful connection / when configured).
    const picker = el('div', 'sh-set-picker');
    card.appendChild(picker);

    connect.addEventListener('click', async () => {
      connect.disabled = true; status.className = 'sh-set-status'; status.textContent = t('settings_ha_connecting', 'Connecting…');
      const payload = { url: url.value.trim() };
      if (token.value) payload.token = token.value;
      const r = await api('/api/homeassistant/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      connect.disabled = false;
      if (r && r.ok) {
        // Persist url (+ token only if the user typed a new one). The server keeps
        // the previous token when we send none (write-only field).
        const patch = { url: url.value.trim() };
        if (token.value) patch.token = token.value;
        if (window.setHomeAssistantSettings) window.setHomeAssistantSettings(patch);
        token.value = ''; token.placeholder = '••••••••  ' + t('settings_ha_token_saved', 'Saved');
        status.className = 'sh-set-status ok';
        status.textContent = t('settings_ha_ok', 'Connected') + ' · ' + (r.count || 0) + ' ' + t('settings_ha_devices', 'devices');
        // Use the entity list returned by /test directly — the settings save is
        // debounced, so a fresh GET /entities could still read the pre-save config.
        allEntities = (Array.isArray(r.entities) && r.entities.length) ? r.entities : null;
        renderPicker(picker);
        // The Energy-sources picker gates on url+tokenSet too — refresh it now
        // that the connection is saved instead of waiting for a Settings reopen.
        if (window.getHomeAssistantSettings) initEnergySettings(window.getHomeAssistantSettings());
      } else {
        status.className = 'sh-set-status err'; status.textContent = t('settings_ha_fail', 'Connection failed');
      }
    });

    // If already configured, show the picker straight away.
    if (ha.url && ha.tokenSet) renderPicker(picker);
    else picker.appendChild(el('div', 'sh-set-hint', t('settings_ha_select_first', '')));

    return card;
  }

  function fetchEntities() {
    // Only a non-empty list is cached; an empty/failed fetch (transient HA outage,
    // pre-save config) is NOT cached, so re-opening Settings retries instead of
    // staying stuck on an empty picker.
    if (allEntities && allEntities.length) return Promise.resolve(allEntities);
    if (!entitiesInflight) {
      entitiesInflight = api('/api/homeassistant/entities')
        .then((d) => {
          const list = (d && d.ok && Array.isArray(d.entities)) ? d.entities : [];
          allEntities = list.length ? list : null;
          entitiesInflight = null;
          return list;
        })
        .catch(() => { entitiesInflight = null; return []; });
    }
    return entitiesInflight;
  }

  // opts (all optional — default is the Smart Home tile's device picker):
  //   key      — homeAssistant settings array the selection persists to
  //   filter   — entity predicate limiting what the list offers
  //   title/hint/empty — already-localised label overrides
  async function renderPicker(host, opts) {
    const cfg = opts || {};
    const key = cfg.key || 'entities';
    host.replaceChildren(el('div', 'sh-set-hint', t('settings_ha_connecting', 'Connecting…')));
    let items = await fetchEntities();
    if (cfg.filter) items = items.filter(cfg.filter);
    if (!settingsMount()) return;                // Settings closed while awaiting
    host.replaceChildren();
    host.appendChild(el('div', 'sh-set-picker-title', cfg.title || t('settings_ha_entities', 'Devices to show')));
    host.appendChild(el('div', 'sh-set-hint', cfg.hint || t('settings_ha_entities_hint', '')));
    if (!items.length) { host.appendChild(el('div', 'sh-set-hint', cfg.empty || t('settings_ha_select_first', ''))); return; }

    const ha = window.getHomeAssistantSettings ? window.getHomeAssistantSettings() : { entities: [] };
    const chosen = new Set(ha[key] || []);

    const search = el('input', 'sh-set-input'); search.type = 'search'; search.placeholder = t('settings_ha_search', 'Search…');
    host.appendChild(search);

    const listWrap = el('div', 'sh-set-list');
    host.appendChild(listWrap);

    const rows = [];
    // A row = checkbox + name + a TYPE badge (Media player / Remote / Button…) so
    // the user understands what each entity is, + the raw entity id.
    const makeRow = (e, shortName) => {
      const row = el('label', 'sh-set-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = chosen.has(e.id);
      cb.addEventListener('change', () => {
        if (cb.checked) chosen.add(e.id); else chosen.delete(e.id);
        // Persist in the entity list's own order so the tile groups match.
        const ordered = items.filter((x) => chosen.has(x.id)).map((x) => x.id);
        if (window.setHomeAssistantSettings) window.setHomeAssistantSettings({ [key]: ordered });
      });
      row.append(cb, el('span', 'sh-set-check-name', shortName || e.name), el('span', 'sh-set-check-type', domainLabel(e)), el('span', 'sh-set-check-id', e.id));
      row._match = (e.name + ' ' + e.id + ' ' + (e.area || '') + ' ' + domainLabel(e)).toLowerCase();
      return row;
    };

    // Group by area, then by physical device inside each area — so the four
    // "BRAVIA XR-55A80J" entities read as ONE device with its parts listed under it.
    const byArea = groupByArea(items);
    byArea.forEach((ents, area) => {
      listWrap.appendChild(el('div', 'sh-set-group', area === '~' ? t('smarthome_no_area', 'Other') : area));
      groupUnits(ents).forEach((u) => {
        if (u.type === 'single') {
          const row = makeRow(u.entity);
          listWrap.appendChild(row);
          rows.push({ row });
          return;
        }
        const dhead = el('div', 'sh-set-dev', u.name);
        listWrap.appendChild(dhead);
        const childRows = [];
        u.entities.slice().sort((a, b) => domainRank(a.domain) - domainRank(b.domain)).forEach((e) => {
          const row = makeRow(e, entityShortName(e, u.name));
          row.classList.add('sh-set-check--child');
          listWrap.appendChild(row);
          rows.push({ row }); childRows.push(row);
        });
        dhead._rows = childRows;   // so search can hide the header when its rows vanish
      });
    });

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      rows.forEach(({ row }) => { row.hidden = q && !row._match.includes(q); });
      listWrap.querySelectorAll('.sh-set-dev').forEach((h) => { h.hidden = q && (h._rows || []).every((r) => r.hidden); });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  function scan() {
    if (typeof document === 'undefined') return;
    const list = tiles();
    if (!list.length) return;
    seed();   // one-shot first paint with current state
    // Only (re)paint a tile the grid just mounted (empty mount) — live data
    // changes already repaint via onSSE, so we don't rebuild on every DOM mutation.
    const needsPaint = list.some((s) => { const m = s.querySelector('.smarthome-widget-mount'); return m && !m.firstChild; });
    if (needsPaint) paint();
  }

  function init() {
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return; queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  // Re-render the tile(s) in the current language — called by i18n's
  // applyTranslations on a live language switch (the tile is built dynamically,
  // so it isn't covered by the [data-i18n] sweep). Mirrors DiscordWidget.
  function renderWidgets() { sheetSig = ''; if (tiles().length) paint(); else syncSheet(); }

  window.SmartHome = { onSSE, initSettings, renderWidgets };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
