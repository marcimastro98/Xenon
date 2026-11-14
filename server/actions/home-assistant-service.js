'use strict';
// Turns an action of a Deck key, a tile or the assistant into the Home Assistant service call
// that does it, refusing values a service would not take.

const { isEntityId } = require('./home-assistant-entity.js');

// Map a validated Deck HA action to a concrete { domain, service, target, data },
// or null if it can't. Kept pure so the registry stays a thin dispatcher.
// A key's or a widget's numeric `value` param. Empty or whitespace is "no value"
// (null), never 0: Number('') is 0, and a blank must not become an off command.
function actionNumber(raw, min, max) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const n = Number(text.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

const HVAC_MODES = Object.freeze(['off', 'heat', 'cool', 'auto', 'dry', 'fan_only', 'heat_cool']);
const REPEAT_MODES = Object.freeze(['off', 'all', 'one']);

const tenths = (n) => Math.round(n * 10) / 10;
const stateAttrs = (st) => (st && typeof st === 'object' && st.attributes && typeof st.attributes === 'object' ? st.attributes : null);

// A value the entity itself lists (a source, a sound mode, a fan mode…), or
// null. Without the entity's list there is nothing to check against, so null:
// a free string never reaches HA as an option.
function listed(raw, list) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || !Array.isArray(list)) return null;
  return list.includes(v) ? v : null;
}

// "on"/"off" (or true/false, 1/0); empty flips the current state.
function onOff(raw, current) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return !current;
  if (['on', 'true', '1'].includes(v)) return true;
  if (['off', 'false', '0'].includes(v)) return false;
  return null;
}

// off | all | one; empty steps to the next one after the current mode.
function repeatMode(raw, current) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v) return REPEAT_MODES.includes(v) ? v : null;
  const i = REPEAT_MODES.indexOf(String(current || 'off'));
  return REPEAT_MODES[(i + 1) % REPEAT_MODES.length];
}

// A heat_cool range as "low-high" ("20-24", "19.5 – 23", "-2/4"), low below high.
function tempRange(raw) {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(?:-|–|\/)\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(String(raw == null ? '' : raw));
  if (!m) return null;
  const low = actionNumber(m[1], -50, 120);
  const high = actionNumber(m[2], -50, 120);
  return low != null && high != null && low < high ? { low: tenths(low), high: tenths(high) } : null;
}

