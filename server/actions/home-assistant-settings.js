'use strict';
// Cleans the Home Assistant settings as they are saved: entities, cameras and their angles,
// dashboards, and the token, which is kept on a save without one and never sent back to the
// screen.

const { haWsUrl, haHttpOrigin } = require('./home-assistant-address.js');
const { normalizeAreaOrder, normalizeTileView } = require('../js/smart-home-order.js');
const { isEntityId, isCameraEntity } = require('./home-assistant-entity.js');

// The user's Home Assistant dashboards, for Settings → Smart Home → "Add as a
// tile". `lovelace` (the Overview) always comes first, since a token that may
// not list dashboards can still open it. A path that is not a plain HA slug is
// dropped: the client builds a URL from it.
const HA_DASHBOARD_PATH_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HA_DASHBOARDS_MAX = 50;
function normalizeDashboards(raw) {
  const out = [{ path: 'lovelace', title: '' }];
  const seen = new Set(['lovelace']);
  for (const d of Array.isArray(raw) ? raw : []) {
    const path = d && typeof d.url_path === 'string' ? d.url_path : '';
    if (!HA_DASHBOARD_PATH_RE.test(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, title: (typeof d.title === 'string' && d.title.trim() ? d.title.trim() : path).slice(0, 80) });
    if (out.length >= HA_DASHBOARDS_MAX) break;
  }
  return out;
}

// ---- settings normalization + token secrecy --------------------------------
// The `homeAssistant` settings sub-object: { url, token, entities }. url/entities
// are client-visible; the long-lived token is a SERVER-ONLY secret handled with
// the same preserve-on-save / redact-on-wire pattern as the remote-control creds.
const HA_MAX_ENTITIES = 100;
const HA_MAX_CAMERAS = 60;
const HA_MAX_ENERGY_ENTITIES = 24;
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
  // Power/energy entities the user picked for the Energy widget — a selection
  // INDEPENDENT of the Smart Home tile's `entities`, so the two surfaces never
  // fight over one list. OPT-IN like cameras (empty = PC-only Energy widget).
  const energyEntities = Array.isArray(src.energyEntities)
    ? src.energyEntities.filter(isEntityId).filter((v, i, a) => a.indexOf(v) === i).slice(0, HA_MAX_ENERGY_ENTITIES)
    : [];
  return {
    url: haWsUrl(url) ? url : '',                    // keep only a valid http(s) HA URL
    token: typeof src.token === 'string' ? src.token.slice(0, 400) : '',
    entities,
    cameras,
    energyEntities,
    camAngles: normalizeHaCamAngles(src.camAngles),
    // Smart Home tile: room order and how devices are shown (one rule with the
    // browser, js/smart-home-order.js). Empty order = rooms as Home Assistant lists them.
    areaOrder: normalizeAreaOrder(src.areaOrder),
    tileView: normalizeTileView(src.tileView),
  };
}

// True when two user-entered HA base URLs point at the same server: same scheme,
// host and port once normalised ("https://ha.me/" and "https://HA.me:443" match).
// The stored token belongs to the server it was typed for, so this is the test
// for "may the saved token be used with this URL". Two unusable URLs compare
// equal ('' === ''), which is harmless: no request is ever sent without a URL.
function haSameDestination(a, b) {
  return haHttpOrigin(a) === haHttpOrigin(b);
}

// Protect the persisted Home Assistant config against a client save. Two cases:
//   - payload has NO homeAssistant block (older/partial/programmatic client):
//     keep the whole persisted block (url + entities + token) so nothing is wiped.
//   - payload HAS the block (the normal client, which owns url/entities but never
//     receives the real token): carry the persisted token over when it's empty,
//     but ONLY while the URL still points at the same server. Otherwise a save
//     (or an imported backup) that only changed the URL would hand the long-lived
//     token to whatever host the new URL names; the user re-enters it instead.
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
  if (prevHa.token && !incoming.homeAssistant.token
      && haSameDestination(incoming.homeAssistant.url, prevHa.url)) {
    incoming.homeAssistant.token = prevHa.token;
  }
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
      energyEntities: Array.isArray(ha.energyEntities) ? ha.energyEntities : [],
      camAngles: (ha.camAngles && typeof ha.camAngles === 'object') ? ha.camAngles : {},
      areaOrder: Array.isArray(ha.areaOrder) ? ha.areaOrder : [],
      tileView: typeof ha.tileView === 'string' ? ha.tileView : 'auto',
      token: '',
      tokenSet: !!ha.token,
    },
  };
}

module.exports = {
  HA_DASHBOARD_PATH_RE, HA_DASHBOARDS_MAX, normalizeDashboards, HA_MAX_ENTITIES, HA_MAX_CAMERAS,
  HA_MAX_ENERGY_ENTITIES, HA_CAM_ROTATIONS, clampHaPan, normalizeHaCamAngles,
  normalizeHomeAssistant, haSameDestination, preserveHaToken, redactHaToken,
};
