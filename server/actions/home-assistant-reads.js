'use strict';
// What is read from Home Assistant: the entities with their area and device, the cameras and
// one frame of a camera, the cover of what a media player plays, the state the tiles show, and
// whether there is a connection.

const { haHttpOrigin, haHttpGetBuffer } = require('./home-assistant-address.js');
const {
  compactEntity, isCameraEntity, isMediaPlayerEntity,
} = require('./home-assistant-entity.js');

function makeReads({ getConfig, haLink, states, haMaps, connect, seedStates }) {
  // All entities as compact objects (for the Settings device picker). Ensures a
  // live connection + fresh cache first.
  async function listEntities() {
    if (!states.size || !haLink.ws) { await connect(); await seedStates(); }
    const out = [];
    for (const st of states.values()) { const c = compactEntity(st, (id) => haMaps.areaMap.get(id), (id) => haMaps.deviceMap.get(id)); if (c) out.push(c); }
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
    if (!states.size || !haLink.ws) {
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
        area: haMaps.areaMap.get(st.entity_id) || null,
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

  // What identifies a media player's current cover art: HA's entity_picture,
  // which carries a cache hash that changes with the artwork. '' = no artwork.
  // Kept in memory by the caller as a cache key only; it is never sent anywhere
  // (it can hold an access token).
  function artworkKey(entityId) {
    const st = isMediaPlayerEntity(entityId) ? states.get(String(entityId).trim()) : null;
    const pic = st && st.attributes && st.attributes.entity_picture;
    return typeof pic === 'string' ? pic : '';
  }

  // The cover art bytes (Buffer) through HA's REST media_player_proxy, which
  // fetches remote art server-side, so the URL is always the user's HA origin.
  // Same token rules as cameraSnapshot.
  async function mediaArtwork(entityId) {
    if (!isMediaPlayerEntity(entityId)) throw new Error('ha_bad_media_player');
    const cfg = (await Promise.resolve().then(getConfig)) || {};
    const origin = haHttpOrigin(cfg.baseUrl);
    const token = String(cfg.token || '').trim();
    if (!origin || !token) throw new Error('ha_not_configured');
    const url = origin + '/api/media_player_proxy/' + encodeURIComponent(String(entityId).trim());
    return haHttpGetBuffer(url, token);
  }

  // Compact snapshot for the given entity ids (tile/SSE). Missing ids are simply
  // absent. Called with the user's selection from settings.
  function snapshot(entityIds) {
    const ids = Array.isArray(entityIds) ? entityIds : [];
    const out = [];
    for (const id of ids) {
      const st = states.get(id);
      const c = st ? compactEntity(st, (x) => haMaps.areaMap.get(x), (x) => haMaps.deviceMap.get(x)) : null;
      if (c) out.push(c);
    }
    return out;
  }

  function hasStates() { return states.size > 0; }
  // Whether a live socket is currently open (not merely whether we have a cached
  // snapshot) — so a state read after an idle-close reports connected:false rather
  // than showing stale values as if live.
  function isConnected() { return !!haLink.ws; }

  return {
    listEntities, cameras, cameraSnapshot, artworkKey, mediaArtwork, snapshot, hasStates, isConnected,
  };
}

module.exports = { makeReads };