// `state` is the target entity's raw HA state when the caller has it: the
// options a device lists (sources, fan modes…) are checked against it.
function actionToServiceCall(action, state) {
  if (!action || typeof action !== 'object') return null;
  const entity = String(action.entity == null ? '' : action.entity).trim();
  if (action.type === 'haToggle') {
    if (!isEntityId(entity)) return null;
    const service = action.mode === 'on' ? 'turn_on' : action.mode === 'off' ? 'turn_off' : 'toggle';
    return { domain: 'homeassistant', service, target: { entity_id: entity }, data: {} };
  }
  if (action.type === 'haScene') {
    if (!isEntityId(entity)) return null;
    return { domain: 'scene', service: 'turn_on', target: { entity_id: entity }, data: {} };
  }
  if (action.type === 'haScript') {
    if (!isEntityId(entity)) return null;
    return { domain: 'script', service: 'turn_on', target: { entity_id: entity }, data: {} };
  }
  if (action.type === 'haButton') {
    if (!isEntityId(entity)) return null;
    return { domain: 'button', service: 'press', target: { entity_id: entity }, data: {} };
  }
  // The device-specific quick actions below all target ONE entity and map a
  // constrained `mode`/`cmd` (already coerced to a catalog option) to a concrete
  // service — no free-form service string ever reaches HA from these.
  if (action.type === 'haLight') {
    if (!isEntityId(entity)) return null;
    const target = { entity_id: entity };
    if (action.mode === 'on') return { domain: 'light', service: 'turn_on', target, data: {} };
    if (action.mode === 'off') return { domain: 'light', service: 'turn_off', target, data: {} };
    if (action.mode === 'brighter') return { domain: 'light', service: 'turn_on', target, data: { brightness_step_pct: 15 } };
    if (action.mode === 'dimmer') return { domain: 'light', service: 'turn_on', target, data: { brightness_step_pct: -15 } };
    if (action.mode === 'brightness') {
      // Absolute brightness for slider keys: 0–100% (clamped; 0 turns the light
      // off). Empty/whitespace rejects loud — Number('') is 0, and a key saved
      // with a blank value must NOT become a turn-off command.
      const rawPct = String(action.value == null ? '' : action.value).trim();
      if (!rawPct) return null;
      const pct = Number(rawPct.replace(',', '.'));
      if (!Number.isFinite(pct)) return null;
      const clamped = Math.min(100, Math.max(0, Math.round(pct)));
      if (clamped === 0) return { domain: 'light', service: 'turn_off', target, data: {} };
      return { domain: 'light', service: 'turn_on', target, data: { brightness_pct: clamped } };
    }
    if (action.mode === 'kelvin') {
      const k = actionNumber(action.value, 1000, 12000);
      return k == null ? null : { domain: 'light', service: 'turn_on', target, data: { color_temp_kelvin: Math.round(k) } };
    }
    return { domain: 'light', service: 'toggle', target, data: {} };
  }
  if (action.type === 'haMedia') {
    if (!isEntityId(entity)) return null;
    const target = { entity_id: entity };
    const call = (service, data) => ({ domain: 'media_player', service, target, data: data || {} });
    const attrs = stateAttrs(state);
    if (action.cmd === 'mute') return call('volume_mute', { is_volume_muted: true });
    if (action.cmd === 'unmute') return call('volume_mute', { is_volume_muted: false });
    if (action.cmd === 'volume_set') {
      const pct = actionNumber(action.value, 0, 100);
      return pct == null ? null : call('volume_set', { volume_level: Math.round(pct) / 100 });
    }
    if (action.cmd === 'on') return call('turn_on');
    if (action.cmd === 'off') return call('turn_off');
    if (action.cmd === 'source') {
      const source = listed(action.value, attrs && attrs.source_list);
      return source == null ? null : call('select_source', { source });
    }
    if (action.cmd === 'sound_mode') {
      const mode = listed(action.value, attrs && attrs.sound_mode_list);
      return mode == null ? null : call('select_sound_mode', { sound_mode: mode });
    }
    if (action.cmd === 'seek') {
      const at = actionNumber(action.value, 0, 86400);
      return at == null ? null : call('media_seek', { seek_position: Math.round(at) });
    }
    if (action.cmd === 'shuffle') {
      const on = onOff(action.value, attrs && attrs.shuffle === true);
      return on == null ? null : call('shuffle_set', { shuffle: on });
    }
    if (action.cmd === 'repeat') {
      const mode = repeatMode(action.value, attrs && attrs.repeat);
      return mode == null ? null : call('repeat_set', { repeat: mode });
    }
    const map = { playpause: 'media_play_pause', next: 'media_next_track', previous: 'media_previous_track', stop: 'media_stop', volume_up: 'volume_up', volume_down: 'volume_down' };
    return map[action.cmd] ? call(map[action.cmd]) : null;
  }
  if (action.type === 'haCover') {
    if (!isEntityId(entity)) return null;
    if (action.cmd === 'position') {
      const pos = actionNumber(action.value, 0, 100);
      return pos == null ? null : { domain: 'cover', service: 'set_cover_position', target: { entity_id: entity }, data: { position: Math.round(pos) } };
    }
    const map = { open: 'open_cover', close: 'close_cover', stop: 'stop_cover', toggle: 'toggle' };
    return { domain: 'cover', service: map[action.cmd] || 'toggle', target: { entity_id: entity }, data: {} };
  }
  if (action.type === 'haClimate') {
    if (!isEntityId(entity)) return null;
    const call = (service, data) => ({ domain: 'climate', service, target: { entity_id: entity }, data });
    const attrs = stateAttrs(state);
    if (action.mode === 'temperature') {
      // The setpoint in the unit HA is configured for; the bounds only stop a
      // typo, HA itself clamps to the device's own min/max.
      const t = actionNumber(action.value, -50, 120);
      return t == null ? null : call('set_temperature', { temperature: tenths(t) });
    }
    if (action.mode === 'range') {
      const r = tempRange(action.value);
      return r ? call('set_temperature', { target_temp_low: r.low, target_temp_high: r.high }) : null;
    }
    if (action.mode === 'humidity') {
      const h = actionNumber(action.value, 0, 100);
      return h == null ? null : call('set_humidity', { humidity: Math.round(h) });
    }
    const pick = { fan_mode: ['fan_modes', 'set_fan_mode'], swing_mode: ['swing_modes', 'set_swing_mode'], preset: ['preset_modes', 'set_preset_mode'] }[action.mode];
    if (pick) {
      const v = listed(action.value, attrs && attrs[pick[0]]);
      return v == null ? null : call(pick[1], { [action.mode === 'preset' ? 'preset_mode' : action.mode]: v });
    }
    // An HVAC mode. Anything this list does not name is refused, never turned
    // into 'off'; one the device does not offer is refused too, when we know.
    if (!HVAC_MODES.includes(action.mode)) return null;
    const offered = attrs && Array.isArray(attrs.hvac_modes) ? attrs.hvac_modes : null;
    if (offered && !offered.includes(action.mode)) return null;
    return call('set_hvac_mode', { hvac_mode: action.mode });
  }
  if (action.type === 'haFan') {
    if (!isEntityId(entity)) return null;
    const service = action.mode === 'on' ? 'turn_on' : action.mode === 'off' ? 'turn_off' : 'toggle';
    return { domain: 'fan', service, target: { entity_id: entity }, data: {} };
  }
  if (action.type === 'haVacuum') {
    if (!isEntityId(entity)) return null;
    const map = { start: 'start', pause: 'pause', stop: 'stop', return: 'return_to_base', locate: 'locate' };
    return { domain: 'vacuum', service: map[action.cmd] || 'start', target: { entity_id: entity }, data: {} };
  }
  if (action.type === 'haLock') {
    if (!isEntityId(entity)) return null;
    return { domain: 'lock', service: action.mode === 'unlock' ? 'unlock' : 'lock', target: { entity_id: entity }, data: {} };
  }
  if (action.type === 'haAlarm') {
    if (!isEntityId(entity)) return null;
    const map = { arm_home: 'alarm_arm_home', arm_away: 'alarm_arm_away', arm_night: 'alarm_arm_night', disarm: 'alarm_disarm' };
    const data = {};
    const code = String(action.code == null ? '' : action.code).trim();
    if (code) data.code = code;
    return { domain: 'alarm_control_panel', service: map[action.mode] || 'alarm_disarm', target: { entity_id: entity }, data };
  }
  if (action.type === 'haCallService') {
    const svc = String(action.service == null ? '' : action.service).trim();
    const m = /^([a-z_]+)\.([a-z0-9_]+)$/.exec(svc);
    if (!m) return null;
    let data = {};
    const raw = String(action.data == null ? '' : action.data).trim();
    if (raw) { try { const p = JSON.parse(raw); if (p && typeof p === 'object' && !Array.isArray(p)) data = p; } catch (e) { return null; } }
    const call = { domain: m[1], service: m[2], data };
    if (isEntityId(entity)) call.target = { entity_id: entity };
    return call;
  }
  return null;
}

module.exports = {
  actionNumber, HVAC_MODES, REPEAT_MODES, tenths, stateAttrs, listed, onOff, repeatMode, tempRange,
  actionToServiceCall,
};
