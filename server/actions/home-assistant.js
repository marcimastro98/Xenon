'use strict';
// Lazy Home Assistant WebSocket client + pure helpers. Mirrors the shape of
// actions/obs.js: connects on demand, authenticates with a long-lived access
// token, can fetch states / call a service, and — while a listener is attached
// (a dashboard tile is on screen) — keeps ONE live connection that pushes state
// changes via `subscribe_events`. Idle-closes when nobody is watching, so it
// costs nothing when the Smart Home tile isn't in use.
//
// Design invariants (see .claude/CLAUDE.md):
//   - The long-lived token stays server-side; only booleans/compact state reach
//     the browser (server projects the snapshot before broadcasting).
//   - Never throws out of the public surface — errors degrade to {ok:false}.
//   - No synchronous work on the event loop; all I/O is the async WS.
//
// Cameras are the ONE exception to "everything over the WS": the WS API can't
// stream image bytes, so a camera snapshot is a plain authenticated HTTP GET to
// HA's /api/camera_proxy/<entity> (helper below). That single REST path covers
// EVERY camera HA supports — TAPO, Reolink, ONVIF, generic MJPEG, Ring… — because
// HA normalizes them all to the `camera` domain and does the RTSP transcoding
// itself, exposing a uniform JPEG snapshot.
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

// ---- pure helpers (also unit-tested) ---------------------------------------

// Turn a user-entered base URL ("http://192.168.1.5:8123", "https://ha.me") into
// the WebSocket API endpoint, or '' if it isn't a plain http(s) URL. A non-http
// scheme (file:, javascript:, ws:) is rejected — the token must only ever be
// sent to a real HA HTTP origin the user typed.
function haWsUrl(baseUrl) {
  const v = String(baseUrl == null ? '' : baseUrl).trim();
  if (!/^https?:\/\/\S+$/i.test(v)) return '';
  let u;
  try { u = new URL(v); } catch (e) { return ''; }
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + u.host + '/api/websocket';
}

// The HTTP(S) origin ("https://ha.me[:port]") for the same base URL, or '' if it
// isn't a plain http(s) URL. Used for the REST camera-proxy snapshot fetch. TLS
// validation is left at the default — a self-signed HA the WS client already
// can't reach over wss wouldn't authenticate here either, so there's nothing to
// gain by relaxing it (and every reason not to).
function haHttpOrigin(baseUrl) {
  const v = String(baseUrl == null ? '' : baseUrl).trim();
  if (!/^https?:\/\/\S+$/i.test(v)) return '';
  let u;
  try { u = new URL(v); } catch (e) { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return u.protocol + '//' + u.host;
}

// Authenticated GET returning the raw body Buffer (used for camera snapshots).
// Resolves the bytes on 2xx, rejects on any other status or transport failure.
// Capped: camera_proxy is expected to answer with ONE JPEG; an endpoint that
// streams instead (MJPEG, misrouted proxy) would keep resetting the inactivity
// timeout while the buffer grew without bound, so bail past a snapshot-sized cap.
const HA_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;
function haHttpGetBuffer(urlStr, token) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('ha_bad_url')); return; }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const rq = lib.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: { Authorization: 'Bearer ' + token, Accept: 'image/jpeg' },
      timeout: 8000,
    }, (rs) => {
      const status = rs.statusCode || 0;
      const chunks = [];
      let size = 0;
      rs.on('data', (d) => {
        size += d.length;
        if (size > HA_SNAPSHOT_MAX_BYTES) { rq.destroy(new Error('ha_snapshot_too_large')); return; }
        chunks.push(d);
      });
      rs.on('end', () => {
        if (status < 200 || status >= 300) { reject(new Error('ha_snapshot_' + status)); return; }
        resolve(Buffer.concat(chunks));
      });
    });
    rq.on('error', (e) => reject(e));
    rq.on('timeout', () => rq.destroy(new Error('ha_timeout')));
    rq.end();
  });
}

