'use strict';
// What the dashboard keeps of a Home Assistant entity, and the checks that tell an entity id, a
// camera and a media player.

// A HA state object is large (full attribute bag). Project it to the compact
// shape the dashboard actually needs, per domain, so the SSE payload stays tiny.
function compactEntity(st, areaFor, deviceFor) {
  if (!st || typeof st !== 'object' || !st.entity_id) return null;
  const id = st.entity_id;
  const domain = id.slice(0, id.indexOf('.'));
  const a = st.attributes || {};
  const out = {
    id,
    domain,
    state: String(st.state == null ? '' : st.state),
    name: a.friendly_name || id,
    area: (typeof areaFor === 'function' ? areaFor(id) : null) || null,
  };
  // The physical HA device this entity belongs to (a TV exposes a media_player +
  // remote + buttons under ONE device) — lets the tile merge them into one card.
  const dev = (typeof deviceFor === 'function') ? deviceFor(id) : null;
  if (dev && dev.id) { out.device = String(dev.id); if (dev.name) out.deviceName = String(dev.name); }
  if (a.unit_of_measurement) out.unit = String(a.unit_of_measurement);
  if (a.device_class) out.deviceClass = String(a.device_class);
  if (a.icon) out.icon = String(a.icon);
  // When the state last CHANGED (not every attribute tick), as epoch ms: lets a
  // widget say "open for 12 minutes" without polling history.
  const changed = Date.parse(st.last_changed);
  if (Number.isFinite(changed)) out.changed = changed;
  // Domain-specific extras — enough for the tile's per-device control panel to
  // render the RIGHT controls (a TV's sources, a thermostat's modes, a fan's
  // speed, a light's colour…), kept compact. `features` carries HA's
  // supported_features bitmask so the client shows only what the device supports.
  const feat = Number.isFinite(a.supported_features) ? a.supported_features : 0;
  const strList = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n) : undefined);
  if (domain === 'light') {
    if (typeof a.brightness === 'number') out.brightness = a.brightness;
    if (Array.isArray(a.rgb_color)) out.rgb = a.rgb_color;
    const modes = strList(a.supported_color_modes, 12); if (modes) out.colorModes = modes;
    if (typeof a.color_temp_kelvin === 'number') out.kelvin = a.color_temp_kelvin;
    if (typeof a.min_color_temp_kelvin === 'number') out.minKelvin = a.min_color_temp_kelvin;
    if (typeof a.max_color_temp_kelvin === 'number') out.maxKelvin = a.max_color_temp_kelvin;
    if (a.effect) out.effect = String(a.effect);
    const ef = strList(a.effect_list, 60); if (ef) out.effects = ef;
  } else if (domain === 'climate') {
    if (a.current_temperature != null) out.current = Number(a.current_temperature);
    if (a.temperature != null) out.target = Number(a.temperature);
    // heat_cool holds two setpoints instead of one.
    if (a.target_temp_low != null) out.targetLow = Number(a.target_temp_low);
    if (a.target_temp_high != null) out.targetHigh = Number(a.target_temp_high);
    if (typeof a.humidity === 'number') out.targetHumidity = a.humidity;
    if (a.min_humidity != null) out.minHumidity = Number(a.min_humidity);
    if (a.max_humidity != null) out.maxHumidity = Number(a.max_humidity);
    const hv = strList(a.hvac_modes, 12); if (hv) out.hvacModes = hv;
    if (a.hvac_action) out.hvacAction = String(a.hvac_action);
    if (a.min_temp != null) out.min = Number(a.min_temp);
    if (a.max_temp != null) out.max = Number(a.max_temp);
    if (a.target_temp_step != null) out.step = Number(a.target_temp_step);
    if (a.fan_mode) out.fanMode = String(a.fan_mode);
    const fm = strList(a.fan_modes, 16); if (fm) out.fanModes = fm;
    if (a.preset_mode) out.presetMode = String(a.preset_mode);
    const pm = strList(a.preset_modes, 16); if (pm) out.presetModes = pm;
    if (a.swing_mode) out.swingMode = String(a.swing_mode);
    const sw = strList(a.swing_modes, 12); if (sw) out.swingModes = sw;
    if (typeof a.current_humidity === 'number') out.currentHumidity = a.current_humidity;
    out.features = feat;
  } else if (domain === 'media_player') {
    if (a.media_title) out.title = String(a.media_title);
    if (a.media_artist) out.artist = String(a.media_artist);
    if (typeof a.volume_level === 'number') out.volume = a.volume_level;
    if (typeof a.is_volume_muted === 'boolean') out.muted = a.is_volume_muted;
    if (a.source) out.source = String(a.source);
    const src = strList(a.source_list, 80); if (src) out.sources = src;
    if (a.sound_mode) out.soundMode = String(a.sound_mode);
    const sm = strList(a.sound_mode_list, 40); if (sm) out.soundModes = sm;
    if (typeof a.shuffle === 'boolean') out.shuffle = a.shuffle;
    if (a.repeat) out.repeat = String(a.repeat);
    if (typeof a.media_position === 'number') out.mediaPos = a.media_position;
    if (typeof a.media_duration === 'number') out.mediaDur = a.media_duration;
    // Whether HA has cover art for what is playing: the picture itself is
    // fetched by the artwork query, never sent on the stream.
    out.art = typeof a.entity_picture === 'string' && a.entity_picture.length > 0;
    const grp = strList(a.group_members, 16); if (grp && grp.length > 1) out.group = grp.filter(isEntityId);
    out.features = feat;
  } else if (domain === 'fan') {
    if (typeof a.percentage === 'number') out.pct = a.percentage;
    if (typeof a.percentage_step === 'number') out.pctStep = a.percentage_step;
    if (a.preset_mode) out.presetMode = String(a.preset_mode);
    const pm = strList(a.preset_modes, 16); if (pm) out.presetModes = pm;
    if (typeof a.oscillating === 'boolean') out.oscillating = a.oscillating;
    if (a.direction) out.direction = String(a.direction);
    out.features = feat;
  } else if (domain === 'cover' || domain === 'valve') {
    if (typeof a.current_position === 'number') out.position = a.current_position;
    if (typeof a.current_tilt_position === 'number') out.tilt = a.current_tilt_position;
    out.features = feat;
  } else if (domain === 'vacuum' || domain === 'lawn_mower') {
    if (a.fan_speed) out.fanSpeed = String(a.fan_speed);
    const fs = strList(a.fan_speed_list, 16); if (fs) out.fanSpeeds = fs;
    if (typeof a.battery_level === 'number') out.battery = a.battery_level;
    out.features = feat;
  } else if (domain === 'humidifier') {
    if (typeof a.humidity === 'number') out.target = a.humidity;
    if (typeof a.current_humidity === 'number') out.current = Number(a.current_humidity);
    if (a.min_humidity != null) out.min = Number(a.min_humidity);
    if (a.max_humidity != null) out.max = Number(a.max_humidity);
    if (a.mode) out.presetMode = String(a.mode);
    const am = strList(a.available_modes, 16); if (am) out.presetModes = am;
    out.features = feat;
  } else if (domain === 'water_heater') {
    if (a.current_temperature != null) out.current = Number(a.current_temperature);
    if (a.temperature != null) out.target = Number(a.temperature);
    if (a.min_temp != null) out.min = Number(a.min_temp);
    if (a.max_temp != null) out.max = Number(a.max_temp);
    if (a.operation_mode) out.presetMode = String(a.operation_mode);
    const om = strList(a.operation_list, 16); if (om) out.presetModes = om;
    if (a.away_mode) out.awayMode = String(a.away_mode);
    out.features = feat;
  } else if (domain === 'alarm_control_panel') {
    if (typeof a.code_arm_required === 'boolean') out.codeArm = a.code_arm_required;
    if (a.code_format) out.codeFormat = String(a.code_format);
    out.features = feat;
  } else if (domain === 'number' || domain === 'input_number') {
    if (a.min != null) out.min = Number(a.min);
    if (a.max != null) out.max = Number(a.max);
    if (a.step != null) out.step = Number(a.step);
  } else if (domain === 'select' || domain === 'input_select') {
    const opts = strList(a.options, 80); if (opts) out.options = opts;
  } else if (domain === 'sensor') {
    // Whether the recorder keeps long-term statistics for it (measurement,
    // total…) — a widget uses it to decide if a history trace is worth asking for.
    if (a.state_class) out.stateClass = String(a.state_class);
  } else if (domain === 'weather') {
    if (typeof a.temperature === 'number') out.temperature = a.temperature;
    if (a.temperature_unit) out.tempUnit = String(a.temperature_unit);
    if (typeof a.humidity === 'number') out.humidity = a.humidity;
    if (typeof a.wind_speed === 'number') out.windSpeed = a.wind_speed;
    if (a.wind_speed_unit) out.windUnit = String(a.wind_speed_unit);
  }
  // person / device_tracker: the state ("home", "not_home", a zone name) is all
  // that leaves. Their latitude/longitude/gps_accuracy attributes are where
  // someone IS, and no tile or widget needs that to say "Marco is home".
  return out;
}

// entity_id shape: "<domain>.<object_id>", lowercase word chars only. This is the
// only free-form string that reaches call_service, so it is strictly validated.
function isEntityId(s) {
  return typeof s === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(s.trim());
}

// A camera entity id ("camera.<object_id>") — the strict subset of isEntityId the
// Cameras tile shows and the snapshot proxy interpolates into the camera_proxy
// path. Kept separate so a stray non-camera entity can never be snapshot-proxied.
function isCameraEntity(s) {
  return isEntityId(s) && /^camera\./.test(String(s).trim());
}

function isMediaPlayerEntity(s) {
  return isEntityId(s) && /^media_player\./.test(String(s).trim());
}

module.exports = { compactEntity, isEntityId, isCameraEntity, isMediaPlayerEntity };
