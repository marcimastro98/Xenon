'use strict';
// Cleans the UniFi Protect settings as they are saved: the address of the console, the cameras
// and their layout and angles, the alerts, and the sign-in, which is kept on a save without one
// and never sent back to the screen.

const { URL } = require('node:url');

// Turn a user-entered host ("192.168.1.1", "https://udm.local", "udm.home:443")
// into a normalized origin ("https://host[:port]"), or '' if unusable. A bare
// host defaults to https (UniFi OS is TLS-only); a non-http scheme is rejected.
function unifiBaseUrl(host) {
  let v = String(host == null ? '' : host).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) {
    // already an http(s) URL — use as-is
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(v)) {
    // an explicit non-http scheme (file:, javascript:, ws:, ftp://…). The `(?!\d)`
    // excludes "host:port" — a port always starts with a digit — so a bare
    // "udm.local:8443" is NOT mistaken for a scheme. Reject: a UniFi console is
    // http(s) only, and this stops a bad scheme being coerced into a hostname.
    return '';
  } else {
    v = 'https://' + v;   // bare host or host:port → default to https (UniFi OS is TLS)
  }
  let u;
  try { u = new URL(v); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (!u.hostname) return '';
  return u.protocol + '//' + u.host;   // scheme + host(:port) only, no path/query
}

// UniFi Protect camera ids are hex-ish Mongo-style tokens. Validate strictly so an
// id can be safely interpolated into the snapshot path — no traversal, no query
// injection, no slashes.
function isCameraId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9]{4,64}$/.test(s);
}

const UNIFI_MAX_CAMERAS = 60;

// Display-layout options (client-visible, no secrets). Kept small + validated so a
// tampered save can never inject an arbitrary CSS value into the grid.
const UNIFI_MAX_COLUMNS = 6;                       // 0 = Auto (responsive auto-fit)
const UNIFI_FITS = Object.freeze(['cover', 'contain']);
const UNIFI_ASPECTS = Object.freeze(['16:9', '4:3', '1:1']);
const UNIFI_ROTATIONS = Object.freeze([0, 90, 180, 270]);
const UNIFI_MAX_ZOOM = 3;                          // 1× = no digital zoom
const UNIFI_DEFAULT_REFRESH_MS = 1500;

// Clamp a pan component to a -100..100 integer percentage of the available travel.
function clampUnifiPan(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(-100, Math.round(n))) : 0;
}

// Motion / smart-detection notification kinds the Cameras tile can surface.
const UNIFI_NOTIFY_KINDS = Object.freeze(['person', 'vehicle', 'package', 'animal', 'motion', 'ring']);

// Notification preferences for the Cameras tile — off by default. `types` is a map
// of kind→bool; when the block is absent entirely (an upgrade with no prior config)
// a sensible starter set is enabled so turning notifications on isn't silent.
function normalizeUnifiNotify(src) {
  const s = (src && typeof src === 'object') ? src : {};
  const hasTypes = s.types && typeof s.types === 'object';
  const st = hasTypes ? s.types : { person: true, vehicle: true, ring: true };
  const types = {};
  for (const k of UNIFI_NOTIFY_KINDS) types[k] = st[k] === true;
  const cd = Number(s.cooldownSec);
  return {
    enabled: s.enabled === true,
    types,
    cooldownSec: Number.isFinite(cd) ? Math.min(600, Math.max(5, Math.round(cd))) : 45,
  };
}

// Filter a list of camera ids exactly like the display selection: valid tokens
// only, de-duplicated, bounded. Reused for both `cameras` and the display `order`.
function normalizeCameraIds(value) {
  return Array.isArray(value)
    ? value.filter(isCameraId).filter((v, i, a) => a.indexOf(v) === i).slice(0, UNIFI_MAX_CAMERAS)
    : [];
}

// Per-camera view adjustment:
//   { [cameraId]: { rot: 0|90|180|270, flip: 0|1, zoom?: 1..3, panX?, panY? } }.
// Keys are validated as camera ids; a fully neutral entry (no rotation, no flip,
// no zoom) is dropped so the map stays lean. `zoom`/`panX`/`panY` add a digital
// zoom + pan; pan is a -100..100 percentage of the available travel and is only
// meaningful (and only kept) once zoomed in. This transforms the SHOWN snapshot
// only — no command is ever sent to the camera.
function normalizeUnifiAngles(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  let n = 0;
  for (const id of Object.keys(value)) {
    if (n >= UNIFI_MAX_CAMERAS) break;
    if (!isCameraId(id)) continue;
    const a = value[id];
    if (!a || typeof a !== 'object') continue;
    const rot = UNIFI_ROTATIONS.includes(a.rot) ? a.rot : 0;
    const flip = a.flip === 1 || a.flip === true ? 1 : 0;
    const z = Number(a.zoom);
    const zoom = Number.isFinite(z) ? Math.min(UNIFI_MAX_ZOOM, Math.max(1, Math.round(z * 100) / 100)) : 1;
    if (!rot && !flip && zoom <= 1) continue;     // fully neutral → omit
    const entry = { rot, flip };
    if (zoom > 1) {
      entry.zoom = zoom;
      const panX = clampUnifiPan(a.panX);
      const panY = clampUnifiPan(a.panY);
      if (panX) entry.panX = panX;                // pan only bites when zoomed
      if (panY) entry.panY = panY;
    }
    out[id] = entry;
    n++;
  }
  return out;
}