function isConfigured(cfg) {
  return !!(cfg && haWsUrl(cfg.baseUrl) && String(cfg.token || '').trim());
}

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
  }
  return out;
}

// Map a validated Deck HA action to a concrete { domain, service, target, data },
// or null if it can't. Kept pure so the registry stays a thin dispatcher.
function actionToServiceCall(action) {
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
    return { domain: 'light', service: 'toggle', target, data: {} };
  }
  if (action.type === 'haMedia') {
    if (!isEntityId(entity)) return null;
    const target = { entity_id: entity };
    if (action.cmd === 'mute') return { domain: 'media_player', service: 'volume_mute', target, data: { is_volume_muted: true } };
    if (action.cmd === 'unmute') return { domain: 'media_player', service: 'volume_mute', target, data: { is_volume_muted: false } };
    const map = { playpause: 'media_play_pause', next: 'media_next_track', previous: 'media_previous_track', stop: 'media_stop', volume_up: 'volume_up', volume_down: 'volume_down' };
    return { domain: 'media_player', service: map[action.cmd] || 'media_play_pause', target, data: {} };
  }
  if (action.type === 'haCover') {
    if (!isEntityId(entity)) return null;
    const map = { open: 'open_cover', close: 'close_cover', stop: 'stop_cover', toggle: 'toggle' };
    return { domain: 'cover', service: map[action.cmd] || 'toggle', target: { entity_id: entity }, data: {} };
  }
  if (action.type === 'haClimate') {
    if (!isEntityId(entity)) return null;
    const mode = ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'].includes(action.mode) ? action.mode : 'off';
    return { domain: 'climate', service: 'set_hvac_mode', target: { entity_id: entity }, data: { hvac_mode: mode } };
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

// ---- settings normalization + token secrecy --------------------------------
// The `homeAssistant` settings sub-object: { url, token, entities }. url/entities
// are client-visible; the long-lived token is a SERVER-ONLY secret handled with
// the same preserve-on-save / redact-on-wire pattern as the remote-control creds.
const HA_MAX_ENTITIES = 100;
const HA_MAX_CAMERAS = 60;
const HA_CAM_ROTATIONS = Object.freeze([0, 90, 180, 270]);

function clampHaPan(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(-100, Math.round(n))) : 0;
}

// Per-camera view transform { [cameraEntity]: { rot, flip, zoom?, panX?, panY? } }
// — mirrors actions/unifi.js normalizeUnifiAngles but keyed by camera entity id.
// A fully neutral entry is dropped so the map stays lean. This transforms the
// SHOWN snapshot only; no command is ever sent to Home Assistant.
function normalizeHaCamAngles(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  let n = 0;
  for (const id of Object.keys(value)) {
    if (n >= HA_MAX_CAMERAS) break;
    if (!isCameraEntity(id)) continue;
    const a = value[id];
    if (!a || typeof a !== 'object') continue;
    const rot = HA_CAM_ROTATIONS.includes(a.rot) ? a.rot : 0;
    const flip = a.flip === 1 || a.flip === true ? 1 : 0;
    const z = Number(a.zoom);
    const zoom = Number.isFinite(z) ? Math.min(3, Math.max(1, Math.round(z * 100) / 100)) : 1;
    if (!rot && !flip && zoom <= 1) continue;     // fully neutral → omit
    const entry = { rot, flip };
    if (zoom > 1) {
      entry.zoom = zoom;
      const panX = clampHaPan(a.panX), panY = clampHaPan(a.panY);
      if (panX) entry.panX = panX;
      if (panY) entry.panY = panY;
    }
    out[id] = entry;
    n++;
  }
  return out;
}

