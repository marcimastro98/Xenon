// How the smart home tile words a device: its state, its numbers with their unit, the name of its
// kind, and the short summary and readings a card shows.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const SHEET_DOMAINS = new Set(['media_player', 'light', 'fan', 'cover', 'climate', 'vacuum', 'humidifier', 'water_heater', 'alarm_control_panel', 'valve', 'lawn_mower', 'number', 'input_number', 'select', 'input_select']);

  // Underscored HA enum → "Nice case" fallback when we have no explicit translation.
  function prettify(s) { const v = String(s == null ? '' : s).replace(/_/g, ' ').trim(); return v ? v.charAt(0).toUpperCase() + v.slice(1) : v; }

  function fmtNum(v) { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : String(v); }

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

  // A light on with a brightness reading reads "On · 80%"; others just On/Off.
  function stateLabel(e) {
    const on = isOn(e);
    if (e.domain === 'light' && on && Number.isFinite(e.brightness)) return t('smarthome_on', 'On') + ' · ' + Math.round(e.brightness / 255 * 100) + '%';
    return on ? t('smarthome_on', 'On') : t('smarthome_off', 'Off');
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

  // Up to three live readings of a device's sensors ("820 ppm · 21.8° · 55%"),
  // so an air monitor or a weather station reads at a glance, without a tap.
  const CARD_READINGS = 3;

  function deviceReadings(ents) {
    return ents
      .filter((x) => x.domain === 'sensor' && String(x.state == null ? '' : x.state).trim() !== '' && Number.isFinite(Number(x.state)))
      .slice(0, CARD_READINGS)
      .map((x) => {
        const unit = x.unit || '';
        const tight = unit === '%' || unit.charAt(0) === '°';
        return fmtNum(x.state) + (unit ? (tight ? '' : ' ') + unit : '');
      });
  }

  function deviceSummary(pe) {
    if (pe.domain === 'media_player') return pe.title || (pe.state && !['off', 'unavailable', 'unknown', 'idle', ''].includes(pe.state) ? friendlyState(pe) : t('smarthome_off'));
    if (SHEET_DOMAINS.has(pe.domain)) return controlSummary(pe);
    return friendlyState(pe);
  }

  window.SmartHomeStateWords = {
    t, SHEET_DOMAINS, prettify, fmtNum, isOn, splitValue, friendlyState, fmtHvac, domainLabel,
    stateLabel, controlSummary, deviceReadings, deviceSummary,
  };
})();