// The user's layout preferences for the Cameras tile. All optional; each falls
// back to the current default so an older/partial save keeps working unchanged.
function normalizeUnifiLayout(src) {
  const n = Number(src.columns);
  const columns = Number.isFinite(n) ? Math.min(UNIFI_MAX_COLUMNS, Math.max(0, Math.round(n))) : 0;
  const ms = Number(src.refreshMs);
  return {
    columns,
    fit: UNIFI_FITS.includes(src.fit) ? src.fit : 'cover',
    aspect: UNIFI_ASPECTS.includes(src.aspect) ? src.aspect : '16:9',
    order: normalizeCameraIds(src.order),
    refreshMs: Number.isFinite(ms) ? Math.min(60000, Math.max(500, Math.round(ms))) : UNIFI_DEFAULT_REFRESH_MS,
    angles: normalizeUnifiAngles(src.angles),
    notify: normalizeUnifiNotify(src.notify),
  };
}

// The `unifi` settings sub-object: { host, username, cameras, password } plus the
// display-layout fields { columns, fit, aspect, order }. host / username / cameras
// (the user's selection to display) and the layout fields are client-visible; the
// console password is a SERVER-ONLY secret handled with the same preserve/redact
// pattern as the Home Assistant token.
function normalizeUnifi(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const host = String(src.host == null ? '' : src.host).trim().slice(0, 200);
  return {
    host: unifiBaseUrl(host) ? host : '',              // keep only a usable host
    username: String(src.username == null ? '' : src.username).trim().slice(0, 120),
    password: typeof src.password === 'string' ? src.password.slice(0, 200) : '',
    cameras: normalizeCameraIds(src.cameras),
    ...normalizeUnifiLayout(src),
  };
}

// True when two { host, username } pairs name the same console login: same
// normalised origin (scheme + host + port) and the same username. The saved
// password belongs to that login, so this decides whether it may be reused.
function unifiSameDestination(a, b) {
  const x = (a && typeof a === 'object') ? a : {};
  const y = (b && typeof b === 'object') ? b : {};
  return unifiBaseUrl(x.host) === unifiBaseUrl(y.host)
    && String(x.username == null ? '' : x.username).trim() === String(y.username == null ? '' : y.username).trim();
}

// Protect the persisted UniFi config against a client save. Two cases, mirroring
// preserveHaToken:
//   - payload has NO unifi block (older/partial/programmatic client): keep the
//     whole persisted block so nothing is wiped.
//   - payload HAS the block (the normal client, which owns host/username/cameras
//     but never receives the real password): carry the persisted password over
//     when the incoming one is empty AND host + username are unchanged. A changed
//     host would otherwise receive the saved password on the next login.
function preserveUnifiCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const prevU = (prev && typeof prev === 'object' && prev.unifi) || {};
  const hasBlock = incoming.unifi && typeof incoming.unifi === 'object';
  if (!hasBlock) {
    if (prevU.host || prevU.password || prevU.username || (Array.isArray(prevU.cameras) && prevU.cameras.length)) {
      incoming.unifi = { ...prevU };
    }
    return incoming;
  }
  if (prevU.password && !incoming.unifi.password && unifiSameDestination(incoming.unifi, prevU)) {
    incoming.unifi.password = prevU.password;
  }
  return incoming;
}

// Blank the password before settings reach the browser; expose only a
// `passwordSet` boolean so the UI can show a "saved" placeholder. Shallow copy.
function redactUnifiCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const u = settings.unifi;
  if (!u || typeof u !== 'object') return settings;
  return {
    ...settings,
    unifi: {
      host: u.host || '',
      username: u.username || '',
      cameras: Array.isArray(u.cameras) ? u.cameras : [],
      password: '',
      passwordSet: !!u.password,
      // Layout prefs are not secrets — carry them to the browser as-is (already
      // normalized on save). Missing them here would hide the user's own choices.
      ...normalizeUnifiLayout(u),
    },
  };
}

function isConfigured(cfg) {
  return !!(cfg && unifiBaseUrl(cfg.host) && String(cfg.username || '').trim() && String(cfg.password || '').trim());
}

// Project a raw Protect camera object down to the compact shape the tile needs.
function compactCamera(c) {
  if (!c || !c.id || !isCameraId(String(c.id))) return null;
  const state = c.state != null ? String(c.state) : '';
  return {
    id: String(c.id),
    name: String(c.name || c.type || 'Camera').slice(0, 80),
    // Protect reports state as "CONNECTED"/"DISCONNECTED"; fall back to isConnected.
    connected: state ? state.toUpperCase() === 'CONNECTED' : (c.isConnected !== false),
  };
}

module.exports = {
  unifiBaseUrl, isCameraId, UNIFI_MAX_CAMERAS, UNIFI_MAX_COLUMNS, UNIFI_FITS, UNIFI_ASPECTS,
  UNIFI_ROTATIONS, UNIFI_MAX_ZOOM, UNIFI_DEFAULT_REFRESH_MS, clampUnifiPan, UNIFI_NOTIFY_KINDS,
  normalizeUnifiNotify, normalizeCameraIds, normalizeUnifiAngles, normalizeUnifiLayout,
  normalizeUnifi, unifiSameDestination, preserveUnifiCreds, redactUnifiCreds, isConfigured,
  compactCamera,
};