function normalizeHomeAssistant(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const url = String(src.url == null ? '' : src.url).trim().slice(0, 200);
  const entities = Array.isArray(src.entities)
    ? src.entities.filter(isEntityId).filter((v, i, a) => a.indexOf(v) === i).slice(0, HA_MAX_ENTITIES)
    : [];
  // Cameras the user chose to show on the Cameras tile — OPT-IN (empty = show
  // none), so connecting HA for smart-home control never dumps every camera onto
  // the dashboard. The array is BOTH the selection and the display order.
  const cameras = Array.isArray(src.cameras)
    ? src.cameras.filter(isCameraEntity).filter((v, i, a) => a.indexOf(v) === i).slice(0, HA_MAX_CAMERAS)
    : [];
  return {
    url: haWsUrl(url) ? url : '',                    // keep only a valid http(s) HA URL
    token: typeof src.token === 'string' ? src.token.slice(0, 400) : '',
    entities,
    cameras,
    camAngles: normalizeHaCamAngles(src.camAngles),
  };
}

// Protect the persisted Home Assistant config against a client save. Two cases:
//   - payload has NO homeAssistant block (older/partial/programmatic client):
//     keep the whole persisted block (url + entities + token) so nothing is wiped.
//   - payload HAS the block (the normal client, which owns url/entities but never
//     receives the real token): carry the persisted token over when it's empty.
function preserveHaToken(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const prevHa = (prev && typeof prev === 'object' && prev.homeAssistant) || {};
  const hasBlock = incoming.homeAssistant && typeof incoming.homeAssistant === 'object';
  if (!hasBlock) {
    if (prevHa.url || prevHa.token || (Array.isArray(prevHa.entities) && prevHa.entities.length)) {
      incoming.homeAssistant = { ...prevHa };
    }
    return incoming;
  }
  if (prevHa.token && !incoming.homeAssistant.token) incoming.homeAssistant.token = prevHa.token;
  return incoming;
}

// Blank the token before settings reach the browser; expose only a `tokenSet`
// boolean so the UI can show a "saved" placeholder. Returns a shallow copy.
function redactHaToken(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const ha = settings.homeAssistant;
  if (!ha || typeof ha !== 'object') return settings;
  return {
    ...settings,
    homeAssistant: {
      url: ha.url || '',
      entities: Array.isArray(ha.entities) ? ha.entities : [],
      // Camera selection + per-camera view transforms are NOT secrets — carry them
      // to the browser (already normalized on save). Missing them here would strip
      // the user's chosen cameras on every settings round-trip.
      cameras: Array.isArray(ha.cameras) ? ha.cameras : [],
      camAngles: (ha.camAngles && typeof ha.camAngles === 'object') ? ha.camAngles : {},
      token: '',
      tokenSet: !!ha.token,
    },
  };
}

// ---- lazy connection --------------------------------------------------------

// getConfig: async () -> { baseUrl, token }. Returns a client whose socket is
// shared, idle-closed, and (via watch) auto-reconnected.
function createHomeAssistant(getConfig) {
  let ws = null;
  let ready = null;              // Promise<void> resolved once auth_ok
  let idleTimer = null;
  let pingTimer = null;
  let retryTimer = null;
  let reconnectDelay = 2000;     // exponential backoff, reset on a good connection
  let msgId = 0;                 // per-connection incrementing command id
  const pending = new Map();     // id -> { resolve, reject, timer }
  const states = new Map();      // entity_id -> HA state object (kept fresh)
  let areaMap = new Map();       // entity_id -> area name
  let deviceMap = new Map();     // entity_id -> { id, name } of its physical device
  let watching = false;          // hold the socket open + reconnect while true
  let onChange = null;           // callback() debounced-ish notify on state change
  const IDLE_MS = 60000;
  const PING_MS = 30000;

  function clearPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

  function close() {
    if (!ws && !idleTimer && pending.size === 0 && !pingTimer && !retryTimer) return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // Clear any pending reconnect too — a public close() during the reconnect
    // window must not later resurrect the socket. (Callers that intend to keep
    // watching set watching=false first, e.g. the watch() stop fn.)
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    clearPing();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null; ready = null;
    pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('ha_closed')); });
    pending.clear();
  }

  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    // While watching we hold the connection open indefinitely (no idle-close).
    idleTimer = watching ? null : setTimeout(close, IDLE_MS);
  }

  function scheduleReconnect() {
    if (!watching || retryTimer) return;
    // Exponential backoff (2s→30s) instead of a flat 8s hammer: a Deck key watching
    // an offline HA shouldn't retry at a fixed rate all day. Reset on a good connect.
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    retryTimer = setTimeout(() => { retryTimer = null; if (watching) startWatchConn(); }, delay);
  }

  function connect() {
    if (ready) return ready;
    // Assign `ready` synchronously so concurrent callers share one handshake.
    ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; if (err) { reject(err); close(); } else resolve(); };
      Promise.resolve().then(getConfig).then((cfg) => {
        if (settled) return;
        const c = cfg || {};
        const url = haWsUrl(c.baseUrl);
        const token = String(c.token || '').trim();
        if (!url || !token) { done(new Error('ha_not_configured')); return; }
        msgId = 0;
        let sock;
        try { sock = new WebSocket(url); } catch (e) { done(e); return; }
        ws = sock;
        const timer = setTimeout(() => done(new Error('ha_timeout')), 8000);
        sock.on('error', () => { clearTimeout(timer); done(new Error('ha_connect_failed')); });
        sock.on('close', () => {
          clearTimeout(timer);
          if (!settled) done(new Error('ha_closed'));
          else { close(); if (watching) scheduleReconnect(); }
        });
        sock.on('message', (raw) => {
          let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
          if (!msg) return;
          if (msg.type === 'auth_required') {
            try { sock.send(JSON.stringify({ type: 'auth', access_token: token })); } catch (e) { done(new Error('ha_send_failed')); }
          } else if (msg.type === 'auth_ok') {
            clearTimeout(timer); reconnectDelay = 2000; bumpIdle(); done();
          } else if (msg.type === 'auth_invalid') {
            clearTimeout(timer); done(new Error('ha_auth_invalid'));
          } else if (msg.type === 'result' || msg.type === 'pong') {
            // HA answers a command with {type:'result'} and a `ping` with
            // {type:'pong'} — both carry the request id and settle its pending
            // entry (so the keepalive ping actually resolves instead of orphaning
            // until timeout, which is what lets it detect a dead socket).
            const p = pending.get(msg.id);
            if (p) {
              pending.delete(msg.id); clearTimeout(p.timer);
              if (msg.type === 'pong' || msg.success) p.resolve(msg.result);
              else p.reject(new Error((msg.error && msg.error.message) || 'ha_request_failed'));
            }
            bumpIdle();
          } else if (msg.type === 'event') {
            applyEvent(msg.event);
          }
        });
      }, (e) => done(e instanceof Error ? e : new Error('ha_config_failed')));
    });
    ready.catch(() => {});         // no unhandled rejection if nothing awaits yet
    return ready;
  }

  function request(type, extra) {
    return connect().then(() => new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('ha_request_timeout')); }, 8000);
      pending.set(id, { resolve, reject, timer });
      bumpIdle();
      try { ws.send(JSON.stringify(Object.assign({ id, type }, extra || {}))); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    }));
  }

  // A state_changed event carries the full new_state; keep the local cache fresh
  // and notify the watcher. Unknown/entity-removed events drop the entity.
  function applyEvent(event) {
    const data = event && event.data;
    if (!data || !data.entity_id) return;
    if (data.new_state) states.set(data.entity_id, data.new_state);
    else states.delete(data.entity_id);
    if (onChange) { try { onChange(); } catch (e) { /* ignore */ } }
  }

  // Fetch the entity→area map once per connection (areas change rarely). Best
  // effort: if the registry commands aren't permitted, grouping falls back to
  // domain and nothing breaks.
  async function loadAreas() {
    try {
      const [areas, devices, entReg] = await Promise.all([
        request('config/area_registry/list').catch(() => []),
        request('config/device_registry/list').catch(() => []),
        request('config/entity_registry/list').catch(() => []),
      ]);
      const areaName = new Map((Array.isArray(areas) ? areas : []).map((a) => [a.area_id, a.name]));
      // device_id -> { name, area_id }; name_by_user (the user's rename) wins.
      const devInfo = new Map();
      for (const d of (Array.isArray(devices) ? devices : [])) {
        if (!d || !d.id) continue;
        devInfo.set(d.id, { name: d.name_by_user || d.name || '', area_id: d.area_id || null });
      }
      const nextArea = new Map();
      const nextDevice = new Map();
      for (const e of (Array.isArray(entReg) ? entReg : [])) {
        if (!e || !e.entity_id) continue;
        const dev = e.device_id ? devInfo.get(e.device_id) : null;
        // Entity area, falling back to the device's area (now actually resolved).
        const aid = e.area_id || (dev ? dev.area_id : null) || null;
        const nm = aid ? areaName.get(aid) : null;
        if (nm) nextArea.set(e.entity_id, nm);
        if (e.device_id) nextDevice.set(e.entity_id, { id: e.device_id, name: (dev && dev.name) || '' });
      }
      areaMap = nextArea;
      deviceMap = nextDevice;
    } catch (e) { /* keep whatever we had */ }
  }

  // Fetch the full state + area map once (events only fire on change). Used by the
  // one-shot reads (listEntities/test) which then idle-close normally — so this
  // deliberately does NOT subscribe or start the keepalive ping (that would bump
  // the idle timer forever and defeat the idle-close).
  async function seedStates() {
    const all = await request('get_states');
    states.clear();
    for (const st of (Array.isArray(all) ? all : [])) { if (st && st.entity_id) states.set(st.entity_id, st); }
    await loadAreas();
    if (onChange) { try { onChange(); } catch (e) { /* ignore */ } }
  }

  // Watch path: seed, then subscribe to live changes and hold the socket open with
  // a keepalive ping (only while watching — idle-close is disabled in this mode).
  async function seedAndSubscribe() {
    await seedStates();
    await request('subscribe_events', { event_type: 'state_changed' });
    clearPing();
    // Keepalive: a ping that fails (no pong before its timeout — e.g. a half-open
    // socket after a Wi-Fi/router drop that never raised 'close') force-closes the
    // socket so the 'close' handler fires and, while watching, reconnects.
    pingTimer = setInterval(() => {
      request('ping').catch(() => { if (watching && ws) { try { ws.close(); } catch (e) { /* ignore */ } } });
    }, PING_MS);
  }

  function startWatchConn() {
    connect().then(seedAndSubscribe).catch(() => scheduleReconnect());
  }

  // ---- public surface -------------------------------------------------------

  // All entities as compact objects (for the Settings device picker). Ensures a
  // live connection + fresh cache first.
  async function listEntities() {
    if (!states.size || !ws) { await connect(); await seedStates(); }
    const out = [];
    for (const st of states.values()) { const c = compactEntity(st, (id) => areaMap.get(id), (id) => deviceMap.get(id)); if (c) out.push(c); }
    out.sort((a, b) => (a.area || '~').localeCompare(b.area || '~') || a.name.localeCompare(b.name));
    return out;
  }

  // Camera entities as compact { id, name, connected, area } for the Cameras tile.
  // Ensures a live connection + seeded cache first (mirrors listEntities), then
  // filters the camera domain. `connected` is false only when HA marks the camera
  // unavailable; the snapshot itself is the real liveness signal.
  //
  // TTL cache: the Cameras tile polls this every 30s — shorter than the 60s
  // idle-close — so without a cache every poll would revive the socket and re-seed
  // the FULL entity state forever (dial → seed → idle-close → re-dial churn).
  // Camera names/areas change rarely; serve the last list while the socket is
  // idle and only reconnect once the cache has gone stale.
  const CAMERAS_TTL_MS = 5 * 60 * 1000;
  let camerasCache = { list: null, at: 0 };
  async function cameras() {
    if (!states.size || !ws) {
      if (camerasCache.list && (Date.now() - camerasCache.at) < CAMERAS_TTL_MS) return camerasCache.list;
      await connect(); await seedStates();
    }
    const out = [];
    for (const st of states.values()) {
      if (!st || !st.entity_id || !isCameraEntity(st.entity_id)) continue;
      const a = st.attributes || {};
      out.push({
        id: st.entity_id,
        name: String(a.friendly_name || st.entity_id).slice(0, 80),
        connected: String(st.state == null ? '' : st.state) !== 'unavailable',
        area: areaMap.get(st.entity_id) || null,
      });
    }
    out.sort((a, b) => (a.area || '~').localeCompare(b.area || '~') || a.name.localeCompare(b.name));
    camerasCache = { list: out, at: Date.now() };
    return out;
  }

  // One JPEG snapshot for a camera entity (Buffer), via HA's REST camera_proxy —
  // the WS API can't stream image bytes. The long-lived token is read fresh from
  // config on each call and sent only as a Bearer header to the HA origin the user
  // typed; only the JPEG bytes leave here (streamed by the loopback proxy). Throws
  // on a bad entity, missing config, or a non-2xx response.
  async function cameraSnapshot(entityId) {
    if (!isCameraEntity(entityId)) throw new Error('ha_bad_camera');
    const cfg = (await Promise.resolve().then(getConfig)) || {};
    const origin = haHttpOrigin(cfg.baseUrl);
    const token = String(cfg.token || '').trim();
    if (!origin || !token) throw new Error('ha_not_configured');
    const url = origin + '/api/camera_proxy/' + encodeURIComponent(String(entityId).trim());
    return haHttpGetBuffer(url, token);
  }

  // Compact snapshot for the given entity ids (tile/SSE). Missing ids are simply
  // absent. Called with the user's selection from settings.
  function snapshot(entityIds) {
    const ids = Array.isArray(entityIds) ? entityIds : [];
    const out = [];
    for (const id of ids) {
      const st = states.get(id);
      const c = st ? compactEntity(st, (x) => areaMap.get(x), (x) => deviceMap.get(x)) : null;
      if (c) out.push(c);
    }
    return out;
  }

  function hasStates() { return states.size > 0; }
  // Whether a live socket is currently open (not merely whether we have a cached
  // snapshot) — so a state read after an idle-close reports connected:false rather
  // than showing stale values as if live.
  function isConnected() { return !!ws; }

  // Execute a validated Deck HA action. Returns {ok} — never throws.
  async function runAction(action) {
    const call = actionToServiceCall(action);
    if (!call) return { ok: false, error: 'bad_ha_action' };
    return callService(call.domain, call.service, call.target, call.data);
  }

  async function callService(domain, service, target, data) {
    if (!/^[a-z_]+$/.test(String(domain)) || !/^[a-z0-9_]+$/.test(String(service))) return { ok: false, error: 'bad_service' };
    try {
      const extra = { domain, service, service_data: data || {} };
      if (target && target.entity_id && isEntityId(target.entity_id)) extra.target = { entity_id: target.entity_id };
      await request('call_service', extra);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'ha_call_failed' };
    }
  }

  // Verify config by opening a connection and seeding once. Returns a compact
  // status used by the Settings "Connect" button.
  async function test() {
    try {
      await connect();
      if (!states.size) await seedStates();
      return { ok: true, count: states.size };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'ha_connect_failed' };
    }
  }

  // Keep a live connection and notify on any state change. Returns a stop fn.
  function watch(cb) {
    onChange = cb; watching = true;
    startWatchConn();
    return () => {
      watching = false; onChange = null;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      bumpIdle();
    };
  }

  return { request, callService, runAction, listEntities, cameras, cameraSnapshot, snapshot, hasStates, isConnected, test, watch, close };
}

module.exports = {
  createHomeAssistant,
  haWsUrl,
  haHttpOrigin,
  isConfigured,
  isEntityId,
  isCameraEntity,
  compactEntity,
  actionToServiceCall,
  normalizeHomeAssistant,
  normalizeHaCamAngles,
  preserveHaToken,
  redactHaToken,
};
